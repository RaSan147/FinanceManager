/*
 * Frontend helpers shared by blog-like modules (Diary, To-Do, etc.).
 * Exposes a single global: `window.BlogHelpers`.
 * Keep this file focused on UI helpers (badges, placeholders, navigation
 * warnings, comment rendering, and inline image uploads).
 */
(function () {
  if (window.BlogHelpers) return;

  /**
   * Returns a debounced wrapper for `func`.
   * @param {Function} func
   * @param {number} wait ms
   */
  function debounce(func, wait) {
    let timeout = null;
    return function (...args) {
      const later = () => {
        timeout = null;
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  /**
   * Deterministic 32-bit hash for strings (djb2-like).
   * Returns a non-negative integer.
   */
  function stringHash(str) {
    str = String(str || '');
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 33 + str.charCodeAt(i)) | 0; // keep 32-bit
    }
    return Math.abs(hash);
  }

  /**
   * Choose a stable palette index in [0, paletteSize).
   */
  function tagIndexFor(name, paletteSize) {
    const n = Math.max(1, (paletteSize | 0));
    return stringHash(name) % n;
  }

  /**
   * Apply category/tag styling to a badge-like element.
   * Adds classes: 'badge tag-badge tag-color-N' and removes common bg/text background classes
   * so Bootstrap's background utilities don't conflict with the tag styles.
   */
  function applyCategoryBadge(el, name, paletteSize = 10) {
    if (!el) return;
    const idx = tagIndexFor(name, paletteSize);
    const cl = el.classList;
    Array.from(cl).forEach((cn) => {
      if (/^bg-/.test(cn) || /^text-bg-/.test(cn) || /^text-/.test(cn)) cl.remove(cn);
    });
    cl.add('badge', 'tag-badge', `tag-color-${idx}`);
    if (!el.getAttribute('title')) el.setAttribute('title', String(name || ''));
  }

  /**
   * Apply a stage badge (e.g. 'todo', 'in_progress', 'done').
   * Adds 'badge stage-badge stage-<stage>' and removes prior stage/bg classes.
   */
  function applyStageBadge(el, stage) {
    if (!el) return;
    const s = String(stage || '').trim().toLowerCase() || 'unknown';
    const cl = el.classList;
    Array.from(cl).forEach((cn) => {
      if (/^bg-/.test(cn) || /^text-bg-/.test(cn)) cl.remove(cn);
      if (/^stage-/.test(cn)) cl.remove(cn);
    });
    cl.add('badge', 'stage-badge', `stage-${s}`);
    if (!el.getAttribute('title')) el.setAttribute('title', s.replace(/_/g, ' '));
  }

  /**
   * Insert a lightweight uploading placeholder at the current cursor position
   * of a textarea/input and move the cursor after it.
   * Returns the id string or null.
   */
  function insertUploadingPlaceholder(contentEl) {
    if (!contentEl) return null;
    const id = 'up_' + Math.random().toString(36).slice(2, 9);
    const placeholder = `\n![uploading-${id}]()`;
    const start = contentEl.selectionStart || 0;
    const end = contentEl.selectionEnd || 0;
    const orig = contentEl.value || '';
    contentEl.value = orig.slice(0, start) + placeholder + orig.slice(end);
    const cursor = start + placeholder.length;
    try {
      contentEl.selectionStart = contentEl.selectionEnd = cursor;
    } catch (e) {
      // ignore selection failures (e.g., input types that don't support selection)
    }
    return id;
  }

  /**
   * Install navigation guards that prompt the user when `hasUnsavedFn()` is true.
   * Returns a cleanup function that removes all installed handlers.
   * opts.message can override the confirmation text.
   */
  function setupNavigationWarnings(hasUnsavedFn, opts) {
    if (typeof hasUnsavedFn !== 'function') return () => {};
    opts = opts || {};
    const message = opts.message || 'You have unsaved changes. Are you sure you want to leave?';

    // Remove previous handlers if present to avoid duplicates
    if (window.BlogHelpers && typeof window.BlogHelpers._navWarningCleanup === 'function') {
      try { window.BlogHelpers._navWarningCleanup(); } catch (_) { }
    }

    function beforeUnloadHandler(e) {
      if (hasUnsavedFn()) {
        e.preventDefault();
        e.returnValue = message;
        return message;
      }
    }

    function clickHandler(e) {
      if (!hasUnsavedFn() || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      if (a.hasAttribute('data-no-unsaved-warning') || a.getAttribute('target') === '_blank' || a.hasAttribute('download')) return;
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#')) return;
      if (/^javascript:/i.test(href)) return;
      if (!confirm(message)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }

    function submitHandler(e) {
      if (!hasUnsavedFn()) return;
      const form = e.target;
      if (!(form && form.tagName && form.tagName.toLowerCase() === 'form')) return;
      if (form.hasAttribute('data-no-unsaved-warning')) return;
      if (!confirm(message)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }

    function popstateHandler(e) {
      if (!hasUnsavedFn()) return;
      if (!confirm(message)) {
        try {
          history.pushState(null, '', window.location.href);
        } catch (err) {
          /* ignore */
        }
        e.preventDefault && e.preventDefault();
      }
    }

    window.addEventListener('beforeunload', beforeUnloadHandler);
    document.addEventListener('click', clickHandler, true);
    document.addEventListener('submit', submitHandler, true);
    window.addEventListener('popstate', popstateHandler);

    const cleanup = () => {
      try {
        window.removeEventListener('beforeunload', beforeUnloadHandler);
      } catch (e) {}
      try {
        document.removeEventListener('click', clickHandler, true);
      } catch (e) {}
      try {
        document.removeEventListener('submit', submitHandler, true);
      } catch (e) {}
      try {
        window.removeEventListener('popstate', popstateHandler);
      } catch (e) {}
      if (window.BlogHelpers) delete window.BlogHelpers._navWarningCleanup;
    };

    // Expose cleanup so callers can remove handlers later
    if (window.BlogHelpers) window.BlogHelpers._navWarningCleanup = cleanup;
    return cleanup;
  }

  // NOTE: This module does not provide a RichText renderer. Consumers must
  // provide `window.RichText` or pass a formatter to `renderComments`.

  /**
   * Attach a simple inline image uploader for a textarea/input.
   * options: { contentEl, fileInput, trigger, uploadEndpoint }
   * Expects an `App.utils.fetchJSONUnified` helper that returns an object with `url`.
   */
  function attachInlineImageUploader(options) {
    const { contentEl, fileInput, trigger, uploadEndpoint } = options || {};
    if (!contentEl || !fileInput || !uploadEndpoint) return;
    if (trigger) trigger.addEventListener('click', () => fileInput && fileInput.click());

    async function uploadAndReplace(file, idTag) {
      if (!file || !file.type.startsWith('image/')) return;
      if (file.size > 16 * 1024 * 1024) {
        window.flash('Image too large', 'warning');
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const res = await App.utils.fetchJSONUnified(uploadEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: reader.result })
          });
          const url = (res && res.url) || '';
          contentEl.value = contentEl.value.replace(`![uploading-${idTag}]()`, url ? `![img](${url})` : '(image failed)');
        } catch (err) {
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

    fileInput.addEventListener('change', () => {
      handleFiles(Array.from(fileInput.files || []));
      fileInput.value = '';
    });

    contentEl.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items ? e.clipboardData.items : [];
      const files = [];
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        handleFiles(files);
      }
    });

    contentEl.addEventListener('dragover', (e) => e.preventDefault());
    contentEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (files.length) handleFiles(files);
    });
  }

  /**
   * Render comments into a container element.
   * opts: { item, deleteEndpointPrefix, thumbTransform, markdownToggleSelector, formatter, onDeleted }
   */
  async function renderComments(container, comments, opts) {
    if (!container) return;
    const options = opts || {};
    const item = options.item || {};

    if (!comments || !comments.length) {
      container.innerHTML = '<div class="text-muted">No comments</div>';
      return;
    }

    const thumb = options.thumbTransform || ((u) => u);
    const mkToggle = options.markdownToggleSelector ? document.querySelector(options.markdownToggleSelector) : null;
    const markdownEnabled = mkToggle ? !!mkToggle.checked : (localStorage.getItem('blog-markdown-enabled') === 'true');
    const fmt = options.formatter && options.formatter.formatText
      ? (txt) => options.formatter.formatText(txt)
      : (txt) => window.RichText.renderInlineContent(txt || '', (item && item._id) || '', markdownEnabled);

    container.innerHTML = comments
      .map((c) => {
        const images = (c.images || [])
          .map((u, i) => {
            const t = thumb(u);
            return `<div class='mt-2'><img src='${t}' data-viewer-thumb data-viewer-group='comment-${item._id}' data-viewer-src='${u}' alt='comment image ${i + 1}' style='max-width:140px;max-height:140px;height:auto;border:1px solid var(--border-color);border-radius:4px;cursor:pointer;object-fit:cover;'/></div>`;
          })
          .join('');

        const formattedText = fmt(c.body || '');
            return `
        <div class='blog-comment'>
          <div class='body'>
            <div class='content' data-markdown-container>${formattedText}</div>
            ${images}
            <div class='meta d-flex align-items-center'>
              <div class='datetime text-muted'>${globalThis.SiteDate.toDateTimeString(c.created_at)}</div>
              <div class='ms-auto'>
                <button class='btn btn-sm btn-outline-danger action-btn' data-comment-del='${c._id}' title='Delete'><i class='fa-solid fa-trash' aria-hidden='true'></i><span class='d-none d-sm-inline ms-1'>Delete</span></button>
              </div>
            </div>
          </div>
        </div>`;
      })
      .join('');

    // Delegate delete clicks
    container.querySelectorAll('[data-comment-del]').forEach((btn) =>
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const cid = btn.getAttribute('data-comment-del');
        if (!cid) return;
        try {
          await App.utils.fetchJSONUnified(`${options.deleteEndpointPrefix}${cid}`, { method: 'DELETE' });
          if (typeof options.onDeleted === 'function') options.onDeleted(options.item && options.item._id);
        } catch (err) {
          window.flash?.('Delete failed', 'danger');
        }
      })
    );
  }

  // Public API
  window.BlogHelpers = {
    debounce,
    setupNavigationWarnings,
    attachInlineImageUploader,
    insertUploadingPlaceholder,
    renderComments,
    // Tag/stage helpers
    stringHash,
    tagIndexFor,
    applyCategoryBadge,
    applyStageBadge
  };
})();

/*
 * Extended helpers extracted from Diary/To-Do modules to reduce duplication.
 * These are attached after the initial IIFE to avoid large diffs above.
 */
(function(){
  if (!window.BlogHelpers) return;

  // Normalize categories input (null | JSON string of array | array) -> array of trimmed strings
  function normalizeCatsInput(v) {
    const MAX = 64;
    if (v == null) return [];
    let arr = [];
    if (Array.isArray(v)) arr = v.slice();
    else if (typeof v === 'string') {
      try {
        const maybe = JSON.parse(v || '[]');
        if (Array.isArray(maybe)) arr = maybe.slice();
        else arr = [];
      } catch (_) { arr = []; }
    } else {
      return [];
    }
    return arr
      .map(s => (s || '').toString().trim())
      .filter(Boolean)
      .map(s => s.length > MAX ? s.slice(0, MAX) : s);
  }

  function categoryToArray(val) {
    if (Array.isArray(val)) return val.slice();
    if (typeof val === 'string' && val.trim()) return val.split(',').map(s => s.trim()).filter(Boolean);
    return [];
  }

  function stripBadgeLikeClasses(el) {
    if (!el || !el.classList) return;
    const cls = Array.from(el.classList);
    for (const cn of cls) {
      if (/^bg-/.test(cn) || /^text-bg-/.test(cn) || /^text-/.test(cn) || /^tag-color-/.test(cn) || cn === 'tag-badge' || cn === 'badge') {
        el.classList.remove(cn);
      }
    }
  }

  // Render 0/1/many category badges into the container
  function renderCategoryBadges(container, catsVal) {
    if (!container) return;
    const cats = categoryToArray(catsVal);
    if (!cats.length) {
      container.classList.add('d-none');
      return;
    }
    if (cats.length === 1) {
      const name = cats[0];
      App.utils.tools.del_child(container);
      try { window.BlogHelpers && window.BlogHelpers.applyCategoryBadge(container, name); } catch (_) {}
      container.textContent = name;
      container.classList.remove('d-none');
      return;
    }
    stripBadgeLikeClasses(container);
    App.utils.tools.del_child(container);
    for (const name of cats) {
      const wrapper = document.createElement('span');
      wrapper.className = 'badge me-1 mb-1 d-inline-flex align-items-center py-1 px-2 tag-badge';
      try { window.BlogHelpers && window.BlogHelpers.applyCategoryBadge(wrapper, name); } catch (_) {}
      wrapper.style.fontSize = '0.9em';
      const text = document.createElement('span');
      text.textContent = name;
      text.style.whiteSpace = 'nowrap';
      wrapper.appendChild(text);
      container.appendChild(wrapper);
    }
    container.classList.remove('d-none');
  }

  // Generic TagTypeahead-based category widget builder
  function setupCategoryWidget(rootEl, opts) {
    const chipsWrap = rootEl.querySelector(opts.chipsSelector);
    const inputEl = rootEl.querySelector(opts.inputSelector);
    const jsonInput = rootEl.querySelector(opts.jsonInputSelector);
    const addBtn = rootEl.querySelector(opts.addBtnSelector || '[data-blog-create-add-btn]')
      || rootEl.querySelector('[data-todo-detail-add-btn]')
      || rootEl.querySelector('[data-diary-detail-add-btn]');
    if (!window.TagTypeahead) throw new Error('TagTypeahead not loaded');
    const widget = window.TagTypeahead.create({
      inputEl,
      chipsEl: chipsWrap,
      jsonInput,
      addBtn,
      initial: Array.isArray(opts.initial) ? opts.initial : normalizeCatsInput(opts.initial),
      ensureLoaded: () => (typeof opts.ensureLoaded === 'function' ? opts.ensureLoaded() : undefined),
      getHints: () => (typeof opts.getHints === 'function' ? opts.getHints() : []),
      applyBadge: (el, name) => { try { window.BlogHelpers && window.BlogHelpers.applyCategoryBadge(el, name); } catch(_){} }
    });
    return widget;
  }

  // Lightweight filter input typeahead with dropdown
  function setupFilterTypeahead(inputEl, options) {
    if (!inputEl) return null;
    if (inputEl._bhTypeaheadBound) return inputEl._bhTypeaheadInstance || null;
    inputEl._bhTypeaheadBound = true;
    const getHints = options && options.getHints ? options.getHints : (() => []);
    const ensureLoaded = options && options.ensureLoaded ? options.ensureLoaded : (() => Promise.resolve());
    const limit = (options && options.limit) || 8;
    const parent = inputEl.parentElement;
    if (parent && !parent.classList.contains('position-relative')) parent.classList.add('position-relative');
    const menu = document.createElement('div');
    menu.className = 'dropdown-menu show';
    menu.style.position = 'absolute';
    menu.style.minWidth = Math.max(inputEl.offsetWidth, 160) + 'px';
    menu.style.maxHeight = '240px';
    menu.style.overflowY = 'auto';
    menu.style.display = 'none';
    menu.style.zIndex = String((options && options.zIndex) || 1051);
    (parent || document.body).appendChild(menu);
    let activeIndex = -1;
    let items = [];
    function updateMenuPosition() {
      try {
        const rect = inputEl.getBoundingClientRect();
        const parentRect = (parent || document.body).getBoundingClientRect();
        const top = rect.top - parentRect.top + inputEl.offsetHeight + 2 + (parent ? parent.scrollTop : 0);
        const left = rect.left - parentRect.left + (parent ? parent.scrollLeft : 0);
        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
        menu.style.minWidth = Math.max(inputEl.offsetWidth, 160) + 'px';
      } catch (_) {}
    }
    function hide() { menu.style.display = 'none'; activeIndex = -1; }
    function show() { if (items.length) menu.style.display = ''; }
    function setActive(idx) {
      activeIndex = idx;
      const nodes = menu.querySelectorAll('.dropdown-item');
      nodes.forEach((n, i) => n.classList.toggle('active', i === activeIndex));
    }
    function pick(idx) {
      if (idx < 0 || idx >= items.length) return;
      inputEl.value = items[idx];
      hide();
      if (typeof options.onPick === 'function') options.onPick(items[idx]);
    }
    function filterHints(q) {
      const ql = (q || '').trim().toLowerCase();
      const all = getHints() || [];
      if (!ql) return all.slice(0, limit);
      const starts = [];
      const contains = [];
      for (const name of all) {
        const nl = String(name).toLowerCase();
        if (nl.startsWith(ql)) starts.push(name);
        else if (nl.includes(ql)) contains.push(name);
        if (starts.length >= limit) break;
      }
      const out = starts.concat(contains.filter(n => !starts.includes(n)));
      return out.slice(0, limit);
    }
    function renderList(list) {
      items = Array.isArray(list) ? list.slice() : [];
      if (!items.length) { hide(); return; }
      menu.innerHTML = items.map((n, i) => `<button type="button" class="dropdown-item" data-idx="${i}">${n}</button>`).join('');
      menu.querySelectorAll('.dropdown-item').forEach(btn => {
        btn.addEventListener('mousedown', (e) => { e.preventDefault(); const idx = parseInt(btn.getAttribute('data-idx')||'-1',10); pick(idx); });
      });
      setActive(-1);
      updateMenuPosition();
      show();
    }
    inputEl.addEventListener('input', () => {
      const list = filterHints(inputEl.value || '');
      renderList(list);
    });
    inputEl.addEventListener('focus', () => {
      Promise.resolve().then(() => ensureLoaded()).finally(() => {
        renderList(filterHints(inputEl.value || ''));
      });
    });
    inputEl.addEventListener('blur', () => { setTimeout(hide, 120); });
    inputEl.addEventListener('keydown', (e) => {
      if (menu.style.display === 'none') return;
      const max = items.length - 1;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(max, activeIndex + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, activeIndex - 1)); }
      else if (e.key === 'Enter') { if (activeIndex >= 0) { e.preventDefault(); pick(activeIndex); } }
      else if (e.key === 'Escape') { hide(); }
    });
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    const onDocMouseDownFilter = (e) => { try { if (!menu.contains(e.target) && e.target !== inputEl) hide(); } catch (_) {} };
    const onFocusOutFilter = (e) => {
      const rel = e.relatedTarget;
      if (!rel || !menu.contains(rel)) {
        setTimeout(() => {
          if (document.activeElement !== inputEl && !menu.contains(document.activeElement)) hide();
        }, 0);
      }
    };
    document.addEventListener('mousedown', onDocMouseDownFilter);
    inputEl.addEventListener('focusout', onFocusOutFilter);

    const api = { destroy() { try { document.removeEventListener('mousedown', onDocMouseDownFilter); } catch(_){} try { inputEl.removeEventListener('focusout', onFocusOutFilter); } catch(_){} try { window.removeEventListener('resize', updateMenuPosition); window.removeEventListener('scroll', updateMenuPosition, true); } catch(_){} try { menu.remove(); } catch(_){} } };
    inputEl._bhTypeaheadInstance = api;
    return api;
  }

  // Optional ImageKit thumb transform passthrough
  function thumb(url, w, h, smart) {
    try { if (window.ImageUploader && window.ImageUploader.thumbTransform) return window.ImageUploader.thumbTransform(url, w, h, !!smart); } catch(_){}
    return url;
  }

  Object.assign(window.BlogHelpers, {
    normalizeCatsInput,
    categoryToArray,
    stripBadgeLikeClasses,
    renderCategoryBadges,
    setupCategoryWidget,
    setupFilterTypeahead,
    thumb
  });
})();
