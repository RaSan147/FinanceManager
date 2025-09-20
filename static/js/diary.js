(() => {
  if (window.__diaryModuleLoaded) return;
  window.__diaryModuleLoaded = true;
  const modalEl = document.getElementById('diaryModal');
  if (!modalEl) return;
  const form = modalEl.querySelector('[data-diary-form]');
  const titleEl = modalEl.querySelector('[data-diary-modal-title]');
  const idInput = form.querySelector('[data-diary-id]');
  const submitBtn = form.querySelector('[data-diary-submit-btn]');
  const contentInput = form.querySelector('[data-diary-content-input]');
  const metaEl = modalEl.querySelector('[data-diary-meta]');
  let bsModal = window.bootstrap ? bootstrap.Modal.getOrCreateInstance(modalEl) : null;

  const listEl = document.getElementById('diaryList');
  const tmpl = document.getElementById('diaryItemTemplate');
  const btnNew = document.getElementById('btnNewDiaryTop');
  const filterToggle = document.getElementById('btnDiaryFilterToggle');
  const categorySel = document.getElementById('diaryFilterCategory');
  const searchEl = document.getElementById('diarySearch');
  const btnApplyFilters = document.getElementById('btnDiaryApplyFilters');
  const btnClearFilters = document.getElementById('btnDiaryClearFilters');
  const activeFiltersBar = document.getElementById('diaryActiveFiltersBar');
  if (!listEl || !tmpl) return;

  const state = {
    q: '',
    category: '',
    sort: 'created_desc',
    items: []
  };

  // Robust delegated click (backup in case per-item binding misses)
  listEl.addEventListener('click', e => {
    const item = e.target.closest('.diary-item');
    if (!item) return;
    if (e.target.closest('.btn-delete')) return;
    const id = item.dataset.id;
    if (id) openDetailModal(id);
  });

  async function apiList(forceFresh = false) {
    let url = `/api/diary?per_page=500` + (forceFresh ? `&__ts=${Date.now()}` : '');
    if (state.q) url += `&q=${encodeURIComponent(state.q)}`;
    if (state.category) url += `&category=${encodeURIComponent(state.category)}`;
    try {
      const data = await App.utils.fetchJSONUnified(url);
      state.items = data.items || [];
      renderList();
    } catch (e) {
      console.warn('Diary list fetch failed', e);
    }
  }

  function renderList() {
    listEl.innerHTML = '';
    if (!state.items.length) {
      listEl.innerHTML = '<div class="text-muted small fst-italic">No entries.</div>';
      updateActiveFilterChips();
      updateFilterBtnActive();
      return;
    }
    for (const it of state.items) {
      const node = tmpl.content.firstElementChild.cloneNode(true);
      hydrate(node, it);
      listEl.appendChild(node);
    }
    updateActiveFilterChips();
    updateFilterBtnActive();
  }

  function hydrate(node, it) {
    node.dataset.id = it._id;
    node.querySelector('.diary-title').textContent = it.title || '(Untitled)';
    const cat = node.querySelector('.diary-category');
    if (it.category) {
      cat.textContent = it.category;
      cat.classList.remove('d-none');
    }
    const cEl = node.querySelector('.diary-content-trunc');
    if (cEl) {
      cEl.textContent = truncate(it.content || '');
    }
    bindItemHandlers(node, it);
  }

  function truncate(txt) {
    if (!txt) return '';
    const lim = 300;
    return txt.length > lim ? txt.slice(0, lim) + "…" : txt;
  }

  function bindItemHandlers(node, data) {
    const delBtn = node.querySelector('.btn-delete');
    delBtn && delBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent triggering the delegated click handler
      deleteEntry(data._id);
    });
    // Removed duplicate click handler - using delegated click handler instead
  }

  async function deleteEntry(id) {
    if (!confirm('Delete this entry?')) return;
    try {
      await App.utils.fetchJSONUnified(`/api/diary/${id}`, {
        method: 'DELETE'
      });
      window.flash && window.flash('Deleted', 'info');
      apiList(true);
    } catch (e) {
      window.flash && window.flash('Delete failed', 'danger');
    }
  }

  function closeOtherModals() {
    document.querySelectorAll('.modal.show').forEach(m => {
      if (m !== modalEl && m !== detailModalEl) {
        // Remove focus before hiding to prevent aria-hidden accessibility warnings
        const focusedElement = m.querySelector(':focus');
        if (focusedElement) {
          focusedElement.blur();
        }

        const inst = bootstrap.Modal.getInstance(m);
        inst && inst.hide();
      }
    });
  }

  function openCreateModal() {
    form.reset();
    idInput.value = '';
    titleEl.textContent = 'New Entry';
    submitBtn.textContent = 'Save';
    closeOtherModals();
    if (bsModal) bsModal.show();
    else modalEl.style.display = 'block';
    setTimeout(() => {
      try {
        form.querySelector('[name="title"]').focus();
      } catch (_) {}
    }, 30);
    detailModal?.hide();
  }

  function openEditModal(data) {
    form.reset();
    idInput.value = data._id;
    form.title.value = data.title || '';
    form.category.value = data.category || '';
    form.content.value = data.content || '';
    titleEl.textContent = 'Edit Entry';
    submitBtn.textContent = 'Update';
    if (bsModal) bsModal.show();
    else modalEl.style.display = 'block';
    detailModal?.hide();
  }

  async function persist(fd) {
    const id = idInput.value.trim();
    const payload = Object.fromEntries(fd.entries());
    if (payload.id) delete payload.id;
    if (!payload.content && !payload.title) return;
    const url = id ? `/api/diary/${id}` : '/api/diary';
    const method = id ? 'PATCH' : 'POST';
    if (id) {
      ['title', 'content', 'category'].forEach(k => {
        if (k in payload && payload[k] === '') payload[k] = null;
      });
    }
    try {
      await App.utils.fetchJSONUnified(url, {
        method,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      window.flash && window.flash('Entry saved', 'success');
      apiList();
    } catch (e) {
      console.error('Save failed', e);
      window.flash && window.flash('Failed to save', 'danger');
    }
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    const fd = new FormData(form);
    persist(fd);
    if (bsModal) bsModal.hide();
  });
  btnNew && btnNew.addEventListener('click', openCreateModal);

  function updateActiveFilterChips() {
    const chips = [];
    if (state.category) chips.push(`<span class='badge text-bg-info text-dark'>Cat: ${state.category}</span>`);
    if (state.q) chips.push(`<span class='badge text-bg-dark'>Q: ${state.q}</span>`);
    activeFiltersBar.innerHTML = chips.join(' ');
    activeFiltersBar.style.display = chips.length ? 'flex' : 'none';
  }

  function updateFilterBtnActive() {
    const active = !!(state.q || state.category);
    if (filterToggle) {
      filterToggle.classList.toggle('btn-primary', active);
      filterToggle.classList.toggle('btn-outline-secondary', !active);
    }
  }

  filterToggle && filterToggle.addEventListener('click', () => {
    const box = document.getElementById('diaryInlineFilters');
    box.classList.toggle('d-none');
  });
  btnApplyFilters && btnApplyFilters.addEventListener('click', () => {
    state.q = searchEl.value.trim();
    state.category = categorySel.value || '';
    apiList();
  });
  btnClearFilters && btnClearFilters.addEventListener('click', () => {
    searchEl.value = '';
    categorySel.value = '';
    state.q = '';
    state.category = '';
    apiList();
  });

  // Detail modal logic
  const detailModalEl = document.getElementById('diaryDetailModal');
  // Ensure modals are direct children of body for consistent Bootstrap stacking
  [modalEl, detailModalEl].forEach(m => {
    if (m && m.parentElement !== document.body) {
      document.body.appendChild(m);
    }
  });
  let detailModal = detailModalEl && window.bootstrap ? bootstrap.Modal.getOrCreateInstance(detailModalEl) : null;

  async function openDetailModal(id) {
    try {
      const data = await App.utils.fetchJSONUnified(`/api/diary/${id}/detail`, {
        dedupe: true
      });

      // Safety check for renderDetail function
      try {
        renderDetail(data);
      } catch (renderError) {
        console.error('Error rendering diary detail:', renderError);
        window.flash && window.flash('Error displaying diary entry', 'danger');
        return;
      }

      closeOtherModals();
      if (detailModal) {
        detailModal.show();
      } else {
        console.error('detailModal is not available');
        window.flash && window.flash('Modal not available', 'danger');
      }
    } catch (e) {
      console.error('Failed to load diary detail:', e);
      window.flash && window.flash(`Failed to load: ${e.message || 'Unknown error'}`, 'danger');
    }
  }

  function safeFormatDate(dateValue) {
    if (!dateValue) return 'Unknown date';

    try {
      const date = new Date(dateValue);
      if (isNaN(date.getTime())) {
        return 'Invalid date';
      }
      return date.toISOString().slice(0, 16).replace('T', ' ');
    } catch (e) {
      console.warn('Date formatting error:', e, dateValue);
      return 'Invalid date';
    }
  }

  // Cache markdown preferences
  let markdownPreference = null;

  function getMarkdownPreference() {
    if (markdownPreference === null) {
      markdownPreference = localStorage.getItem('diary-markdown-enabled') === 'true';
    }
    return markdownPreference;
  }

  // Pre-compile regex patterns for better performance
  const markdownPatterns = {
    blockquote: /^&gt;\s+(.+)$/gm,
    headers: /^#{1,6}\s+(.+)$/gm,
    // FIX: Use more specific regex for bold to avoid mid-word matches
    bold: /(?<!\w)(\*\*|__)(?=\S)(.+?[*_]*)(?<=\S)\1(?!\w)/g,
    // FIX: Use more specific regex for italic to avoid mid-word matches
    italic: /(?<!\w)(\*|_)(?=\S)(.+?)(?<=\S)\1(?!\w)/g,
    codeBlock: /```([\s\S]*?)```/gm,
    inlineCode: /`([^`]+)`/g,
    image: /!\[([^\]]*)\]\(((https?:\/\/[^\s)]+)(?:\s+"([^"]*)")?)\)/g,
    link: /\[([^\]]+)\]\(((https?:\/\/[^\s)]+)(?:\s+"([^"]*)")?)\)/g,
    hr: /^[-*_]{3,}$/gm,
    unorderedList: /^(\s*)[-*+]\s+(.+)$/gm,
    orderedList: /^(\s*)\d+\.\s+(.+)$/gm
  };

  function escapeHtml(text, preserveUrls = false) {
    if (!text) return '';

    const div = document.createElement('div');
    div.textContent = text;
    let result = div.innerHTML;

    if (preserveUrls) {
      // Preserve URL encoding
      result = result.replace(/%20/g, ' ');
    }

    return result;
  }

  function renderInlineContent(raw, id, markdownEnabled = false) {
    if (!raw) return '';

    // Mock ImageUploader for demonstration
    const ikThumb = (url) => url;

    const group = id ? `diary-inline-${id}` : 'diary-inline';

    // Process images first (both markdown and plain text modes)
    const processImages = (text) => {
      return text.replace(
        /!\[([^\]]*)\]\(((https?:\/\/[^\s)]+)(?:\s+"([^"]*)")?)\)/g,
        (match, altText, fullUrl, cleanUrl, title) => {
          const t = ikThumb(cleanUrl);
          const titleAttr = title ? ` title="${escapeHtml(title, false)}"` : '';
          return `<img src='${t}' data-viewer-thumb data-viewer-group='${group}' data-viewer-src='${cleanUrl}' style='max-width:140px;max-height:140px;cursor:pointer;object-fit:cover;margin:4px;border:1px solid var(--border-color);border-radius:4px;' alt='${escapeHtml(altText, false)}'${titleAttr}/>`;
        }
      );
    };

    if (markdownEnabled) {
      let processed = escapeHtml(raw, true);

      // Process images first to avoid markdown processing within URLs
      processed = processImages(processed);

      // Process code blocks first to avoid processing inside them
      const codeBlocks = [];
      processed = processed.replace(markdownPatterns.codeBlock, (match, code) => {
        codeBlocks.push(code);
        return `:::CODEBLOCK${codeBlocks.length - 1}:::`;
      });

      // Process lists
      processed = processLists(processed);

      // Then process other markdown elements
      console.log('Processed after lists:', processed);
      processed = processed
        .replace(markdownPatterns.blockquote, '<blockquote>$1</blockquote>')
        .replace(markdownPatterns.headers, (match, text) => {
          const level = match.match(/^#+/)[0].length;
          return `<h${Math.min(level + 2, 6)}>${text}</h${Math.min(level + 2, 6)}>`;
        })
        .replace(markdownPatterns.hr, '<hr/>')
        .replace(markdownPatterns.bold, '<strong>$2</strong>')
        .replace(markdownPatterns.italic, '<em>$2</em>')
        .replace(markdownPatterns.inlineCode, '<code>$1</code>')
        .replace(
          markdownPatterns.link,
          (match, text, fullUrl, cleanUrl, title) => {
            const titleAttr = title ? ` title="${escapeHtml(title, false)}"` : '';
            return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
          }
        );

      // Restore code blocks
      processed = processed.replace(/:::CODEBLOCK(\d+):::/g, (match, index) => {
        return `<pre><code>${escapeHtml(codeBlocks[parseInt(index)], false)}</code></pre>`;
      });
      
      // FIX: Clean up extra newlines around block elements to prevent double spacing
      const blockTags = ['h3', 'h4', 'h5', 'h6', 'hr', 'blockquote', 'pre', 'ul', 'ol'];
      blockTags.forEach(tag => {
          const reBefore = new RegExp(`\\n+\\s*(<${tag}[^>]*>)`, 'g');
          processed = processed.replace(reBefore, '$1');
          const reAfter = new RegExp(`(<\\/${tag}>)\\s*\\n+`, 'g');
          processed = processed.replace(reAfter, '$1');
      });

      return formatTextWithWhitespace(processed);
    } else {
      // For plain text mode
      const withPreservedImgs = escapeHtml(raw, true);
      const withImgs = processImages(withPreservedImgs);
      return formatTextWithWhitespace(withImgs);
    }
  }

  function processLists(text) {
    // This is a robust, stack-based list parser.
    const listBlockRegex = /((?:^\s*[-*+]\s+.*\n?)|(?:^\s*\d+\.\s+.*\n?))+/gm;

    return text.replace(listBlockRegex, (listBlock) => {
        const lines = listBlock.trim().split('\n');
        let html = '';
        const stack = []; // To track open list types and levels, e.g., { type: 'ul', level: 0 }
        const itemRegex = /^(\s*)([-*+]|\d+\.)\s+(.*)/;

        for (const line of lines) {
            const match = line.match(itemRegex);
            if (!match) continue;

            const indent = match[1].length;
            const level = Math.floor(indent / 4); // Assuming 4 spaces per indentation level
            const type = /^\s*\d+\.\s+/.test(line) ? 'ol' : 'ul';
            const content = match[3];

            // Close deeper levels if we are moving up the tree
            while (stack.length > 0 && level < stack.length) {
                html += `</li></${stack.pop().type}>\n`;
            }

            // Close the previous list item if at the same level
            if (stack.length > 0 && level < stack.length) {
                html += `</li>\n`;
            }

            // Open new list(s) if we are moving deeper
            while (level >= stack.length) {
                // Check if list type has changed at the same level
                if (level < stack.length && stack[level].type !== type) {
                    html += `</${stack.pop().type}>\n`; // Close previous type
                }
                html += `<${type}>`;
                stack.push({ type });
            }
            
            // Add the list item
            html += `<li>${content}`;
        }

        // At the end, close all remaining open tags
        while (stack.length > 0) {
            html += `</li></${stack.pop().type}>\n`;
        }

        return html;
    });
  }

  function formatTextWithWhitespace(text) {
    // Preserve multiple spaces and convert newlines properly
    return text
      .split('\n')
      .map(line => {
        // Skip processing if the line is a list item
        if (line.startsWith('<li') || line.startsWith('</ul>') || line.startsWith('</ol>')) {
          return line;
        }

        // Convert multiple spaces to non-breaking spaces
        let processedLine = line;

        // Handle tabs (4 spaces each)
        processedLine = processedLine.replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');

        // Convert leading spaces to non-breaking spaces
        const leadingSpacesMatch = processedLine.match(/^(\s+)/);
        if (leadingSpacesMatch) {
          const leadingSpaces = leadingSpacesMatch[1];
          const preservedSpaces = leadingSpaces.replace(/ /g, '&nbsp;');
          processedLine = preservedSpaces + processedLine.slice(leadingSpaces.length);
        }

        // Convert multiple consecutive spaces within line
        processedLine = processedLine.replace(/ {2,}/g, spaces =>
          spaces.replace(/ /g, '&nbsp;')
        );

        return processedLine;
      })
      .join('<br/>\n');
  }


  function renderDetail(data) {
    if (!detailModalEl) return;
    const item = data.item || {};
    const root = detailModalEl.querySelector('[data-diary-detail-root]');
    if (!root) return;

    // Set up title and category
    const titleEl = root.querySelector('[data-diary-detail-title]');
    if (titleEl) titleEl.textContent = item.title || '(Untitled)';
    const catEl = root.querySelector('[data-diary-detail-category]');
    if (catEl) {
      if (item.category) {
        catEl.textContent = item.category;
        catEl.classList.remove('d-none');
      } else catEl.classList.add('d-none');
    }

    // Set up markdown toggle
    const markdownToggle = root.querySelector('[data-diary-markdown-toggle]');
    const contentEl = root.querySelector('[data-diary-detail-content]');

    function updateContent() {
      const markdownEnabled = markdownToggle?.checked || false;
      if (contentEl) {
        // Use class name that matches CSS file selector `.markdown-content`
        contentEl.classList.toggle('markdown-content', markdownEnabled);
        contentEl.innerHTML = renderInlineContent(item.content || '', item._id, markdownEnabled);
      }
      // Save preference
      localStorage.setItem('diary-markdown-enabled', markdownEnabled);
    }

    // Load markdown preference
    if (markdownToggle) {
      markdownToggle.checked = getMarkdownPreference();
      markdownToggle.addEventListener('change', updateContent);
    }

    // Initial content render
    updateContent();
    const commentsWrap = root.querySelector('[data-diary-comments]');
    if (commentsWrap) {
      const comments = data.comments || [];
      if (!comments.length) {
        commentsWrap.innerHTML = '<div class="text-muted">No comments</div>';
      } else {
        const ikThumb = (url) => (window.ImageUploader && ImageUploader.thumbTransform) ?
          ImageUploader.thumbTransform(url, 320, 320, false) :
          url;
        commentsWrap.innerHTML = comments.map(c => {
          const images = (c.images || []).map((u, i) => {
            const t = ikThumb(u);
            return `<div class='mt-2'><img src='${t}' data-viewer-thumb data-viewer-group='diary-comment-${item._id}' data-viewer-src='${u}' alt='comment image ${i + 1}' style='max-width:140px;max-height:140px;cursor:pointer;border:1px solid var(--border-color);border-radius:4px;object-fit:cover;'/></div>`
          }).join('');
          // Use shared comment formatter to preserve whitespace and formatting
          const formattedText = window.CommentFormatter ?
            window.CommentFormatter.formatText(c.body) :
            escapeHtml(c.body).replace(/\n/g, '<br/>'); // fallback
          const timestamp = safeFormatDate(c.created_at["$date"]);
          return `<div class='diary-comment'><div class='body'><div class='content'>${formattedText}</div>${images}<div class='meta d-flex align-items-center'><div class='datetime text-muted small'>${timestamp}</div><div class='ms-auto'><button class='btn btn-sm btn-outline-danger' data-comment-del='${c._id}'><i class='bi bi-trash'></i></button></div></div></div></div>`;
        }).join('');
        commentsWrap.querySelectorAll('[data-comment-del]').forEach(btn => btn.addEventListener('click', async () => {
          const cid = btn.getAttribute('data-comment-del');
          try {
            await App.utils.fetchJSONUnified(`/api/diary-comments/${cid}`, {
              method: 'DELETE'
            });
            openDetailModal(item._id);
          } catch (_) {
            window.flash && window.flash('Delete failed', 'danger');
          }
        }));
      }
    }
    const limitEl = root.querySelector('[data-diary-comment-limit]');
    if (limitEl) limitEl.textContent = `${(data.comment_max || 4000)} chars max`;
    const formC = root.querySelector('[data-diary-comment-form]');
    if (formC) formC.dataset.diaryId = item._id;
    // populate edit form
    const editForm = root.querySelector('[data-diary-detail-edit-form]');
    if (editForm) {
      editForm.querySelector('[data-diary-detail-edit-title]').value = item.title || '';
      editForm.querySelector('[data-diary-detail-edit-category]').value = item.category || '';
      editForm.querySelector('[data-diary-detail-edit-content]').value = item.content || '';
      editForm.dataset.diaryId = item._id || '';
    }
    const editBtn = root.querySelector('[data-diary-detail-edit-btn]');
    const saveBtn = root.querySelector('[data-diary-detail-save-btn]');
    const cancelBtn = root.querySelector('[data-diary-detail-cancel-btn]');
    if (editBtn && saveBtn && cancelBtn && editForm) {
      if (editForm.classList.contains('d-none')) {
        editBtn.classList.remove('d-none');
        saveBtn.classList.add('d-none');
        cancelBtn.classList.add('d-none');
      }
    }
  }

  if (detailModalEl) {
    const root = detailModalEl.querySelector('[data-diary-detail-root]');
    const formC = root.querySelector('[data-diary-comment-form]');
    if (formC) {
      const diaryDrafts = {};
      // Lightweight image attach logic for comments (paste or button)
      const trigger = formC.querySelector('[data-diary-comment-image-trigger]');
      const fileInput = formC.querySelector('[data-diary-comment-image]');
      const clearBtn = formC.querySelector('[data-diary-comment-images-clear]');
      const previewWrap = formC.querySelector('[data-diary-comment-images-preview]');
      let images = [];

      function renderPreviews() {
        if (!previewWrap) return;
        if (!images.length) {
          previewWrap.innerHTML = '';
          clearBtn?.classList.add('d-none');
          return;
        }
        previewWrap.innerHTML = images.map((u, i) => `<div class='position-relative' style='width:90px;height:90px;border:1px solid var(--border-color);border-radius:4px;overflow:hidden;'>\n<img src='${u}' style='object-fit:cover;width:100%;height:100%;'/>\n<button type='button' class='btn btn-sm btn-danger position-absolute top-0 end-0 py-0 px-1' data-remove='${i}'><i class='bi bi-x'></i></button></div>`).join('');
        clearBtn?.classList.remove('d-none');
        previewWrap.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => {
          const idx = parseInt(b.getAttribute('data-remove'), 10);
          if (!isNaN(idx)) {
            images.splice(idx, 1);
            renderPreviews();
          }
        }));
      }
      async function uploadDataUrl(dataUrl, label) {
        try {
          const res = await App.utils.fetchJSONUnified('/api/diary-images', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              image: dataUrl
            })
          });
          images.push(res.url);
          renderPreviews();
          window.flash && window.flash(label + ' image ready', 'info');
        } catch (_) {
          window.flash && window.flash(label + ' upload failed', 'danger');
        }
      }

      function handleFiles(fileList, label) {
        Array.from(fileList || []).forEach(f => {
          if (!f.type.startsWith('image/')) return;
          if (f.size > 16 * 1024 * 1024) {
            window.flash && window.flash('Image too large', 'warning');
            return;
          }
          const r = new FileReader();
          r.onload = () => uploadDataUrl(r.result, label);
          r.readAsDataURL(f);
        });
      }
      trigger && trigger.addEventListener('click', () => fileInput && fileInput.click());
      clearBtn && clearBtn.addEventListener('click', () => {
        images = [];
        renderPreviews();
      });
      fileInput && fileInput.addEventListener('change', () => {
        handleFiles(fileInput.files, 'Selected');
        fileInput.value = '';
      });
      document.addEventListener('paste', e => {
        if (!detailModalEl.classList.contains('show')) return;
        const active = document.activeElement;
        if (!formC.contains(active)) return;
        const items = e.clipboardData?.items || [];
        const files = [];
        for (const it of items) {
          if (it.type?.startsWith('image/')) {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        }
        if (files.length) {
          // if (!confirm('Paste image(s) into comment?')) return;
          handleFiles(files, 'Pasted');
        }
      });
      // Restore draft on modal show
      detailModalEl.addEventListener('show.bs.modal', () => {
        const did = formC.dataset.diaryId;
        if (!did) return;
        const d = diaryDrafts[did];
        if (d) {
          formC.querySelector('[name="body"]').value = d.body || '';
          images = Array.from(d.images || []);
          renderPreviews();
        }
      });
      // Save draft on input
      formC.addEventListener('input', () => {
        const did = formC.dataset.diaryId;
        if (!did) return;
        diaryDrafts[did] = diaryDrafts[did] || {};
        diaryDrafts[did].body = formC.querySelector('[name="body"]').value;
        diaryDrafts[did].images = [...images];
      });
      // Observe dataset change (diaryId switching)
      const obs = new MutationObserver(() => {
        const did = formC.dataset.diaryId;
        if (!did) return;
        const d = diaryDrafts[did];
        formC.querySelector('[name="body"]').value = d?.body || '';
        images = Array.from(d?.images || []);
        renderPreviews();
      });
      obs.observe(formC, {
        attributes: true,
        attributeFilter: ['data-diary-id']
      });
      formC.addEventListener('submit', async e => {
        e.preventDefault();
        const diaryId = formC.dataset.diaryId;
        if (!diaryId) return;
        const fd = new FormData(formC);
        const body = fd.get('body')?.toString().trim();
        if (!body && !images.length) return;
        try {
          await App.utils.fetchJSONUnified(`/api/diary/${diaryId}/comments`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              body,
              images
            })
          });
          formC.reset();
          images = [];
          renderPreviews();
          delete diaryDrafts[diaryId];
          openDetailModal(diaryId);
        } catch (_) {}
      });
    }
    const editBtn = root.querySelector('[data-diary-detail-edit-btn]');
    const saveBtn = root.querySelector('[data-diary-detail-save-btn]');
    const cancelBtn = root.querySelector('[data-diary-detail-cancel-btn]');
    const editForm = root.querySelector('[data-diary-detail-edit-form]');

    // Bind inline image upload logic for the edit form (detail modal) once
    if (editForm && !editForm._inlineImgBound) {
      editForm._inlineImgBound = true;
      const editContent = editForm.querySelector('[data-diary-detail-edit-content]');
      const editFileInput = editForm.querySelector('[data-diary-edit-content-image]');
      const editTrigger = editForm.querySelector('[data-diary-edit-content-image-trigger]');
      editTrigger && editTrigger.addEventListener('click', () => editFileInput && editFileInput.click());

      function insertUploadingPlaceholder() {
        if (!editContent) return null;
        const id = 'up_' + Math.random().toString(36).slice(2, 9);
        const placeholder = `\n![uploading-${id}]()`;
        const start = editContent.selectionStart || 0;
        const end = editContent.selectionEnd || 0;
        const orig = editContent.value;
        editContent.value = orig.slice(0, start) + placeholder + orig.slice(end);
        const cursor = start + placeholder.length;
        editContent.selectionStart = editContent.selectionEnd = cursor;
        return id;
      }

      async function uploadAndReplace(file, idTag) {
        if (!file) return;
        if (!file.type.startsWith('image/')) return;
        if (file.size > 16 * 1024 * 1024) {
          window.flash && window.flash('Image too large', 'warning');
          return;
        }
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const res = await App.utils.fetchJSONUnified('/api/diary-images', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                image: reader.result
              })
            });
            // Replace specific placeholder
            editContent.value = editContent.value.replace(`![uploading-${idTag}]()`, `![img](${res.url})`);
          } catch (_) {
            editContent.value = editContent.value.replace(`![uploading-${idTag}]()`, '(image failed)');
          }
        };
        reader.readAsDataURL(file);
      }

      function handleFiles(files, label) {
        if (!files || !files.length) return;
        for (const f of files) {
          // if (!confirm(`Insert ${label} image?`)) return; // one confirm per action batch
          const id = insertUploadingPlaceholder();
          uploadAndReplace(f, id);
        }
      }

      editFileInput && editFileInput.addEventListener('change', () => {
        handleFiles(Array.from(editFileInput.files || []), 'selected');
        editFileInput.value = '';
      });

      editContent && editContent.addEventListener('paste', e => {
        const items = e.clipboardData?.items || [];
        const files = [];
        for (const it of items) {
          if (it.type?.startsWith('image/')) {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        }
        if (files.length) {
          e.preventDefault();
          handleFiles(files, 'pasted');
        }
      });

      editContent && editContent.addEventListener('dragover', e => e.preventDefault());
      editContent && editContent.addEventListener('drop', e => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer?.files || []);
        handleFiles(files, 'dropped');
      });
    }

    function switchToEdit() {
      if (!editForm) return;
      editForm.classList.remove('d-none');
      root.querySelector('[data-diary-detail-content]')?.classList.add('d-none');
      editBtn.classList.add('d-none');
      saveBtn.classList.remove('d-none');
      cancelBtn.classList.remove('d-none');
    }

    function switchToView() {
      if (!editForm) return;
      editForm.classList.add('d-none');
      root.querySelector('[data-diary-detail-content]')?.classList.remove('d-none');
      editBtn.classList.remove('d-none');
      saveBtn.classList.add('d-none');
      cancelBtn.classList.add('d-none');
    }
    editBtn && editBtn.addEventListener('click', e => {
      e.preventDefault();
      switchToEdit();
    });
    cancelBtn && cancelBtn.addEventListener('click', e => {
      e.preventDefault();
      switchToView();
    });
    saveBtn && saveBtn.addEventListener('click', async e => {
      e.preventDefault();
      if (!editForm) return;
      const diaryId = editForm.dataset.diaryId;
      if (!diaryId) return;
      const patch = {
        title: editForm.querySelector('[data-diary-detail-edit-title]').value,
        category: editForm.querySelector('[data-diary-detail-edit-category]').value,
        content: editForm.querySelector('[data-diary-detail-edit-content]').value
      };
      if (patch.title === '') patch.title = null;
      if (patch.category === '') patch.category = null;
      if (patch.content === '') patch.content = null;
      try {
        await App.utils.fetchJSONUnified(`/api/diary/${diaryId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(patch)
        });
        window.flash && window.flash('Updated', 'success');
        switchToView();
        openDetailModal(diaryId);
        apiList();
      } catch (_) {
        window.flash && window.flash('Update failed', 'danger');
      }
    });
  }

  // Inline image pasting for create modal content input
  // Create modal content enhancements (paste / drag / file select)
  if (contentInput) {
    const fileInput = modalEl.querySelector('[data-diary-content-image]');
    const trigger = modalEl.querySelector('[data-diary-content-image-trigger]');
    trigger && trigger.addEventListener('click', () => fileInput && fileInput.click());
    async function uploadContentFiles(files, label) {
      for (const f of files) {
        if (!f.type.startsWith('image/')) continue;
        if (f.size > 16 * 1024 * 1024) {
          window.flash && window.flash('Image too large', 'warning');
          continue;
        }
        // if (!confirm('Insert image into entry?')) return;
        const placeholder = '\n![uploading]()';
        const start = contentInput.selectionStart,
          end = contentInput.selectionEnd;
        const orig = contentInput.value;
        contentInput.value = orig.slice(0, start) + placeholder + orig.slice(end);
        contentInput.selectionStart = contentInput.selectionEnd = start + placeholder.length;
        const r = new FileReader();
        r.onload = async () => {
          try {
            const res = await App.utils.fetchJSONUnified('/api/diary-images', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                image: r.result
              })
            });
            contentInput.value = contentInput.value.replace('![uploading]()', `![img](${res.url})`);
          } catch (_) {
            contentInput.value = contentInput.value.replace('![uploading]()', '(image failed)');
          }
        };
        r.readAsDataURL(f);
      }
    }
    fileInput && fileInput.addEventListener('change', () => {
      uploadContentFiles(Array.from(fileInput.files || []), 'Selected');
      fileInput.value = '';
    });
    contentInput.addEventListener('paste', e => {
      const items = e.clipboardData?.items || [];
      const files = [];
      for (const it of items) {
        if (it.type?.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        uploadContentFiles(files, 'Pasted');
      }
    });
    contentInput.addEventListener('dragover', e => {
      e.preventDefault();
    });
    contentInput.addEventListener('drop', e => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) uploadContentFiles(files, 'Dropped');
    });
  }

  // Set up modal cleanup
  window.CommentFormatter && window.CommentFormatter.setupModalCleanup(modalEl, ['[data-diary-form]']);
  window.CommentFormatter && window.CommentFormatter.setupModalCleanup(detailModalEl, ['[data-diary-comment-form]']);

  apiList();
})();