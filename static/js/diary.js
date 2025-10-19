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
        if (dl && dl.dataset.loaded === '1') {
          // Already loaded: ensure local cache is populated from existing options if empty
          if (!diaryCategoryHints || diaryCategoryHints.length === 0) {
            try { diaryCategoryHints = Array.from(dl.querySelectorAll('option')).map(o => o.value).filter(Boolean).slice(0, 200); } catch (_) {}
          }
          return;
        }
        const data = await App.utils.fetchJSONUnified('/api/diary-categories', { dedupe: true });
        diaryCategoryHints = (data.items || []).map(c => c.name).filter(Boolean).slice(0, 200);
        if (dl) {
          dl.innerHTML = diaryCategoryHints.map(n => `<option value="${n}"></option>`).join('');
          dl.dataset.loaded = '1';
        }
      } catch (err) {
        console.warn('loadDiaryCategoryHints failed', err);
        try {
          // Fallback: read any server-rendered options so typeahead still works offline
          const dl = document.getElementById('diaryCategoriesGlobal');
          if (dl) diaryCategoryHints = Array.from(dl.querySelectorAll('option')).map(o => o.value).filter(Boolean).slice(0, 200);
        } catch (_) {}
      }
    }

    function truncateText(txt, lim = 300) { return (!txt) ? '' : (txt.length > lim ? txt.slice(0, lim) + '…' : txt); }

    // Per-entry controller to isolate state for the currently opened diary in the detail modal.
    class DiaryDetailController {
      static forForm(editForm) {
        if (!editForm._controller) editForm._controller = new DiaryDetailController(editForm);
        return editForm._controller;
      }
      constructor(editForm) {
        this.form = editForm;
        this.id = editForm?.dataset?.diaryId || null;
        this.canonical = { title: '', content: '', cats: [] };
        this.widget = null;
      }
      setId(id) { this.id = id; }
      setCanonical(item) {
        this.canonical = {
          title: item?.title || '',
          content: item?.content || '',
          cats: BlogHelpers.categoryToArray(item?.category)
        };
      }
      ensureWidget(initialCats) {
        try {
          this.widget = BlogHelpers.setupCategoryWidget(this.form, {
            chipsSelector: '[data-diary-detail-categories]',
            inputSelector: '[data-diary-detail-category-input]',
            jsonInputSelector: '[data-diary-detail-categories-json]',
            initial: Array.isArray(initialCats) ? initialCats : [],
            ensureLoaded: () => loadDiaryCategoryHints(),
            getHints: () => diaryCategoryHints
          });
        } catch (_) { this.widget = null; }
        return this.widget;
      }
      readCurrent() {
        const fd = new FormData(this.form);
        const obj = {};
        fd.forEach((v, k) => { obj[k] = v; });
        // categories is JSON array in hidden input
  const catsArr = BlogHelpers.normalizeCatsInput(obj.categories);
        return {
          title: (obj.title || '').toString(),
          content: (obj.content || '').toString(),
          category: catsArr.length ? catsArr : null
        };
      }
      buildMinimalPatch() {
        const current = this.readCurrent();
        const minimal = {};
        if ((current.title || '') !== (this.canonical.title || '')) minimal.title = (current.title === '') ? null : current.title;
        if ((current.content || '') !== (this.canonical.content || '')) minimal.content = (current.content === '') ? null : current.content;
  const origCats = Array.isArray(this.canonical.cats) ? this.canonical.cats : [];
  const curCats = BlogHelpers.normalizeCatsInput(current.category);
        if (JSON.stringify(origCats) !== JSON.stringify(curCats)) {
          minimal.category = curCats.length ? curCats : null;
        }
        return Object.keys(minimal).length ? minimal : null;
      }
    }

    // Use shared helpers for chips and widget when editing/creating categories

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
      if (listEl) App.utils.tools.del_child(listEl);
      if (!state.items.length) {
        if (listEl) {
          App.utils.tools.del_child(listEl);
          listEl.innerHTML = '<div class="text-muted small fst-italic">No entries.</div>';
        }
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
  BlogHelpers.renderCategoryBadges(cat, it.category);
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
        BlogHelpers.setupCategoryWidget(form, {
          chipsSelector: '[data-diary-create-categories]',
          inputSelector: '[data-diary-create-category-input]',
          jsonInputSelector: '[data-diary-create-categories-json]',
          addBtnSelector: '[data-diary-create-add-btn]',
          initial: [],
          ensureLoaded: () => loadDiaryCategoryHints(),
          getHints: () => diaryCategoryHints
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
        if (!previewWrap) return;
        const enabled = createMarkdownToggle.checked;
        if (enabled) {
          previewWrap.style.display = '';
          previewWrap.innerHTML = RichText.renderInlineContent(contentInput.value || '', 'create', true);
        } else {
          previewWrap.style.display = 'none';
          App.utils.tools.del_child(previewWrap);
        }
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
          if (Array.isArray(arr)) payload.category = arr.length ? arr : null;
        } catch (_) { payload.category = null; }
        delete payload.categories;
      }

      if (!payload.content && !payload.title) return;

      const url = id ? `/api/diary/${id}` : '/api/diary';
      const method = id ? 'PATCH' : 'POST';

      if (id) {
        // Normalize empty values: title/content -> null, category -> null when empty
        if ('title' in payload && payload.title === '') payload.title = null;
        if ('content' in payload && payload.content === '') payload.content = null;
        if ('category' in payload && (!payload.category || (Array.isArray(payload.category) && payload.category.length === 0))) payload.category = null;
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
  function updateSortLabel() { const el = document.getElementById('diaryCurrentSortLabel'); if (el) el.textContent = currentSortLabelText(); }
  function updateSortMenuActive() { const menu = document.getElementById('diarySortMenu'); if (!menu) return; menu.querySelectorAll('[data-sort]').forEach(btn => btn.classList.toggle('active', btn.getAttribute('data-sort') === state.sort)); }

    async function persistDiarySort(s) { try { await App.utils.fetchJSONUnified('/api/sort-pref', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'diary', sort: s }) }); } catch (_) {} }

  const diarySortMenu = document.getElementById('diarySortMenu');
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

  filterToggle.addEventListener('click', () => {
    const box = document.getElementById('diaryInlineFilters');
    box.classList.toggle('d-none');
    // When showing filters, preload category hints for the datalist
    if (!box.classList.contains('d-none')) {
      try { loadDiaryCategoryHints(); } catch (_) {}
      try {
        BlogHelpers.setupFilterTypeahead(categorySel, {
          getHints: () => diaryCategoryHints,
          ensureLoaded: () => loadDiaryCategoryHints(),
          limit: 8,
          zIndex: 1051
        });
      } catch (_) {}
    }
  });
  btnDiaryApplyFilters.addEventListener('click', () => { state.q = searchEl.value.trim(); state.category = categorySel.value || ''; apiList(); });
  btnClearFilters.addEventListener('click', () => { searchEl.value = ''; categorySel.value = ''; state.q = ''; state.category = ''; apiList(); });
  // Provide hints when category filter input gains focus and ensure typeahead is bound
  if (categorySel) categorySel.addEventListener('focus', () => { try { BlogHelpers.setupFilterTypeahead(categorySel, { getHints: () => diaryCategoryHints, ensureLoaded: () => loadDiaryCategoryHints(), limit: 8 }); loadDiaryCategoryHints(); } catch (_) {} });

  // Initialize typeahead early in case filters are already visible
  try { BlogHelpers.setupFilterTypeahead(categorySel, { getHints: () => diaryCategoryHints, ensureLoaded: () => loadDiaryCategoryHints(), limit: 8 }); } catch (_) {}

    function updateFilterBtnActive() { const active = !!(state.q || state.category); if (filterToggle) { filterToggle.classList.toggle('btn-primary', active); filterToggle.classList.toggle('btn-outline-secondary', !active); } }

    // --- Detail modal rendering & editing ---------------------------------------
  // Date formatting helper removed (unused)

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
  // Store canonical/original values per diary id to compare when saving.
  const diaryCanonical = {};

    function renderDetail(data) {
      if (!detailModalEl) return; const item = data.item || {}; const root = detailModalEl.querySelector('[data-diary-detail-root]'); if (!root) return;
      const currentDiaryId = item._id; root.dataset.currentDiaryId = currentDiaryId; switchToView();

      const titleEl = root.querySelector('[data-diary-detail-title]'); if (titleEl) titleEl.textContent = item.title || '(Untitled)';
      const catEl = root.querySelector('[data-diary-detail-category]');
      if (catEl) {
        // Normalize and render multiple badges for category display. The
        // stored category may be an array or a comma-joined string.
        let cats = [];
        if (Array.isArray(item.category)) cats = item.category.slice();
        else if (typeof item.category === 'string' && item.category.trim()) cats = item.category.split(',').map(s => s.trim()).filter(Boolean);
        if (cats.length) {
          if (cats.length === 1) {
            // single category: reuse the template badge element
            const name = cats[0];
            App.utils.tools.del_child(catEl);
            try { window.BlogHelpers && window.BlogHelpers.applyCategoryBadge(catEl, name); } catch (_) {}
            catEl.textContent = name;
            catEl.classList.remove('d-none');
          } else {
            // multiple categories: convert template badge into neutral container
            BlogHelpers.stripBadgeLikeClasses(catEl);
            App.utils.tools.del_child(catEl);
            for (const name of cats) {
              const wrapper = document.createElement('span');
              wrapper.className = 'badge me-1 mb-1 d-inline-flex align-items-center py-1 px-2 tag-badge';
              BlogHelpers.applyCategoryBadge(wrapper, name);
              wrapper.style.fontSize = '0.9em';
              const text = document.createElement('span');
              text.textContent = name;
              text.style.whiteSpace = 'nowrap';
              wrapper.appendChild(text);
              catEl.appendChild(wrapper);
            }
            catEl.classList.remove('d-none');
          }
        } else {
          catEl.classList.add('d-none');
        }
      }

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
        const controller = DiaryDetailController.forForm(editForm);
        controller.setId(currentDiaryId);
  controller.setCanonical(item);
        // Record canonical/original values on inputs so we can tell if a user
        // actually changed a value vs. leaving it alone. This prevents the
        // 'only edit content' case from accidentally nulling title/categories.
        const canonicalTitle = item.title || '';
        const canonicalContent = item.content || '';
  // Normalize stored category into an array. The DB may contain either
  // a single string (possibly comma-separated) or an array. Split on
  // commas for legacy comma-joined values so the UI shows separate
  // chips and a user can remove them individually.
  let canonicalCatsArr;
  if (Array.isArray(item.category)) canonicalCatsArr = [...item.category];
  else if (typeof item.category === 'string' && item.category.trim()) canonicalCatsArr = item.category.split(',').map(s => s.trim()).filter(Boolean);
  else canonicalCatsArr = [];
  const canonicalCatsJson = JSON.stringify(canonicalCatsArr || []);

        if (currentDiaryId && diaryEditStateCache[currentDiaryId]) {
          const cached = diaryEditStateCache[currentDiaryId];
          // Populate editing inputs from cache (if present) or item.
            const titleInput = editForm.querySelector('[data-diary-detail-edit-title]');
            const contentInputEl = editForm.querySelector('[data-diary-detail-edit-content]');
            titleInput.value = (cached.title !== undefined ? cached.title : canonicalTitle) || '';
            const cachedCats = (cached.category && typeof cached.category === 'string') ? cached.category.split(',').map(s => s.trim()).filter(Boolean) : [];
            controller.ensureWidget(cachedCats);
            contentInputEl.value = (cached.content !== undefined ? cached.content : canonicalContent) || '';

            // Save canonical originals into diaryCanonical map
            try { diaryCanonical[currentDiaryId] = { title: canonicalTitle, content: canonicalContent, catsJson: canonicalCatsJson, catsStr: (canonicalCatsArr || []).join(', ') }; } catch (_) {}

          if (cached.isEditing) switchToEdit(); else switchToView();
        } else {
          const titleInput = editForm.querySelector('[data-diary-detail-edit-title]');
          const contentInputEl = editForm.querySelector('[data-diary-detail-edit-content]');
          titleInput.value = canonicalTitle;
          const initialCats = canonicalCatsArr;
          controller.ensureWidget(initialCats);
          contentInputEl.value = canonicalContent;
          loadDiaryCategoryHints();
          switchToView();

          // Save canonical originals into diaryCanonical map
          try { diaryCanonical[currentDiaryId] = { title: canonicalTitle, content: canonicalContent, catsJson: canonicalCatsJson, catsStr: (canonicalCatsArr || []).join(', ') }; } catch (_) {}
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

        // Ensure the canonical (header) Save button actually triggers the save.
        // The delegated click above ignores clicks on the canonical button so a
        // direct listener must exist. Bind it once here.
        try {
          const canonicalSaveBtn = detailModalEl.querySelector('[data-diary-detail-save-btn]');
          if (canonicalSaveBtn && !canonicalSaveBtn._diarySaveBound) {
            canonicalSaveBtn._diarySaveBound = true;
            canonicalSaveBtn.addEventListener('click', (ev) => {
              ev.preventDefault();
              const rootInner = detailModalEl.querySelector('[data-diary-detail-root]');
              const editFormInner = rootInner ? rootInner.querySelector('[data-diary-detail-edit-form]') : null;
              if (editFormInner) diaryPerformDetailSave(editFormInner);
            });
          }
        } catch (_) {}
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
        const controller = DiaryDetailController.forForm(editForm);
        const minimal = controller.buildMinimalPatch();
        if (!minimal) { window.flash('No changes to save', 'warning'); return; }
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
  // Expose only minimal unsaved flag API internally; remove unused helpers

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
        if (previewWrap) App.utils.tools.del_child(previewWrap);
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

          const idTag = BlogHelpers.insertUploadingPlaceholder(contentInput);

          const r = new FileReader();
          r.onload = async () => {
            try {
              const res = await App.utils.fetchJSONUnified('/api/diary-images', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: r.result })
              });
              contentInput.value = contentInput.value.replace(`![uploading-${idTag}]()`, `![img](${res.url})`);
            } catch (_) {
              contentInput.value = contentInput.value.replace(`![uploading-${idTag}]()`, '(image failed)');
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