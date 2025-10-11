(() => {
    // Diary module: manage list, create, edit, and comments for diary entries.
    // Assumes shared global modules are loaded: App.utils, BlogHelpers, RichText, ImageUploader, CommentFormatter.
    if (window.__diaryModuleLoaded) return;
    window.__diaryModuleLoaded = true;

    // DOM roots
    const modalEl = document.getElementById('diaryModal');
    if (!modalEl) return;
    const listEl = document.getElementById('diaryList');
    const tmpl = document.getElementById('diaryItemTemplate');
    if (!listEl || !tmpl) return;

    // Feature controls
    const btnNew = document.getElementById('btnNewDiaryTop');
    const filterToggle = document.getElementById('btnDiaryFilterToggle');
    const categorySel = document.getElementById('diaryFilterCategory');
    const searchEl = document.getElementById('diarySearch');
    const btnDiaryApplyFilters = document.getElementById('btnDiaryApplyFilters');
    const btnClearFilters = document.getElementById('btnDiaryClearFilters');
    const activeFiltersBar = document.getElementById('diaryActiveFiltersBar');

    // Local references to global helpers for clarity and fewer repeated window lookups
    const BlogHelpers = window.BlogHelpers;
    const RichText = window.RichText;
    const ImageUploader = window.ImageUploader;
    const CommentFormatter = window.CommentFormatter;

  // Bootstrap modal instances (guard bootstrap since it's optional in some environments).
  // Ensure modals are direct children of <body> so Bootstrap's backdrop stacks correctly.
  const detailModalEl = document.getElementById('diaryDetailModal');
  [modalEl, detailModalEl].forEach(m => { if (m && m.parentElement !== document.body) document.body.appendChild(m); });
  const bsModal = (window.bootstrap && modalEl) ? bootstrap.Modal.getOrCreateInstance(modalEl) : null;
  const detailModal = (window.bootstrap && detailModalEl) ? bootstrap.Modal.getOrCreateInstance(detailModalEl) : null;

    // Module state
    const state = { q: '', category: '', sort: null, sortExplicit: false, items: [] };
    let diaryCategoryHints = [];

    // --- Utilities -----------------------------------------------------------------
    async function loadDiaryCategoryHints() {
      try {
        const dl = document.getElementById('diaryCategoriesGlobal');
        if (dl.dataset.loaded === '1') return;
        const data = await App.utils.fetchJSONUnified('/api/diary-categories', { dedupe: true });
        diaryCategoryHints = (data.items || []).map(c => c.name).filter(Boolean).slice(0, 200);
        dl.innerHTML = diaryCategoryHints.map(n => `<option value="${n}"></option>`).join('');
        dl.dataset.loaded = '1';
      } catch (err) {
        console.warn('loadDiaryCategoryHints failed', err);
      }
    }

    function truncateText(txt, lim = 300) { return (!txt) ? '' : (txt.length > lim ? txt.slice(0, lim) + '…' : txt); }

    function renderCategoryChips(container, items) {
      container.innerHTML = '';
      for (const name of items) {
        const wrapper = document.createElement('span');
        wrapper.className = 'badge me-1 mb-1 d-inline-flex align-items-center py-1 px-2 tag-badge';
        BlogHelpers.applyCategoryBadge(wrapper, name);
        wrapper.style.fontSize = '0.9em';

        const text = document.createElement('span');
        text.textContent = name;
        text.style.whiteSpace = 'nowrap';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn chip-close btn-sm ms-2';
        btn.setAttribute('aria-label', 'Remove');
        btn.style.marginLeft = '0.4rem';
        btn.innerHTML = "<i class='fa-solid fa-xmark' aria-hidden='true'></i>";
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = items.indexOf(name);
          if (idx !== -1) { items.splice(idx, 1); renderCategoryChips(container, items); }
        });

        wrapper.appendChild(text);
        wrapper.appendChild(btn);
        container.appendChild(wrapper);
      }
    }

    function setupCategoryWidget(rootEl, opts) {
      // opts: {chipsSelector, inputSelector, jsonInputSelector, initial, addBtnSelector}
      const chipsWrap = rootEl.querySelector(opts.chipsSelector);
      const inputEl = rootEl.querySelector(opts.inputSelector);
      const jsonInput = rootEl.querySelector(opts.jsonInputSelector);
      const list = Array.isArray(opts.initial) ? [...opts.initial] : [];

      const sync = () => {
        renderCategoryChips(chipsWrap, list);
        if (jsonInput) jsonInput.value = JSON.stringify(list);
      };

      const addFromInput = () => {
        const val = (inputEl.value || '').trim();
        if (!val) return;
        const parts = val.split(',').map(s => s.trim()).filter(Boolean);
        for (const p of parts) if (!list.includes(p)) list.push(p);
        inputEl.value = '';
        sync();
        try { inputEl.focus(); } catch (_) {}
      };

      const addBtn = rootEl.querySelector(opts.addBtnSelector || '[data-diary-create-add-btn]') || rootEl.querySelector('[data-diary-detail-add-btn]');
      if (addBtn) addBtn.addEventListener('click', (e) => { e.preventDefault(); addFromInput(); });

      inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addFromInput(); } });
      inputEl.addEventListener('blur', () => { if ((inputEl.value || '').trim()) addFromInput(); });
      inputEl.addEventListener('focus', loadDiaryCategoryHints);

      sync();
      return { getList: () => list };
    }

    // --- List rendering & actions -------------------------------------------------
    listEl.addEventListener('click', e => {
      const item = e.target.closest('.diary-item');
      if (!item) return;
      if (e.target.closest('.btn-delete')) return; // delete is handled per-item
      const id = item.dataset.id;
      if (id) openDetailModal(id);
    });

    async function apiList(forceFresh = false) {
      let url = `/api/diary?per_page=100` + (forceFresh ? `&__ts=${Date.now()}` : '');
      if (state.q) url += `&q=${encodeURIComponent(state.q)}`;
      if (state.category) url += `&category=${encodeURIComponent(state.category)}`;
      if (state.sortExplicit && state.sort) url += `&sort=${encodeURIComponent(state.sort)}`;
      try {
        const data = await App.utils.fetchJSONUnified(url);
        state.items = data.items || [];
        if (data.sort && !state.sortExplicit) { state.sort = data.sort; updateSortLabel(); updateSortMenuActive(); }
        renderList();
      } catch (err) { console.warn('Diary list fetch failed', err); }
    }

    function renderList() {
      listEl.innerHTML = '';
      if (!state.items.length) {
        listEl.innerHTML = '<div class="text-muted small fst-italic">No entries.</div>';
        updateActiveFilterChips(); updateFilterBtnActive(); return;
      }
      for (const it of state.items) {
        const node = tmpl.content.firstElementChild.cloneNode(true);
        hydrate(node, it);
        listEl.appendChild(node);
      }
      updateActiveFilterChips(); updateFilterBtnActive();
    }

    function hydrate(node, it) {
      node.dataset.id = it._id;
      node.querySelector('.diary-title').textContent = it.title || '(Untitled)';
      const cat = node.querySelector('.diary-category');
      if (it.category) { cat.textContent = it.category; cat.classList.remove('d-none'); BlogHelpers.applyCategoryBadge(cat, it.category); }
      const cEl = node.querySelector('.diary-content-trunc'); if (cEl) cEl.textContent = truncateText(it.content || '');
      const delBtn = node.querySelector('.btn-delete'); if (delBtn) delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteEntry(it._id); });
    }

    async function deleteEntry(id) {
      if (!confirm('Delete this entry?')) return;
      try {
        await App.utils.fetchJSONUnified(`/api/diary/${id}`, { method: 'DELETE' });
        window.flash('Deleted', 'info');
        apiList(true);
      } catch (err) { window.flash('Delete failed', 'danger'); }
    }

    // --- Create modal -------------------------------------------------------------
    const form = modalEl.querySelector('[data-diary-form]');
    const titleEl = modalEl.querySelector('[data-diary-modal-title]');
    const idInput = form.querySelector('[data-diary-id]');
    const submitBtn = form.querySelector('[data-diary-submit-btn]');
    const contentInput = form.querySelector('[data-diary-content-input]');

    function closeOtherModals() {
      const modals = document.querySelectorAll('.modal.show');
      modals.forEach(m => {
        if (m === modalEl || m === detailModalEl) return;
        const focusedElement = m.querySelector(':focus');
        if (focusedElement) {
          focusedElement.blur();
        }
        if (window.bootstrap) {
          const inst = bootstrap.Modal.getInstance(m);
          if (inst) inst.hide();
        }
      });
    }

    function openCreateModal() {
      form.reset();
      idInput.value = '';
      titleEl.textContent = 'New Entry';
      submitBtn.textContent = 'Save';

      closeOtherModals();
      if (bsModal) {
        bsModal.show();
      } else {
        modalEl.style.display = 'block';
      }

      setTimeout(() => {
        try { form.querySelector('[name="title"]').focus(); } catch (_) {}
      }, 30);

      if (detailModal && typeof detailModal.hide === 'function') {
        detailModal.hide();
      }

      try {
        setupCategoryWidget(form, {
          chipsSelector: '[data-diary-create-categories]',
          inputSelector: '[data-diary-create-category-input]',
          jsonInputSelector: '[data-diary-create-categories-json]',
          initial: []
        });
        loadDiaryCategoryHints();
      } catch (_) {}
    }

    // Header controls for create modal
    (function wireCreateHeaderControls() {
      const createMarkdownToggle = modalEl.querySelector('[data-diary-markdown-toggle]');
      const createEditToggle = modalEl.querySelector('[data-diary-edit-toggle]');
      const createSaveBtn = modalEl.querySelector('[data-diary-save-btn]');
      const createCancelBtn = modalEl.querySelector('[data-diary-cancel-btn]');
      const previewWrap = modalEl.querySelector('[data-diary-create-preview]');

      const updateCreatePreview = () => {
        const enabled = createMarkdownToggle.checked;
        if (!previewWrap) return;
        if (enabled) previewWrap.style.display = '', previewWrap.innerHTML = RichText.renderInlineContent(contentInput.value || '', 'create', true);
        else previewWrap.style.display = 'none', previewWrap.innerHTML = '';
      };

      if (createMarkdownToggle) createMarkdownToggle.addEventListener('change', updateCreatePreview);

      if (createEditToggle) {
        createEditToggle.addEventListener('click', () => {
          if (!previewWrap) return;
          if (previewWrap.style.display === '') {
            previewWrap.style.display = 'none';
          } else {
            previewWrap.style.display = '';
            previewWrap.innerHTML = RichText.renderInlineContent(contentInput.value || '', 'create', createMarkdownToggle.checked);
          }
        });
      }

      if (createCancelBtn) {
        createCancelBtn.addEventListener('click', () => {
          form.reset();
          if (previewWrap) previewWrap.style.display = 'none';
          if (bsModal) bsModal.hide();
        });
      }

      if (createSaveBtn) {
        createSaveBtn.addEventListener('click', () => { if (submitBtn) submitBtn.click(); });
      }
    })();

    async function persist(fd) {
      const id = idInput.value.trim();
      const payload = Object.fromEntries(fd.entries());
      if (payload.id) delete payload.id;
      if (payload.categories) {
        try {
          const arr = JSON.parse(payload.categories || '[]');
          if (Array.isArray(arr) && arr.length) payload.category = arr.join(', ');
        } catch (_) {}
        delete payload.categories;
      }

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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (window.flash) window.flash('Entry saved', 'success');
        apiList();
      } catch (err) {
        console.error('Save failed', err);
        if (window.flash) window.flash('Failed to save', 'danger');
      }
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      persist(fd);
      if (bsModal) bsModal.hide();
    });

    btnNew.addEventListener('click', openCreateModal);

    // --- Filters & Sorting -------------------------------------------------------
    function updateActiveFilterChips() {
      const chips = [];
      if (state.category) chips.push(`<span class='badge text-bg-info text-dark'>Cat: ${state.category}</span>`);
      if (state.q) chips.push(`<span class='badge text-bg-dark'>Q: ${state.q}</span>`);
      activeFiltersBar.innerHTML = chips.join(' ');
      activeFiltersBar.style.display = chips.length ? 'flex' : 'none';
    }

    function currentSortLabelText() { const map = { created_desc: 'Newest', created_asc: 'Oldest' }; return map[state.sort] || 'Sort'; }
    function updateSortLabel() { const el = document.getElementById('currentSortLabel'); if (el) el.textContent = currentSortLabelText(); }
    function updateSortMenuActive() { const menu = document.getElementById('sortMenu'); if (!menu) return; menu.querySelectorAll('[data-sort]').forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-sort') === state.sort)); }

    async function persistDiarySort(s) { try { await App.utils.fetchJSONUnified('/api/sort-pref', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'diary', sort: s }) }); } catch (_) {} }

    const diarySortMenu = document.getElementById('sortMenu');
    if (diarySortMenu) {
      const sortButtons = diarySortMenu.querySelectorAll('[data-sort]');
      sortButtons.forEach(el => {
        el.addEventListener('click', (ev) => {
          ev.preventDefault();
          const s = el.getAttribute('data-sort');
          if (!s) return;
          state.sort = s;
          state.sortExplicit = true;
          updateSortLabel();
          updateSortMenuActive();
          apiList();
          persistDiarySort(s);
        });
      });
    }

  filterToggle.addEventListener('click', () => document.getElementById('diaryInlineFilters').classList.toggle('d-none'));
  btnDiaryApplyFilters.addEventListener('click', () => { state.q = searchEl.value.trim(); state.category = categorySel.value || ''; apiList(); });
  btnClearFilters.addEventListener('click', () => { searchEl.value = ''; categorySel.value = ''; state.q = ''; state.category = ''; apiList(); });

    function updateFilterBtnActive() { const active = !!(state.q || state.category); if (filterToggle) { filterToggle.classList.toggle('btn-primary', active); filterToggle.classList.toggle('btn-outline-secondary', !active); } }

    // --- Detail modal rendering & editing ---------------------------------------
    function safeFormatDate(dateValue) { if (!dateValue) return 'Unknown date'; const dt = globalThis.SiteDate.parse(dateValue); if (!dt) return 'Invalid date'; return globalThis.SiteDate.toDateTimeString(dt); }

    function switchToView() {
      if (!detailModalEl) return;
      const root = detailModalEl.querySelector('[data-diary-detail-root]');
      if (!root) return;

      const editForm = root.querySelector('[data-diary-detail-edit-form]');
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

    function switchToEdit() {
      if (!detailModalEl) return;
      const root = detailModalEl.querySelector('[data-diary-detail-root]');
      if (!root) return;

      const editForm = root.querySelector('[data-diary-detail-edit-form]');
      const editBtn = detailModalEl.querySelector('[data-diary-detail-edit-btn]');
      const saveBtn = detailModalEl.querySelector('[data-diary-detail-save-btn]');
      const cancelBtn = detailModalEl.querySelector('[data-diary-detail-cancel-btn]');
      const contentEl = root.querySelector('[data-diary-detail-content]');

      if (!editForm) return;
      editForm.classList.remove('d-none');
      if (contentEl) contentEl.classList.add('d-none');
      if (editBtn) editBtn.classList.add('d-none');
      if (saveBtn) saveBtn.classList.remove('d-none');
      if (cancelBtn) cancelBtn.classList.remove('d-none');

      try {
        const t = editForm.querySelector('[data-diary-detail-edit-title]');
        if (t) t.focus();
      } catch (_) {}
    }

    let markdownPreference = null; function getMarkdownPreference() { if (markdownPreference === null) markdownPreference = localStorage.getItem('diary-markdown-enabled') === 'true'; return markdownPreference; }

    const diaryEditStateCache = {}; let hasUnsavedChanges = false;

    function renderDetail(data) {
      if (!detailModalEl) return; const item = data.item || {}; const root = detailModalEl.querySelector('[data-diary-detail-root]'); if (!root) return;
      const currentDiaryId = item._id; root.dataset.currentDiaryId = currentDiaryId; switchToView();

      const titleEl = root.querySelector('[data-diary-detail-title]'); if (titleEl) titleEl.textContent = item.title || '(Untitled)';
      const catEl = root.querySelector('[data-diary-detail-category]'); if (catEl) { if (item.category) { catEl.textContent = item.category; catEl.classList.remove('d-none'); BlogHelpers.applyCategoryBadge(catEl, item.category); } else catEl.classList.add('d-none'); }

      const markdownToggle = detailModalEl.querySelector('[data-diary-markdown-toggle]'); const contentEl = root.querySelector('[data-diary-detail-content]');

      function updateContent() { const markdownEnabled = !!(markdownToggle && markdownToggle.checked); if (contentEl) { contentEl.classList.toggle('markdown-content', markdownEnabled); contentEl.innerHTML = RichText.renderInlineContent(item.content || '', item._id, markdownEnabled); } localStorage.setItem('diary-markdown-enabled', markdownEnabled); }

      if (markdownToggle) { markdownToggle.checked = getMarkdownPreference(); markdownToggle.addEventListener('change', updateContent); }
      updateContent();

      const commentsWrap = root.querySelector('[data-diary-comments]');
      if (commentsWrap) {
        const comments = data.comments || [];
        commentsWrap._lastCommentsData = comments;

        const ikThumb = (url) => {
          if (ImageUploader) return ImageUploader.thumbTransform(url, 320, 320, false);
          return url;
        };

        BlogHelpers.renderComments(commentsWrap, comments, {
          item,
          deleteEndpointPrefix: '/api/diary-comments/',
          thumbTransform: ikThumb,
          markdownToggleSelector: '[data-diary-markdown-toggle]',
          onDeleted: (id) => openDetailModal(id)
        });

        if (markdownToggle) {
          markdownToggle.addEventListener('change', () => {
            updateContent();
            if (commentsWrap._lastCommentsData) {
              BlogHelpers.renderComments(commentsWrap, commentsWrap._lastCommentsData, {
                item,
                deleteEndpointPrefix: '/api/diary-comments/',
                thumbTransform: ikThumb,
                markdownToggleSelector: '[data-diary-markdown-toggle]',
                onDeleted: (id) => openDetailModal(id)
              });
            }
          });
        }
      }

      const limitEl = root.querySelector('[data-diary-comment-limit]'); if (limitEl) limitEl.textContent = `${(data.comment_max || 4000)} chars max`;
      const formC = root.querySelector('[data-diary-comment-form]'); if (formC) formC.dataset.diaryId = item._id;

      const editForm = root.querySelector('[data-diary-detail-edit-form]');
      if (editForm) {
        editForm.dataset.diaryId = currentDiaryId || '';
        if (currentDiaryId && diaryEditStateCache[currentDiaryId]) {
          const cached = diaryEditStateCache[currentDiaryId];
          editForm.querySelector('[data-diary-detail-edit-title]').value = cached.title || '';
          const cachedCats = (cached.category && typeof cached.category === 'string') ? cached.category.split(',').map(s => s.trim()).filter(Boolean) : [];
          setupCategoryWidget(editForm, { chipsSelector: '[data-diary-detail-categories]', inputSelector: '[data-diary-detail-category-input]', jsonInputSelector: '[data-diary-detail-categories-json]', initial: cachedCats });
          editForm.querySelector('[data-diary-detail-edit-content]').value = cached.content || '';
          if (cached.isEditing) switchToEdit(); else switchToView();
        } else {
          editForm.querySelector('[data-diary-detail-edit-title]').value = item.title || '';
          const initialCats = Array.isArray(item.category) ? [...item.category] : (item.category ? [item.category] : []);
          setupCategoryWidget(editForm, { chipsSelector: '[data-diary-detail-categories]', inputSelector: '[data-diary-detail-category-input]', jsonInputSelector: '[data-diary-detail-categories-json]', initial: initialCats });
          editForm.querySelector('[data-diary-detail-edit-content]').value = item.content || '';
          loadDiaryCategoryHints();
          switchToView();
        }

        // Inline image uploader for edit form
        if (!editForm._inlineImgBound) {
          editForm._inlineImgBound = true;
          const editContent = editForm.querySelector('[data-diary-detail-edit-content]');
          const editFileInput = editForm.querySelector('[data-diary-edit-content-image]');
          const editTrigger = editForm.querySelector('[data-diary-edit-content-image-trigger]');

          BlogHelpers.attachInlineImageUploader({
            contentEl: editContent,
            fileInput: editFileInput,
            trigger: editTrigger,
            uploadEndpoint: '/api/diary-images'
          });
        }
      }

      // Header control wiring (delegated click to avoid duplicate handlers)
      if (!detailModalEl._headerClickBound) {
        detailModalEl._headerClickBound = true;
        detailModalEl.addEventListener('click', (e) => {
          const rootInner = detailModalEl.querySelector('[data-diary-detail-root]');

          if (e.target.closest('[data-diary-detail-edit-btn]')) {
            try { switchToEdit(); } catch (_) {}
          }

          if (e.target.closest('[data-diary-detail-cancel-btn]')) {
            const diaryId = (rootInner && rootInner.dataset) ? rootInner.dataset.currentDiaryId : undefined;
            if (diaryId) clearEditStateFromCache(diaryId);
            try { switchToView(); } catch (_) {}
            if (diaryId) openDetailModal(diaryId);
          }

          if (e.target.closest('[data-diary-detail-save-btn]')) {
            const matched = e.target.closest('[data-diary-detail-save-btn]');
            const canonicalSaveBtn = detailModalEl.querySelector('[data-diary-detail-save-btn]');
            if (matched && matched === canonicalSaveBtn) return; // let canonical handler run
            try {
              const editFormInner = rootInner ? rootInner.querySelector('[data-diary-detail-edit-form]') : null;
              if (editFormInner) diaryPerformDetailSave(editFormInner);
            } catch (_) {}
          }
        });
      }
    }

    async function openDetailModal(id) {
      try {
        const data = await App.utils.fetchJSONUnified(`/api/diary/${id}/detail`, { dedupe: true });
  try { renderDetail(data); } catch (renderError) { console.error('Error rendering diary detail:', renderError); window.flash('Error displaying diary entry', 'danger'); return; }
        closeOtherModals(); if (detailModal) detailModal.show();
  } catch (err) { console.error('Failed to load diary detail:', err); window.flash(`Failed to load: ${err.message || 'Unknown error'}`, 'danger'); }
    }

    // --- Detail save / edit-state cache -----------------------------------------
    async function diaryPerformDetailSave(editForm) {
      if (!editForm) return; const diaryId = editForm.dataset.diaryId; if (!diaryId) return;
      const fd = new FormData(editForm); const patch = {}; fd.forEach((v, k) => { patch[k] = v.toString(); });
      if (patch.categories) { try { const arr = JSON.parse(patch.categories || '[]'); patch.category = Array.isArray(arr) && arr.length ? arr.join(', ') : ''; } catch (_) { patch.category = '' } delete patch.categories; }
      if (patch.due_date === '') patch.due_date = null; if (patch.category === '') patch.category = null;

      const originalItem = state.items.find(it => it._id === diaryId) || {};
      const origCategoryStr = Array.isArray(originalItem.category) ? originalItem.category.join(', ') : (originalItem.category || '');
      const minimal = {};
      if ((patch.title || '') !== (originalItem.title || '')) minimal.title = (patch.title === '') ? null : patch.title;
      if ((patch.content || '') !== (originalItem.content || '')) minimal.content = (patch.content === '') ? null : patch.content;
      if ((patch.category == null ? '' : patch.category) !== origCategoryStr) minimal.category = (patch.category === '' ? null : patch.category);
  if (!Object.keys(minimal).length) { window.flash('No changes to save', 'warning'); return; }
      try {
        await App.utils.fetchJSONUnified(`/api/diary/${diaryId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(minimal) });
        window.flash('Updated', 'success'); clearEditStateFromCache(diaryId); try { switchToView(); } catch (_) {} openDetailModal(diaryId); apiList();
      } catch (err) { console.error('Detail update failed', err); window.flash('Update failed', 'danger'); }
    }

    function saveEditStateToCache(diaryId, root) {
      const editForm = root.querySelector('[data-diary-detail-edit-form]'); if (!editForm) return;
      const isEditing = !editForm.classList.contains('d-none'); const title = editForm.querySelector('[data-diary-detail-edit-title]').value;
      let category = ''; const jsonInp = editForm.querySelector('[data-diary-detail-categories-json]'); if (jsonInp && jsonInp.value) { try { const arr = JSON.parse(jsonInp.value || '[]'); if (Array.isArray(arr) && arr.length) category = arr.join(', '); } catch (_) { category = ''; } }
      const content = editForm.querySelector('[data-diary-detail-edit-content]').value;
      const originalItem = state.items.find(item => item._id === diaryId);
      const hasChanges = !originalItem || title !== (originalItem.title || '') || category !== (Array.isArray(originalItem.category) ? (originalItem.category.join(', ') || '') : (originalItem.category || '')) || content !== (originalItem.content || '');
      if (hasChanges || isEditing) { diaryEditStateCache[diaryId] = { isEditing, title, category, content, hasChanges }; updateUnsavedChangesFlag(); } else { delete diaryEditStateCache[diaryId]; updateUnsavedChangesFlag(); }
    }

    function updateUnsavedChangesFlag() { hasUnsavedChanges = Object.values(diaryEditStateCache).some(s => !!s.hasChanges); const originalTitle = document.title.replace(/^◌\s*/, ''); document.title = hasUnsavedChanges ? `◌ ${originalTitle}` : originalTitle; }
    function clearEditStateFromCache(diaryId) { delete diaryEditStateCache[diaryId]; updateUnsavedChangesFlag(); }
    function hasAnyUnsavedChanges() { return hasUnsavedChanges; }
    function hasUnsavedChangesForDiary(diaryId) { return !!(diaryEditStateCache[diaryId] && diaryEditStateCache[diaryId].hasChanges); }
    function getDiariesWithUnsavedChanges() { return Object.keys(diaryEditStateCache).filter(id => diaryEditStateCache[id].hasChanges); }

    // Navigation warnings and debounce helper
    BlogHelpers.setupNavigationWarnings(() => hasAnyUnsavedChanges());
    const debounce = BlogHelpers.debounce;

    // --- Detail comment form: image attach, drafts --------------------------------
    if (detailModalEl) {
      const root = detailModalEl.querySelector('[data-diary-detail-root]');
      const formC = root.querySelector('[data-diary-comment-form]');
      if (formC) {
        const diaryDrafts = {};
        const trigger = formC.querySelector('[data-diary-comment-image-trigger]');
        const fileInput = formC.querySelector('[data-diary-comment-image]');
        const clearBtn = formC.querySelector('[data-diary-comment-images-clear]');
        const previewWrap = formC.querySelector('[data-diary-comment-images-preview]');
        let images = [];

        function renderPreviews() {
          if (!previewWrap) return;
          if (!images.length) {
            previewWrap.innerHTML = '';
            if (clearBtn) clearBtn.classList.add('d-none');
            return;
          }

          previewWrap.innerHTML = images.map((u, i) => {
            return (`<div class='position-relative' style='width:90px;height:90px;border:1px solid var(--border-color);border-radius:4px;overflow:hidden;'>` +
              `<img src='${u}' style='object-fit:cover;width:100%;height:100%;'/>` +
              `<button type='button' class='btn btn-sm btn-danger position-absolute top-0 end-0 py-0 px-1' data-remove='${i}' title='Remove'><i class='fa-solid fa-xmark' aria-hidden='true'></i></button>` +
            `</div>`);
          }).join('');

          if (clearBtn) clearBtn.classList.remove('d-none');

          previewWrap.querySelectorAll('[data-remove]').forEach(b => {
            b.addEventListener('click', () => {
              const idx = parseInt(b.getAttribute('data-remove'), 10);
              if (!isNaN(idx)) {
                images.splice(idx, 1);
                renderPreviews();
              }
            });
          });
        }

        async function uploadDataUrl(dataUrl, label) {
          try { const res = await App.utils.fetchJSONUnified('/api/diary-images', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl }) }); images.push(res.url); renderPreviews(); window.flash(label + ' image ready', 'info'); } catch (_) { window.flash(label + ' upload failed', 'danger'); }
        }

        function handleFiles(fileList, label) {
          const files = Array.from(fileList || []);
          files.forEach(f => {
            if (!f.type.startsWith('image/')) return;
            if (f.size > 16 * 1024 * 1024) {
              if (window.flash) window.flash('Image too large', 'warning');
              return;
            }
            const r = new FileReader();
            r.onload = () => uploadDataUrl(r.result, label);
            r.readAsDataURL(f);
          });
        }

        trigger && trigger.addEventListener('click', () => fileInput && fileInput.click());
        clearBtn && clearBtn.addEventListener('click', () => { images = []; renderPreviews(); });
        fileInput && fileInput.addEventListener('change', () => { handleFiles(fileInput.files, 'Selected'); fileInput.value = ''; });

        document.addEventListener('paste', (e) => {
          if (!detailModalEl.classList.contains('show')) return;
          const active = document.activeElement;
          if (!formC.contains(active)) return;

          const items = (e.clipboardData && e.clipboardData.items) ? e.clipboardData.items : [];
          const files = [];
          for (const it of items) {
            const itType = it.type;
            if (itType && itType.startsWith('image/')) {
              const f = it.getAsFile();
              if (f) files.push(f);
            }
          }

          if (files.length) handleFiles(files, 'Pasted');
        });

        detailModalEl.addEventListener('show.bs.modal', () => { const did = formC.dataset.diaryId; if (!did) return; const d = diaryDrafts[did]; if (d) { formC.querySelector('[name="body"]').value = d.body || ''; images = Array.from(d.images || []); renderPreviews(); } });

        formC.addEventListener('input', () => { const did = formC.dataset.diaryId; if (!did) return; diaryDrafts[did] = diaryDrafts[did] || {}; diaryDrafts[did].body = formC.querySelector('[name="body"]').value; diaryDrafts[did].images = [...images]; });

  const obs = new MutationObserver(() => { const did = formC.dataset.diaryId; if (!did) return; const d = diaryDrafts[did] || {}; formC.querySelector('[name="body"]').value = d.body || ''; images = Array.from(d.images || []); renderPreviews(); });
        obs.observe(formC, { attributes: true, attributeFilter: ['data-diary-id'] });

  formC.addEventListener('submit', async e => { e.preventDefault(); const diaryId = formC.dataset.diaryId; if (!diaryId) return; const fd = new FormData(formC); const bodyRaw = fd.get('body'); const body = bodyRaw ? bodyRaw.toString().trim() : ''; if (!body && !images.length) return; try { await App.utils.fetchJSONUnified(`/api/diary/${diaryId}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, images }) }); formC.reset(); images = []; renderPreviews(); delete diaryDrafts[diaryId]; openDetailModal(diaryId); } catch (_) {} });
      }

      // Ensure we save edit state on modal hide and reset to view
      detailModalEl.addEventListener('hide.bs.modal', () => { try { const root = detailModalEl.querySelector('[data-diary-detail-root]'); const did = root?.dataset.currentDiaryId; if (did) saveEditStateToCache(did, root); } catch (_) {} switchToView(); });
    }

    // --- Create modal inline image handling -------------------------------------
    if (contentInput) {
      const fileInput = modalEl.querySelector('[data-diary-content-image]');
      const trigger = modalEl.querySelector('[data-diary-content-image-trigger]');
      trigger && trigger.addEventListener('click', () => fileInput && fileInput.click());

      async function uploadContentFiles(files, label) {
        for (const f of files) {
          if (!f.type.startsWith('image/')) continue;
          if (f.size > 16 * 1024 * 1024) {
            if (window.flash) window.flash('Image too large', 'warning');
            continue;
          }

          const placeholder = '\n![uploading]()';
          const start = contentInput.selectionStart;
          const end = contentInput.selectionEnd;
          const orig = contentInput.value;
          contentInput.value = orig.slice(0, start) + placeholder + orig.slice(end);
          contentInput.selectionStart = contentInput.selectionEnd = start + placeholder.length;

          const r = new FileReader();
          r.onload = async () => {
            try {
              const res = await App.utils.fetchJSONUnified('/api/diary-images', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: r.result })
              });
              contentInput.value = contentInput.value.replace('![uploading]()', `![img](${res.url})`);
            } catch (_) {
              contentInput.value = contentInput.value.replace('![uploading]()', '(image failed)');
            }
          };
          r.readAsDataURL(f);
        }
      }

      if (fileInput) {
        fileInput.addEventListener('change', () => {
          uploadContentFiles(Array.from(fileInput.files || []), 'Selected');
          fileInput.value = '';
        });
      }

      contentInput.addEventListener('paste', (e) => {
        const clipboard = e.clipboardData;
        const items = (clipboard && clipboard.items) ? clipboard.items : [];
        const files = [];
        for (const it of items) {
          const itType = it.type;
          if (itType && itType.indexOf('image/') === 0) {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        }
        if (files.length) {
          e.preventDefault();
          uploadContentFiles(files, 'Pasted');
        }
      });

      contentInput.addEventListener('dragover', (e) => { e.preventDefault(); });

      contentInput.addEventListener('drop', (e) => {
        e.preventDefault();
        const dt = e.dataTransfer;
        const files = dt && dt.files ? Array.from(dt.files) : [];
        if (files.length) uploadContentFiles(files, 'Dropped');
      });
    }

    // Modal cleanup hookup
    CommentFormatter.setupModalCleanup(modalEl, ['[data-diary-form]']);
    CommentFormatter.setupModalCleanup(detailModalEl, ['[data-diary-comment-form]']);

    // Auto-save edit state while editing (debounced)
    // - Debounce avoids frequent writes while the user types.
    // - File input changes are treated as edits and will schedule a save.
    if (detailModalEl) {
      const root = detailModalEl.querySelector('[data-diary-detail-root]');
      const editForm = root ? root.querySelector('[data-diary-detail-edit-form]') : null;
      if (editForm && !editForm._autoSaveBound) {
        editForm._autoSaveBound = true;

        // Debounced saver: wait for quiet period before persisting edit state to cache
        const debouncedSave = debounce(() => {
          const did = root && root.dataset ? root.dataset.currentDiaryId : undefined;
          if (!did) return;
          // Only save when the edit form is visible (user is actively editing)
          if (!editForm.classList.contains('d-none')) {
            saveEditStateToCache(did, root);
          }
        }, 500);

        // Wire standard input events to mark unsaved and schedule a debounced save
        editForm.addEventListener('input', (e) => {
          hasUnsavedChanges = true;
          debouncedSave();
        });

        // Any file inputs should also mark unsaved and schedule a save
        const fileInputs = editForm.querySelectorAll('input[type=file]');
        if (fileInputs && fileInputs.length) {
          fileInputs.forEach(fi => fi.addEventListener('change', () => {
            hasUnsavedChanges = true;
            debouncedSave();
          }));
        }
      }
    }

    // Initial load
    apiList();
  })();