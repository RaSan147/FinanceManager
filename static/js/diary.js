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
  const btnDiaryApplyFilters = document.getElementById('btnDiaryApplyFilters');
  const btnClearFilters = document.getElementById('btnDiaryClearFilters');
  const activeFiltersBar = document.getElementById('diaryActiveFiltersBar');
  if (!listEl || !tmpl) return;

  const state = {
    q: '',
    category: '',
    // sort: client-local value; only send to API when user explicitly chose it this session
    sort: null,
    sortExplicit: false,
    items: []
  };

  // Use the global RichText implementation only (no fallbacks). Let it fail loudly if missing.
  const RichText = window.RichText;

  // Edit state cache and navigation warning flag
  const diaryEditStateCache = {};
  let hasUnsavedChanges = false;

  // Robust delegated click (backup in case per-item binding misses)
  listEl.addEventListener('click', e => {
    const item = e.target.closest('.diary-item');
    if (!item) return;
    if (e.target.closest('.btn-delete')) return;
    const id = item.dataset.id;
    if (id) openDetailModal(id);
  });

  async function apiList(forceFresh = false) {
    let url = `/api/diary?per_page=100` + (forceFresh ? `&__ts=${Date.now()}` : '');
    if (state.q) url += `&q=${encodeURIComponent(state.q)}`;
    if (state.category) url += `&category=${encodeURIComponent(state.category)}`;
    // Only include sort if user explicitly selected it this session. Otherwise let server apply persisted sort.
    if (state.sortExplicit && state.sort) url += `&sort=${encodeURIComponent(state.sort)}`;
    try {
      const data = await App.utils.fetchJSONUnified(url);
      state.items = data.items || [];
      // If server returned a persisted sort, apply it to the UI unless user explicitly changed sort this session
      if (data.sort && !state.sortExplicit) {
        state.sort = data.sort;
        updateSortLabel();
        updateSortMenuActive();
      }
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
      } catch (_) { }
    }, 30);
    detailModal?.hide();
  }

  // Wire create-modal header controls after DOM available
  (function wireCreateHeaderControls() {
    const createMarkdownToggle = modalEl.querySelector('[data-diary-markdown-toggle]');
    const createEditToggle = modalEl.querySelector('[data-diary-edit-toggle]');
    const createSaveBtn = modalEl.querySelector('[data-diary-save-btn]');
    const createCancelBtn = modalEl.querySelector('[data-diary-cancel-btn]');
    const previewWrap = modalEl.querySelector('[data-diary-create-preview]');

    function updateCreatePreview() {
      const enabled = createMarkdownToggle?.checked;
      if (!previewWrap) return;
      if (enabled) {
        previewWrap.style.display = '';
        previewWrap.innerHTML = RichText.renderInlineContent(contentInput.value || '', 'create', true);
      } else {
        previewWrap.style.display = 'none';
        previewWrap.innerHTML = '';
      }
    }

    createMarkdownToggle && createMarkdownToggle.addEventListener('change', updateCreatePreview);

    createEditToggle && createEditToggle.addEventListener('click', () => {
      // Toggle preview (edit mode = show textarea, hide preview)
      if (previewWrap && previewWrap.style.display === '') {
        previewWrap.style.display = 'none';
      } else if (previewWrap) {
        previewWrap.style.display = '';
        previewWrap.innerHTML = RichText.renderInlineContent(contentInput.value || '', 'create', createMarkdownToggle?.checked);
      }
    });

    createCancelBtn && createCancelBtn.addEventListener('click', () => {
      form.reset();
      previewWrap && (previewWrap.style.display = 'none');
      if (bsModal) bsModal.hide();
    });

    // Hook header save button to submit form
    createSaveBtn && createSaveBtn.addEventListener('click', () => {
      submitBtn && submitBtn.click();
    });
  })();

  // openEditModal removed: functionality not used in this module. Inline/detail edit
  // behavior is handled via the detail modal's edit controls and switchToEdit().

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
    // Do not show sort in the active filters bar (consistent with To-Do)
    activeFiltersBar.innerHTML = chips.join(' ');
    activeFiltersBar.style.display = chips.length ? 'flex' : 'none';
  }

  function currentSortLabelText() {
    const map = {
      created_desc: 'Newest',
      created_asc: 'Oldest'
    };
    return map[state.sort] || 'Sort';
  }

  function updateSortLabel() {
    const el = document.getElementById('currentSortLabel');
    if (!el) return;
    el.textContent = currentSortLabelText();
  }

  function updateSortMenuActive() {
    const menu = document.getElementById('sortMenu');
    if (!menu) return;
    menu.querySelectorAll('[data-sort]').forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-sort') === state.sort));
  }

  async function persistDiarySort(s) {
    try {
      await App.utils.fetchJSONUnified('/api/sort-pref', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'diary',
          sort: s
        })
      });
    } catch (_) { }
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
  btnDiaryApplyFilters && btnDiaryApplyFilters.addEventListener('click', () => {
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

  // Wire diary sort menu
  const diarySortMenu = document.getElementById('sortMenu');
  if (diarySortMenu) {
    diarySortMenu.querySelectorAll('[data-sort]').forEach(el => el.addEventListener('click', (ev) => {
      ev.preventDefault();
      const s = el.getAttribute('data-sort');
      if (!s) return;
      state.sort = s;
      state.sortExplicit = true;
      updateSortLabel();
      updateSortMenuActive();
      apiList();
      // Persist per-user preference (fire-and-forget)
      persistDiarySort(s);
    }));
  }

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
    if (!window.SiteDate) throw new Error('SiteDate is required');
    if (!dateValue) return 'Unknown date';
    const dt = window.SiteDate.parse(dateValue);
    if (!dt) return 'Invalid date';
    return window.SiteDate.toDateTimeString(dt);
  }

  // Ensure detail modal always starts in view mode
  function switchToView() {
    if (!detailModalEl) return;
    const root = detailModalEl.querySelector('[data-diary-detail-root]');
    if (!root) return;

    const editForm = root.querySelector('[data-diary-detail-edit-form]');
    // The header controls live in the modal header (moved out of the body), select from the modal element
    const editBtn = detailModalEl.querySelector('[data-diary-detail-edit-btn]');
    const saveBtn = detailModalEl.querySelector('[data-diary-detail-save-btn]');
    const cancelBtn = detailModalEl.querySelector('[data-diary-detail-cancel-btn]');
    const contentEl = root.querySelector('[data-diary-detail-content]');

    if (editForm) editForm.classList.add('d-none');
    if (contentEl) contentEl.classList.remove('d-none');
    if (editBtn) editBtn.classList.remove('d-none');
    if (saveBtn) saveBtn.classList.add('d-none');
    if (cancelBtn) cancelBtn.classList.add('d-none');
  }

  // Cache markdown preferences
  let markdownPreference = null;

  function getMarkdownPreference() {
    if (markdownPreference === null) {
      markdownPreference = localStorage.getItem('diary-markdown-enabled') === 'true';
    }
    return markdownPreference;
  }



  function renderDetail(data) {
    if (!detailModalEl) return;

    const item = data.item || {};
    const root = detailModalEl.querySelector('[data-diary-detail-root]');
    if (!root) return;

    const currentDiaryId = item._id;
    root.dataset.currentDiaryId = currentDiaryId;

    // Always start in view mode (we may switch to edit below based on cache)
    switchToView();

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
    // Markdown toggle and edit controls are now in the modal header, select from modal element
    const markdownToggle = detailModalEl.querySelector('[data-diary-markdown-toggle]');
    const contentEl = root.querySelector('[data-diary-detail-content]');

    function updateContent() {
      const markdownEnabled = markdownToggle?.checked || false;
      if (contentEl) {
        // Use class name that matches CSS file selector `.markdown-content`
        contentEl.classList.toggle('markdown-content', markdownEnabled);
        contentEl.innerHTML = RichText.renderInlineContent(item.content || '', item._id, markdownEnabled);
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
      // Store last comments for re-render when markdown toggle changes
      commentsWrap._lastCommentsData = comments;

      function renderComments(itemLocal, commentsList) {
        if (!commentsList || !commentsList.length) {
          commentsWrap.innerHTML = '<div class="text-muted">No comments</div>';
          return;
        }
        const ikThumb = (url) => (window.ImageUploader && ImageUploader.thumbTransform) ?
          ImageUploader.thumbTransform(url, 320, 320, false) :
          url;
        const mt = detailModalEl.querySelector('[data-diary-markdown-toggle]');
        const markdownEnabled = mt ? !!mt.checked : (localStorage.getItem('diary-markdown-enabled') === 'true');
        commentsWrap.innerHTML = commentsList.map(c => {
          const images = (c.images || []).map((u, i) => {
            const t = ikThumb(u);
            return `<div class='mt-2'><img src='${t}' data-viewer-thumb data-viewer-group='diary-comment-${itemLocal._id}' data-viewer-src='${u}' alt='comment image ${i + 1}' style='max-width:140px;max-height:140px;cursor:pointer;border:1px solid var(--border-color);border-radius:4px;object-fit:cover;'/></div>`
          }).join('');
          const formattedText = RichText.renderInlineContent(c.body || '', `diary-comment-${itemLocal._id}`, !!markdownEnabled);
          const timestamp = safeFormatDate(c.created_at["$date"]);
          return `<div class='diary-comment'><div class='body'><div class='content'>${formattedText}</div>${images}<div class='meta d-flex align-items-center'><div class='datetime text-muted small'>${timestamp}</div><div class='ms-auto'><button class='btn btn-sm btn-outline-danger' data-comment-del='${c._id}'><i class='bi bi-trash'></i></button></div></div></div></div>`;
        }).join('');
        // delegate delete clicks
        commentsWrap.querySelectorAll('[data-comment-del]').forEach(btn => btn.addEventListener('click', async (e) => {
          e.preventDefault();
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

      // Initial render
      renderComments(item, comments);

      // When markdown toggle changes, re-render comments to reflect preference
      if (markdownToggle) {
        markdownToggle.addEventListener('change', () => {
          updateContent();
          if (commentsWrap && commentsWrap._lastCommentsData) {
            renderComments(item, commentsWrap._lastCommentsData);
          }
        });
      }
    }
    const limitEl = root.querySelector('[data-diary-comment-limit]');
    if (limitEl) limitEl.textContent = `${(data.comment_max || 4000)} chars max`;
    const formC = root.querySelector('[data-diary-comment-form]');
    if (formC) formC.dataset.diaryId = item._id;
    // populate edit form with cache awareness
    const editForm = root.querySelector('[data-diary-detail-edit-form]');
    if (editForm) {
      editForm.dataset.diaryId = currentDiaryId || '';

      if (currentDiaryId && diaryEditStateCache[currentDiaryId]) {
        // Restore from cache (unsaved changes)
        const cached = diaryEditStateCache[currentDiaryId];
        editForm.querySelector('[data-diary-detail-edit-title]').value = cached.title || '';
        editForm.querySelector('[data-diary-detail-edit-category]').value = cached.category || '';
        editForm.querySelector('[data-diary-detail-edit-content]').value = cached.content || '';

        // Start in edit mode if we have cached unsaved changes
        if (cached.isEditing) {
          switchToEdit();
        } else {
          switchToView();
        }
      } else {
        // Fresh data - no unsaved changes
        editForm.querySelector('[data-diary-detail-edit-title]').value = item.title || '';
        editForm.querySelector('[data-diary-detail-edit-category]').value = item.category || '';
        editForm.querySelector('[data-diary-detail-edit-content]').value = item.content || '';
        switchToView();
      }
    }
    // Bind header controls (edit/save/cancel) which were moved to the modal header
    const editBtn = detailModalEl.querySelector('[data-diary-detail-edit-btn]');
    const saveBtn = detailModalEl.querySelector('[data-diary-detail-save-btn]');
    const cancelBtn = detailModalEl.querySelector('[data-diary-detail-cancel-btn]');
    if (editBtn && saveBtn && cancelBtn && editForm) {
      if (editForm.classList.contains('d-none')) {
        editBtn.classList.remove('d-none');
        saveBtn.classList.add('d-none');
        cancelBtn.classList.add('d-none');
      }
    }

    // Ensure canonical save button runs the centralized save routine
    if (saveBtn && editForm && !saveBtn._diarySaveBound) {
      saveBtn._diarySaveBound = true;
      saveBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        diaryPerformDetailSave(editForm);
      });
    }

    // Ensure header buttons always trigger behavior even if DOM is re-rendered — delegate clicks from modal
    // NOTE: calling `.click()` here caused the save handler to run twice (native click -> bubbled handler -> programmatic click).
    // To avoid duplicate network requests we call the action functions directly.
    if (!detailModalEl._headerClickBound) {
      detailModalEl._headerClickBound = true;
      detailModalEl.addEventListener('click', (e) => {
        const rootInner = detailModalEl.querySelector('[data-diary-detail-root]');
        if (e.target.closest('[data-diary-detail-edit-btn]')) {
          try {
            switchToEdit();
          } catch (_) { }
        }
        if (e.target.closest('[data-diary-detail-cancel-btn]')) {
          const diaryId = rootInner?.dataset.currentDiaryId;
          if (diaryId) clearEditStateFromCache(diaryId);
          try {
            switchToView();
          } catch (_) { }
          if (diaryId) openDetailModal(diaryId);
        }
        if (e.target.closest('[data-diary-detail-save-btn]')) {
          // If the click originated from the actual save button element, let its
          // own click handler handle the action to avoid double-invocation.
          const matched = e.target.closest('[data-diary-detail-save-btn]');
          const canonicalSaveBtn = detailModalEl.querySelector('[data-diary-detail-save-btn]');
          if (matched && matched === canonicalSaveBtn) {
            return;
          }
          // Otherwise (some external control requested save), call the save routine directly.
          try {
            const editFormInner = rootInner?.querySelector('[data-diary-detail-edit-form]');
            if (editFormInner) diaryPerformDetailSave(editFormInner);
          } catch (_) { }
        }
      });
    }
  }


  // Perform save for the inline/detail edit form. Centralized so both canonical button
  // and delegated external save callers use the same logic.
  async function diaryPerformDetailSave(editForm) {
    if (!editForm) return;
    const diaryId = editForm.dataset.diaryId;
    if (!diaryId) return;
    const fd = new FormData(editForm);
    const patch = {};
    fd.forEach((v, k) => { patch[k] = v.toString(); });
    // Normalize clears
    if (patch.due_date === '') patch.due_date = null;
    if (patch.category === '') patch.category = null;
    try {
      await App.utils.fetchJSONUnified(`/api/diary/${diaryId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      window.flash && window.flash('Updated', 'success');
      try { switchToView(); } catch (_) {}
      openDetailModal(diaryId);
      apiList();
    } catch (e) {
      console.error('Detail update failed', e);
      window.flash && window.flash('Update failed', 'danger');
    }
  }
  // --- Edit state caching, navigation warnings, debounce helpers ---
  function saveEditStateToCache(diaryId, root) {
    const editForm = root.querySelector('[data-diary-detail-edit-form]');
    if (!editForm) return;

    const isEditing = !editForm.classList.contains('d-none');
    const title = editForm.querySelector('[data-diary-detail-edit-title]').value;
    const category = editForm.querySelector('[data-diary-detail-edit-category]').value;
    const content = editForm.querySelector('[data-diary-detail-edit-content]').value;

    const originalItem = state.items.find(item => item._id === diaryId);

    const hasChanges = !originalItem ||
      title !== (originalItem.title || '') ||
      category !== (originalItem.category || '') ||
      content !== (originalItem.content || '');

    if (hasChanges || isEditing) {
      diaryEditStateCache[diaryId] = {
        isEditing,
        title,
        category,
        content,
        hasChanges
      };
      updateUnsavedChangesFlag();
    } else {
      delete diaryEditStateCache[diaryId];
      updateUnsavedChangesFlag();
    }
  }

  function updateUnsavedChangesFlag() {
    hasUnsavedChanges = Object.values(diaryEditStateCache).some(s => !!s.hasChanges);
    const originalTitle = document.title.replace(/^◌\s*/, '');
    document.title = hasUnsavedChanges ? `◌ ${originalTitle}` : originalTitle;
  }

  function clearEditStateFromCache(diaryId) {
    delete diaryEditStateCache[diaryId];
    updateUnsavedChangesFlag();
  }

  function hasAnyUnsavedChanges() {
    return hasUnsavedChanges;
  }

  function hasUnsavedChangesForDiary(diaryId) {
    return !!(diaryEditStateCache[diaryId] && diaryEditStateCache[diaryId].hasChanges);
  }

  function getDiariesWithUnsavedChanges() {
    return Object.keys(diaryEditStateCache).filter(id => diaryEditStateCache[id].hasChanges);
  }

  // Use shared helpers for navigation warnings and debounce to avoid duplicate fallbacks.
  if (window.BlogHelpers && window.BlogHelpers.setupNavigationWarnings) {
    window.BlogHelpers.setupNavigationWarnings(() => hasAnyUnsavedChanges());
  }
  var debounce = (window.BlogHelpers && window.BlogHelpers.debounce) ? window.BlogHelpers.debounce : (fn => fn);

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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body, images })
          });
          formC.reset();
          images = [];
          renderPreviews();
          delete diaryDrafts[diaryId];
          openDetailModal(diaryId);
        } catch (_) {}
      });
    }
  }

  // Reset detail modal to view mode when hidden
  if (detailModalEl) {
    detailModalEl.addEventListener('hide.bs.modal', switchToView);
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