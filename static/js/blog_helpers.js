/* Shared frontend helpers for blog-like features (Diary / To-Do)
   Exposes global `BlogHelpers` with utilities used by both modules.
*/
(function(){
  if (window.BlogHelpers) return;

  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => { clearTimeout(timeout); func(...args); };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  // Simple deterministic hash for strings (djb2 variant)
  function stringHash(str) {
    str = String(str || '');
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash | 0; // force 32-bit
    }
    return Math.abs(hash);
  }

  // Choose a palette index in [0, paletteSize)
  function tagIndexFor(name, paletteSize) {
    const n = Math.max(1, paletteSize | 0);
    return stringHash(name) % n;
  }

  // Apply deterministic category color classes to a badge-like element
  // Adds classes: 'badge tag-badge tag-color-N' and removes common bg-* classes
  function applyCategoryBadge(el, name, paletteSize = 10) {
    if (!el) return;
    const idx = tagIndexFor(name, paletteSize);
    // Clean existing Bootstrap bg-* classes that might conflict
    const cl = el.classList;
    Array.from(cl).forEach(cn => {
      if (/^bg-/.test(cn) || /^text-bg-/.test(cn) || /^text-/.test(cn)) cl.remove(cn);
    });
    cl.add('badge', 'tag-badge', `tag-color-${idx}`);
    // Ensure readable text color via tag-badge styles; optionally set title
    if (!el.getAttribute('title')) el.setAttribute('title', String(name || ''));
  }

  // Apply stage-specific badge classes to an element
  // Adds classes: 'badge stage-badge stage-<stage>' and removes conflicting bg-* classes
  function applyStageBadge(el, stage) {
    if (!el) return;
    const s = String(stage || '').trim().toLowerCase();
    const cl = el.classList;
    Array.from(cl).forEach(cn => {
      if (/^bg-/.test(cn) || /^text-bg-/.test(cn)) cl.remove(cn);
      if (/^stage-/.test(cn)) cl.remove(cn);
    });
    cl.add('badge', 'stage-badge', `stage-${s || 'unknown'}`);
    if (!el.getAttribute('title')) el.setAttribute('title', s.replace(/_/g, ' '));
  }

  // Insert an uploading placeholder into a textarea/input and place the cursor after it.
  // Returns the placeholder id (without brackets) or null on failure.
  function insertUploadingPlaceholder(contentEl) {
    if (!contentEl) return null;
    const id = 'up_' + Math.random().toString(36).slice(2,9);
    const placeholder = `\n![uploading-${id}]()`;
    const start = contentEl.selectionStart || 0;
    const end = contentEl.selectionEnd || 0;
    const orig = contentEl.value || '';
    contentEl.value = orig.slice(0, start) + placeholder + orig.slice(end);
    const cursor = start + placeholder.length;
    try { contentEl.selectionStart = contentEl.selectionEnd = cursor; } catch (_) {}
    return id;
  }

  // Setup navigation warnings when there are unsaved changes.
  // hasUnsavedFn: () => boolean
  // opts: { message?: string }
  // Returns a cleanup function that removes installed handlers.
  function setupNavigationWarnings(hasUnsavedFn, opts) {
    if (!hasUnsavedFn) return () => {};
    opts = opts || {};
    const message = opts.message || 'You have unsaved changes. Are you sure you want to leave?';

    // If we've already registered, remove previous handlers first to avoid duplicates.
    if (window.BlogHelpers && window.BlogHelpers._navWarningCleanup) {
      try { window.BlogHelpers._navWarningCleanup(); } catch (_) {}
    }

    function beforeUnloadHandler(e) {
      if (hasUnsavedFn && hasUnsavedFn()) {
        // Standard compliant way to prompt user
        e.preventDefault();
        e.returnValue = message;
        return e.returnValue;
      }
    }

    // Intercept in-page navigation triggered by anchor clicks (non _blank) and form submits.
    function clickHandler(e) {
      if (!hasUnsavedFn || !hasUnsavedFn()) return;
      // Only consider primary button clicks without modifier keys
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      // Ignore anchors that explicitly opt-out
      if (a.hasAttribute('data-no-unsaved-warning') || a.getAttribute('target') === '_blank' || a.hasAttribute('download')) return;
      const href = a.getAttribute('href') || '';
      // Ignore same-page hash links
      if (href.startsWith('#')) return;
      // If it's a javascript: pseudo-URL, ignore
      if (/^javascript:/i.test(href)) return;
      // Only prompt for navigations that would unload the page
      if (!confirm(message)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }

    function submitHandler(e) {
      if (!hasUnsavedFn || !hasUnsavedFn()) return;
      const form = e.target;
      if (!(form && form.tagName && form.tagName.toLowerCase() === 'form')) return;
      // allow forms to opt-out
      if (form.hasAttribute('data-no-unsaved-warning')) return;
      if (!confirm(message)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }

    function popstateHandler(e) {
      if (hasUnsavedFn && hasUnsavedFn()) {
        if (!confirm(message)) {
          // try to restore the previous url into history so user stays put
          try { history.pushState(null, '', window.location.href); } catch (_) {}
          e.preventDefault && e.preventDefault();
        }
      }
    }

    window.addEventListener('beforeunload', beforeUnloadHandler);
    document.addEventListener('click', clickHandler, true);
    document.addEventListener('submit', submitHandler, true);
    window.addEventListener('popstate', popstateHandler);

    const cleanup = () => {
      try { window.removeEventListener('beforeunload', beforeUnloadHandler); } catch (_) {}
      try { document.removeEventListener('click', clickHandler, true); } catch (_) {}
      try { document.removeEventListener('submit', submitHandler, true); } catch (_) {}
      try { window.removeEventListener('popstate', popstateHandler); } catch (_) {}
      if (window.BlogHelpers) delete window.BlogHelpers._navWarningCleanup;
    };

    // expose cleanup so multiple callers can manage handlers
    if (window.BlogHelpers) window.BlogHelpers._navWarningCleanup = cleanup;
    return cleanup;
  }

  // No internal RichText fallback: require a global `RichText` implementation.

  // Attach simple inline image uploader that inserts a placeholder and replaces it when uploaded.
  // options: { contentEl, fileInput, trigger, uploadEndpoint }
  function attachInlineImageUploader(options) {
    const { contentEl, fileInput, trigger, uploadEndpoint } = options || {};
    if (!contentEl || !fileInput || !uploadEndpoint) return;
    trigger && trigger.addEventListener('click', () => fileInput && fileInput.click());

    // reuse shared placeholder helper

    async function uploadAndReplace(file, idTag) {
      if (!file || !file.type.startsWith('image/')) return;
      if (file.size > 16 * 1024 * 1024) { window.flash && window.flash('Image too large', 'warning'); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const res = await App.utils.fetchJSONUnified(uploadEndpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: reader.result })
          });
          contentEl.value = contentEl.value.replace(`![uploading-${idTag}]()`, `![img](${res.url})`);
        } catch (_) {
          contentEl.value = contentEl.value.replace(`![uploading-${idTag}]()`, '(image failed)');
        }
      };
      reader.readAsDataURL(file);
    }

    function handleFiles(files) {
      if (!files || !files.length) return;
      for (const f of files) {
        const id = insertUploadingPlaceholder(contentEl);
        uploadAndReplace(f, id);
      }
    }

    fileInput.addEventListener('change', () => { handleFiles(Array.from(fileInput.files || [])); fileInput.value = ''; });
    contentEl.addEventListener('paste', e => {
      const items = e.clipboardData?.items || [];
      const files = [];
      for (const it of items) if (it.type?.startsWith('image/')) { const f = it.getAsFile(); if (f) files.push(f); }
      if (files.length) { e.preventDefault(); handleFiles(files); }
    });
    contentEl.addEventListener('dragover', e => e.preventDefault());
    contentEl.addEventListener('drop', e => { e.preventDefault(); const files = Array.from(e.dataTransfer?.files || []); if (files.length) handleFiles(files); });
  }

  // Generic comment renderer. opts: { itemId, deleteEndpointPrefix, thumbTransform, markdownToggleSelector, formatter, onDeleted }
  async function renderComments(container, comments, opts) {
    if (!container) return;
    const options = opts || {};
    const item = options.item || {};
    if (!comments || !comments.length) {
      container.innerHTML = '<div class="text-muted">No comments</div>';
      return;
    }
    const thumb = options.thumbTransform || (u => u);
    const mkToggle = options.markdownToggleSelector ? document.querySelector(options.markdownToggleSelector) : null;
    const markdownEnabled = mkToggle ? !!mkToggle.checked : (localStorage.getItem('blog-markdown-enabled') === 'true');
  const fmt = options.formatter && options.formatter.formatText ? (txt => options.formatter.formatText(txt)) : (txt => window.RichText.renderInlineContent(txt || '', (item && item._id) || '', markdownEnabled));
    container.innerHTML = comments.map(c => {
      const images = (c.images || []).map((u,i) => {
        const t = thumb(u);
        return `<div class='mt-2'><img src='${t}' data-viewer-thumb data-viewer-group='comment-${item._id}' data-viewer-src='${u}' alt='comment image ${i+1}' style='max-width:140px;max-height:140px;height:auto;border:1px solid var(--border-color);border-radius:4px;cursor:pointer;object-fit:cover;'/></div>`;
      }).join('');
      const formattedText = fmt(c.body || '');
      return `
        <div class='blog-comment'>
          <div class='body'>
            <div class='content' data-markdown-container>${formattedText}</div>
            ${images}
            <div class='meta d-flex align-items-center'>
              <div class='datetime text-muted'>${window.SiteDate.toDateTimeString(c.created_at)}</div>
              <div class='ms-auto'>
                <button class='btn btn-sm btn-outline-danger action-btn' data-comment-del='${c._id}' title='Delete'><i class='fa-solid fa-trash' aria-hidden='true'></i><span class='d-none d-sm-inline ms-1'>Delete</span></button>
              </div>
            </div>
          </div>
        </div>`;
    }).join('');
    // delegate delete clicks
    container.querySelectorAll('[data-comment-del]').forEach(btn => btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const cid = btn.getAttribute('data-comment-del');
      if (!cid) return;
      try {
        await App.utils.fetchJSONUnified(`${options.deleteEndpointPrefix}${cid}`, { method: 'DELETE' });
        if (typeof options.onDeleted === 'function') options.onDeleted(options.item && options.item._id);
      } catch (_) { window.flash && window.flash('Delete failed', 'danger'); }
    }));
  }

  window.BlogHelpers = {
    debounce,
    setupNavigationWarnings,
  // no RichTextFallback exported; consumers should provide window.RichText
    attachInlineImageUploader,
    insertUploadingPlaceholder,
    renderComments,
    // tag/stage helpers
    stringHash,
    tagIndexFor,
    applyCategoryBadge,
    applyStageBadge
  };
})();
