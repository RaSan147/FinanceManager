// widgets/blog_base.js
// Common base classes for blog-like content (Diary, To‑Do) widgets
// Provides: smart list refresh with diffing, single-flight fetch, and modal helpers

import { BaseWidget } from '/static/js/core/widget.js';

// ===== LIST WIDGET =====

/**
 * BlogBaseListWidget
 * - Handles list fetch, diffing and rendering for blog-like lists (diary, todo, etc.)
 */
export class BlogBaseListWidget extends BaseWidget {
  constructor(root, options) {
    super(root, options);
    this.state = { q: '', category: '', sort: null, sortExplicit: false, items: [] };
    this._hasLoaded = false;
    this._listFetchPromise = null; // single-flight promise for list fetches
    this.changedEvent = options?.changedEvent || null;
  }

  // ===== ELEMENT HELPERS =====

  /** Safe getElementById wrapper */
  byId(id) { return id ? document.getElementById(id) : null; }
  /** querySelector wrapper */
  qs(selector, root = document) { return root.querySelector(selector); }

  // ===== ABSTRACT METHODS =====

  // Abstract methods - concrete widgets must implement these
  buildListUrl(forceFresh) { throw new Error('buildListUrl not implemented'); }
  hydrateItem(node, item) { throw new Error('hydrateItem not implemented'); }
  // Default deep-equality using JSON; widgets can override for perf
  equalItem(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  // ===== DIFF UTILITIES =====

  _sameOrder(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  _computeDiff(prev, next) {
    const prevIds = prev.map(it => it._id);
    const nextIds = next.map(it => it._id);
    const prevMap = new Map(prev.map(it => [it._id, it]));
    const nextMap = new Map(next.map(it => [it._id, it]));

    const removed = prevIds.filter(id => !nextMap.has(id));
    const added = nextIds.filter(id => !prevMap.has(id));
    const stayed = nextIds.filter(id => prevMap.has(id));
    const changed = stayed.filter(id => !this.equalItem(prevMap.get(id), nextMap.get(id)));

    // Determine if order changed for items that remain
    const prevCommon = prevIds.filter(id => nextMap.has(id));
    const nextCommon = nextIds.filter(id => prevMap.has(id));
    const orderChanged = (stayed.length === prevCommon.length)
      ? !this._sameOrder(prevCommon, nextCommon)
      : true;

    const hasChanges = removed.length || added.length || changed.length || orderChanged;
    return { removed, added, changed, orderChanged, hasChanges };
  }

  // ===== FETCH AND RENDER METHODS =====

  /** Fetch the list (single-flight). Applies diff to DOM when appropriate. */
  async fetchList(forceFresh = false) {
    const listEl = this.byId(this.options?.listElId);
    if (this._listFetchPromise) return this._listFetchPromise;

    if (!this._hasLoaded) {
      try {
        if (listEl && App?.utils?.ui?.showLoader) App.utils.ui.showLoader(listEl, { lines: 4 });
      } catch (err) { /* ignore loader errors */ }
    }

    const url = this.buildListUrl(forceFresh);
    // single-flight wrapper
    this._listFetchPromise = (async () => {
      try {
        const data = await App.utils.fetchJSONUnified(url, { dedupe: true });
        return data;
      } finally {
        this._listFetchPromise = null;
      }
    })();

    let data;
    try {
      data = await this._listFetchPromise;
    } catch (err) {
      // network/fetch failed, abort silently
      return;
    }

    if (data?.sort && (!this.state.sortExplicit || data.sort !== this.state.sort)) {
      this.state.sort = data.sort;
      this.updateSortUI?.();
    }

    const incoming = data?.items || [];

    // First load: render everything
    if (!this._hasLoaded) {
      this.state.items = incoming;
      this.renderList();
      this._hasLoaded = true;
      return;
    }

    const prev = this.state.items || [];
    const diff = this._computeDiff(prev, incoming);
    if (!diff.hasChanges) {
      this.state.items = incoming;
      this.updateFiltersUI?.();
      return;
    }

    // show a small inline loader while applying diff
    let refreshLoader = null;
    try {
      refreshLoader = App?.utils?.ui?.createLoader?.({ lines: 3 }) || null;
    } catch (err) { /* ignore */ }
    if (refreshLoader && listEl) listEl.appendChild(refreshLoader);

    try {
      await this._applyDiff(diff, incoming);
      this.state.items = incoming;
      this.updateFiltersUI?.();
    } finally {
      if (refreshLoader && refreshLoader.parentNode) {
        try { refreshLoader.parentNode.removeChild(refreshLoader); } catch (err) { /* ignore */ }
      }
    }
  }

  async _applyDiff(diff, nextItems) {
    const listEl = this.byId(this.options?.listElId);
    const tmpl = this.byId(this.options?.tmplId);
    if (!listEl || !tmpl) return;

    // Map existing DOM children by their data-id
    const nodeById = new Map(Array.from(listEl.children).map(ch => [ch.dataset?.id, ch]));

    // Remove nodes that are no longer present
    for (const id of diff.removed) {
      const node = nodeById.get(id);
      if (node && node.parentNode === listEl) listEl.removeChild(node);
      nodeById.delete(id);
    }

    // Insert or replace/keep nodes according to nextItems order
    for (let i = 0; i < nextItems.length; i++) {
      const item = nextItems[i];
      const existing = nodeById.get(item._id);
      let node;

      if (!existing) {
        node = tmpl.content.firstElementChild.cloneNode(true);
        this.hydrateItem(node, item);
        nodeById.set(item._id, node);
      } else if (diff.changed.includes(item._id)) {
        const fresh = tmpl.content.firstElementChild.cloneNode(true);
        this.hydrateItem(fresh, item);
        listEl.replaceChild(fresh, existing);
        nodeById.set(item._id, fresh);
        node = fresh;
      } else {
        node = existing;
      }

      const anchor = listEl.children[i];
      if (anchor !== node) listEl.insertBefore(node, anchor || null);
    }
  }

  renderList() {
    const listEl = this.byId(this.options?.listElId);
    const tmpl = this.byId(this.options?.tmplId);
    if (!listEl || !tmpl) return;

    App.utils.tools.del_child(listEl);
    const items = this.state.items || [];
    if (!items.length) {
      listEl.innerHTML = '<div class="text-muted small fst-italic">No items.</div>';
      this.updateFiltersUI?.();
      return;
    }

    const frag = document.createDocumentFragment();
    for (const it of items) {
      const node = tmpl.content.firstElementChild.cloneNode(true);
      this.hydrateItem(node, it);
      frag.appendChild(node);
    }

    listEl.appendChild(frag);
    this.updateFiltersUI?.();
  }

  // ===== TOOLBAR BINDING =====

  bindCommonToolbar() {
    const o = this.options || {}; // ids: sortMenuId, sortLabelId, filterToggleId, applyBtnId, clearBtnId, searchId, categoryId, activeFiltersBarId
    const sortMenuEl = this.byId(o.sortMenuId);
    if (sortMenuEl && !sortMenuEl._blogBound) {
      sortMenuEl.querySelectorAll('[data-sort]').forEach(el => {
        if (el._blogBound) return;
        this.on(el, 'click', () => {
          const sortValue = el.getAttribute('data-sort');
          if (!sortValue) return;
          this.state.sort = sortValue;
          this.state.sortExplicit = true;
          this.updateSortUI?.();
          this.fetchList();

          // Persist preference asynchronously; ignore errors
          try {
            App.utils.fetchJSONUnified('/api/sort-pref', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: o.sortPrefName || 'content', sort: sortValue })
            });
          } catch (err) { /* ignore */ }
        });
        el._blogBound = true;
      });
      this.updateSortUI?.();
      sortMenuEl._blogBound = true;
    }

    const filterToggle = this.byId(o.filterToggleId);
    const filterBox = this.byId(o.filterBoxId);
    if (filterToggle && filterBox && !filterToggle._blogBound) {
      this.on(filterToggle, 'click', () => { filterBox.classList.toggle('d-none'); });
      filterToggle._blogBound = true;
    }

    const applyBtn = this.byId(o.applyBtnId);
    const clearBtn = this.byId(o.clearBtnId);
    const searchEl = this.byId(o.searchId);
    const categorySel = this.byId(o.categoryId);

    if (applyBtn && !applyBtn._blogBound) {
      this.on(applyBtn, 'click', () => {
        this.state.q = (searchEl?.value || '').trim();
        this.state.category = categorySel ? (categorySel.value || '') : '';
        this.fetchList();
      });
      applyBtn._blogBound = true;
    }

    if (clearBtn && !clearBtn._blogBound) {
      this.on(clearBtn, 'click', () => {
        if (searchEl) searchEl.value = '';
        if (categorySel) categorySel.value = '';
        this.state.q = '';
        this.state.category = '';
        this.fetchList();
      });
      clearBtn._blogBound = true;
    }

    // Changed event bus
    // Subscribe to external change events (only once)
    if (this.changedEvent && !this._changedBound) {
      const off = App.utils.EventBus?.on?.(this.changedEvent, () => this.fetchList(true));
      if (typeof off === 'function') {
        this._off = (this._off || []);
        this._off.push(off);
      }
      this._changedBound = true;
    }
  }

  // ===== UI UPDATES =====

  updateSortUI() {
    const o = this.options || {};
    const sortMenuEl = this.byId(o.sortMenuId);
    const label = this.byId(o.sortLabelId);

    if (sortMenuEl) {
      sortMenuEl.querySelectorAll('[data-sort]').forEach(el => el.classList.toggle('active', !!this.state.sort && el.getAttribute('data-sort') === this.state.sort));
    }

    if (label) {
      let txt = 'Sort';
      if (this.state.sort) {
        const btn = sortMenuEl ? sortMenuEl.querySelector(`[data-sort="${this.state.sort}"]`) : null;
        txt = btn ? (btn.textContent || 'Sort') : 'Sort';
      }
      label.textContent = txt;
    }
  }

  updateFiltersUI() {
    const o = this.options || {};
    const bar = this.byId(o.activeFiltersBarId);
    const toggle = this.byId(o.filterToggleId);

    if (bar) {
      const chips = [];
      if (this.state.category) chips.push(`<span class='badge text-bg-info text-dark'>Cat: ${this.state.category}</span>`);
      if (this.state.q) chips.push(`<span class='badge text-bg-dark'>Q: ${this.state.q}</span>`);
      bar.innerHTML = chips.join(' ');
      bar.style.display = chips.length ? 'flex' : 'none';
    }

    if (toggle) {
      const active = !!(this.state.q || this.state.category);
      toggle.classList.toggle('btn-primary', active);
      toggle.classList.toggle('btn-outline-secondary', !active);
    }
  }

  // ===== LIFECYCLE METHODS =====

  async mount(root) { super.mount(root); this.bindCommonToolbar(); await this.fetchList(); }
  async refresh() { await this.fetchList(); }
}

// ===== DETAIL WIDGET =====

export class BlogBaseDetailWidget extends BaseWidget {
  constructor(root, options) {
    super(root, options);
    this._detailDisposers = [];
    this._detailFetchPromise = null;
    this._detailFetchId = null;
    this.modal = null;
    // Per-item edit state to prevent leaking edit mode across different items
    this._editingById = new Map();
    // Per-item draft form state for accidental-close/back-and-forth safety
    this._draftById = new Map();
  }

  // ===== ELEMENT HELPERS =====

  byId(id) {
    return id ? document.getElementById(id) : null;
  }

  showModal() {
    const el = this.byId(this.options?.modalId);
    if (!el) return;
    try {
      this.modal = window.bootstrap ? bootstrap.Modal.getOrCreateInstance(el) : this.modal;
      if (this.modal) {
        this.modal.show();
      } else {
        el.style.display = 'block';
      }
    } catch (err) {
      // Fallback if bootstrap modal operations fail
      try { el.style.display = 'block'; } catch (ignoreErr) { /* ignore */ }
    }
  }

  _onDetail(el, evt, fn, opts) {
    if (!el) return () => {};
    const off = this.on(el, evt, fn, opts);
    this._detailDisposers.push(off);
    return off;
  }

  _clearDetailDisposers() {
    while (this._detailDisposers.length) {
      try {
        this._detailDisposers.pop()();
      } catch (err) {
        /* ignore individual disposer errors */
      }
    }
  }

  // ===== RENDERING HELPERS =====

  renderInline(content, itemId, enabled) {
    try {
      return window.RichText?.renderInlineContent?.(content || '', itemId, !!enabled) || '';
    } catch (err) {
      // If rich-text rendering fails, fall back to raw content
      return (content || '');
    }
  }
  renderCategoryBadges(containerEl, categories) {
    if (!containerEl) return;
    try { window.BlogHelpers?.renderCategoryBadges?.(containerEl, categories); } catch(_) {}
    if (containerEl.textContent) { containerEl.classList.remove('d-none'); }
    else { containerEl.classList.add('d-none'); }
  }
  getHintsFromDatalist(datalistId, limit=200) {
    const dl = datalistId ? document.getElementById(datalistId) : null;
    if (!dl) return [];
    try {
      return Array.from(dl.querySelectorAll('option')).map(o => o.value).filter(Boolean).slice(0, limit);
    } catch (err) {
      return [];
    }
  }

  // ===== MARKDOWN TOGGLE =====

  setupMarkdownToggle(opts) {
    const { toggleEl, storageKey, contentEl, raw, itemId, rerenderComments } = opts || {};
    if (!contentEl) return { enabled: false };
    const initial = storageKey ? (localStorage.getItem(storageKey) === 'true') : false;
    if (toggleEl) {
      try {
        toggleEl.checked = initial;
      } catch (err) {
        /* ignore */
      }
    }

    const apply = (enabled) => {
      try {
        contentEl.innerHTML = this.renderInline(raw, itemId, enabled);
      } catch (err) {
        /* ignore render errors */
      }
      if (typeof rerenderComments === 'function') {
        try { rerenderComments(); } catch (err) { /* ignore */ }
      }
    };
    apply(initial);
    if (toggleEl) {
      this._onDetail(toggleEl, 'change', () => {
        const enabled = !!toggleEl.checked;
        if (storageKey) {
          try {
            localStorage.setItem(storageKey, enabled ? 'true' : 'false');
          } catch (err) { /* ignore storage errors */ }
        }
        apply(enabled);
      });
    }
    return { enabled: initial };
  }

  // ===== DATA FETCHING =====

  async _fetchDetailData(id) {
    const url = `${this.options?.detailUrlPrefix || ''}${id}/detail`;
    try {
      return await App.utils.fetchJSONUnified(url, { dedupe: true });
    } catch (err) {
      return null;
    }
  }
  async refreshCommentsOnly(root, id) {
    if (!root || !id) return;
    const entityMatch = (this.options?.detailUrlPrefix || '').match(/\/api\/([^\/]+)\//);
    const entity = entityMatch && entityMatch[1] ? entityMatch[1] : 'content';
    const wrap = root.querySelector(`[data-${entity}-comments]`);
    let miniLoader = null;
    if (wrap) {
      try {
        miniLoader = App?.utils?.ui?.createLoader?.({ lines: 2 }) || null;
      } catch (err) {
        /* ignore loader creation errors */
      }
      if (miniLoader) wrap.appendChild(miniLoader);
    }
    const data = await this._fetchDetailData(id);
    try {
      if (data && wrap) {
        this.renderComments(root, data.comments || [], data.item || { _id: id });
      }
    } finally {
      if (miniLoader && miniLoader.parentNode) {
        try { miniLoader.parentNode.removeChild(miniLoader); } catch (err) { /* ignore */ }
      }
    }
  }

  // ===== COMMENT FORM WIRING =====

  wireCommentForm(formEl, options) {
  if (!formEl) return;
    const { id, uploadEndpoint, selectors, modalId, buildPostUrl, onPosted } = options || {};
    formEl.dataset.itemId = id || formEl.dataset.itemId || '';
    // Attach uploader once per form element
    if (!formEl._imageUploader) {
      try {
        window.ImageUploader?.attachCommentUploader?.({
          formEl,
          uploadEndpoint: uploadEndpoint,
          selectors: selectors,
          pasteScopeEl: modalId ? document.getElementById(modalId) : undefined
        });
      } catch (err) {
        /* ignore image uploader attach errors */
      }
    }
    // Bind submit with per-render disposer
    this._onDetail(formEl, 'submit', async (e) => {
      e.preventDefault();
      const itemId = formEl.dataset.itemId || id;
  if (!itemId || typeof buildPostUrl !== 'function') return;
      const bodyEl = formEl.querySelector('[name="body"]');
      const body = (bodyEl?.value || '').toString().trim();
      const imgs = formEl._imageUploader?.getImages ? formEl._imageUploader.getImages() : [];
      if (!body && !imgs.length) return;
      try {
        await App.utils.fetchJSONUnified(buildPostUrl(itemId), { method:'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ body, images: imgs }) });
        try { formEl.reset(); } catch (err) { /* ignore reset errors */ }
        try { formEl._imageUploader?.reset?.(); } catch (err) { /* ignore */ }
        if (typeof onPosted === 'function') {
          try { await onPosted(itemId); } catch (err) { /* ignore onPosted errors */ }
        } else {
          // Default to partial comments refresh (no full modal flash)
          const rootSel = this.options?.rootSelector || '';
          const modal = this.byId(this.options?.modalId);
          const root = modal ? modal.querySelector(rootSel) : null;
          await this.refreshCommentsOnly(root, itemId);
        }
      } catch (err) {
        window.flash?.('Failed to post comment', 'danger');
      }
    });
  }

  // ===== EDIT CONTROLS =====

  wireEditControls(root, cfg) {
    if (!root || !cfg) return;
    const modal = this.byId(this.options?.modalId);
    const editBtn = modal?.querySelector(cfg.editBtnSelector);
    const saveBtn = modal?.querySelector(cfg.saveBtnSelector);
    const cancelBtn = modal?.querySelector(cfg.cancelBtnSelector);
    const formSel = cfg.formSelector;
    const viewSel = cfg.viewSelector;

    const getId = (form) => cfg.itemIdGetter ? cfg.itemIdGetter(form) : (form?.dataset?.id || form?.dataset?.todoId || form?.dataset?.diaryId || '');

    const captureDraft = (form) => {
      if (!form) return;
      const id = getId(form); if (!id) return;
      const draft = {};
      const els = form.querySelectorAll('input[name], textarea[name], select[name]');
      els.forEach((el) => {
        const name = el.getAttribute('name'); if (!name) return;
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (type === 'checkbox') draft[name] = !!el.checked;
        else if (type === 'radio') { if (el.checked) draft[name] = el.value; }
        else draft[name] = el.value;
      });
      try {
        const jsonInput = form.querySelector('[data-diary-detail-categories-json], [data-todo-detail-categories-json], [data-content-detail-categories-json]');
        const tagInst = jsonInput?._tagWidgetInstance || null;
        if (tagInst?.getList) draft.categories = JSON.stringify(tagInst.getList());
        else if (jsonInput) draft.categories = jsonInput.value || '';
      } catch (err) { /* ignore tag widget errors */ }
      this._draftById.set(id, draft);
    };

    const applyDraft = (form) => {
      if (!form) return;
      const id = getId(form); if (!id) return;
      const draft = this._draftById.get(id); if (!draft) return;
      const els = form.querySelectorAll('input[name], textarea[name], select[name]');
      els.forEach((el) => {
        const name = el.getAttribute('name'); if (!name) return;
        if (!(name in draft)) return;
        const type = (el.getAttribute('type') || '').toLowerCase();
        const val = draft[name];
        if (type === 'checkbox') el.checked = !!val;
        else if (type === 'radio') el.checked = (el.value === val);
        else el.value = val ?? '';
      });
      try {
        const jsonInput = form.querySelector('[data-diary-detail-categories-json], [data-todo-detail-categories-json], [data-content-detail-categories-json]');
        const tagInst = jsonInput?._tagWidgetInstance || null;
        if (tagInst?.setList && draft.categories) {
          const arr = JSON.parse(draft.categories || '[]');
          tagInst.setList(Array.isArray(arr) ? arr : []);
        } else if (jsonInput && draft.categories != null) {
          jsonInput.value = draft.categories;
          try { jsonInput.dispatchEvent(new Event('change', { bubbles: true })); } catch (err) { /* ignore */ }
        }
      } catch (err) { /* ignore tag widget restore errors */ }
    };

    const debounce = (fn, wait = 200) => {
      if (window.BlogHelpers?.debounce) return window.BlogHelpers.debounce(fn, wait);
      let t = null;
      return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
    };
    const persistDraftDebounced = debounce(() => { const f = root.querySelector(formSel); captureDraft(f); }, 200);

    const toggleView = (editing) => {
      const form = root.querySelector(formSel);
      const view = viewSel ? root.querySelector(viewSel) : null;
      if (!form) return;
      if (editing) {
        form.classList.remove('d-none');
        if (view) view.classList.add('d-none');
        editBtn?.classList?.add('d-none');
        saveBtn?.classList?.remove('d-none');
        cancelBtn?.classList?.remove('d-none');
      } else {
        form.classList.add('d-none');
        if (view) view.classList.remove('d-none');
        editBtn?.classList?.remove('d-none');
        saveBtn?.classList?.add('d-none');
        cancelBtn?.classList?.add('d-none');
      }
      try { const id = getId(form); if (id) this._editingById.set(id, !!editing); } catch(_) {}
      try { captureDraft(form); } catch(_) {}
      try {
      if (typeof cfg.onToggle === 'function') {
        cfg.onToggle(!!editing, root);
      }
      } catch(_) {}
    };

  this._onDetail(editBtn, 'click', () => toggleView(true));
  this._onDetail(cancelBtn, 'click', () => toggleView(false));
    this._onDetail(saveBtn, 'click', async () => {
      const form = root.querySelector(formSel);
      if (!form || !cfg.buildPatch || !cfg.saveUrl) return;
      const id = getId(form); if (!id) return;
      const patch = cfg.buildPatch(form);
      try {
        await App.utils.fetchJSONUnified(cfg.saveUrl(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
        window.flash?.('Updated', 'success');
        try { if (cfg.changedEvent) App.utils.EventBus?.emit(cfg.changedEvent); } catch(_) {}
        toggleView(false);
        try { this._draftById.delete(id); } catch(_) {}
        const modal = this.byId(this.options?.modalId);
        const rootEl = modal ? modal.querySelector(this.options?.rootSelector || '') : null;
        if (typeof cfg.onSaved === 'function') { try { await cfg.onSaved(id, rootEl); } catch(_) {} }
        else { try { await this.softRefreshDetail(rootEl, id); } catch(_) {} }
      } catch(_) {
        window.flash?.('Update failed', 'danger');
      }
    });

    try {
      const form0 = root.querySelector(formSel);
      applyDraft(form0);
      const id0 = getId(form0);
      const editing0 = id0 ? !!this._editingById.get(id0) : false;
      toggleView(!!editing0);
    } catch (err) { /* ignore initial draft/apply errors */ }

    try {
      const form = root.querySelector(formSel);
      if (form) {
        this._onDetail(form, 'input', persistDraftDebounced);
        this._onDetail(form, 'change', persistDraftDebounced);
        const jsonInput = form.querySelector('[data-diary-detail-categories-json], [data-todo-detail-categories-json], [data-content-detail-categories-json]');
        if (jsonInput) {
          this._onDetail(jsonInput, 'change', persistDraftDebounced);
          this._onDetail(jsonInput, 'input', persistDraftDebounced);
        }
      }
    } catch (err) { /* ignore wiring errors */ }
  }

  // ===== REFRESH METHODS =====

  async softRefreshDetail(root, id) {
    if (!id) return;
    const el = this.byId(this.options?.modalId);
    if (!el) return;
    const body = el.querySelector(this.options?.bodySelector || '.modal-body');
    let loader = null;
    try {
      loader = App?.utils?.ui?.createLoader?.({ lines: 2 }) || null;
    } catch (err) { /* ignore loader creation errors */ }
    if (loader && body) body.appendChild(loader);
    try {
      const data = await this._fetchDetailData(id);
      if (data) await this.renderDetail(data);
    } catch (err) {
      // ignore render errors
    } finally {
      if (loader && loader.parentNode) {
        try { loader.parentNode.removeChild(loader); } catch (err) { /* ignore */ }
      }
    }
  }

  // ===== CATEGORY WIDGET SETUP =====

  setupDetailCategoryWidget(form, opts) {
    if (!form) return null;
    const entityMatch = (this.options?.detailUrlPrefix || '').match(/\/api\/([^\/]+)\//);
    const entity = (opts && opts.entity) || (entityMatch && entityMatch[1] ? entityMatch[1] : 'content');
    const initial = (opts && Array.isArray(opts.initial)) ? opts.initial : [];
    const datalistId = (opts && opts.datalistId) || `${entity}CategoriesGlobal`;
    const apiUrl = `/api/${entity}-categories`;
    const ensureLoaded = async () => {
      try {
        const dl = document.getElementById(datalistId);
        const already = dl && dl.dataset.loaded === '1' && dl.querySelector('option');
        if (already) { return; }
        const data = await App.utils.fetchJSONUnified(apiUrl, { dedupe: true });
        const items = (data.items || []).map(c => c.name).filter(Boolean).slice(0, 200);
        if (dl) { dl.innerHTML = items.map(n => `<option value="${n}"></option>`).join(''); dl.dataset.loaded = '1'; }
      } catch(_) { /* ignore */ }
    };
    const cfg = {
      chipsSelector: `[data-${entity}-detail-categories]`,
      inputSelector: `[data-${entity}-detail-category-input]`,
      jsonInputSelector: `[data-${entity}-detail-categories-json]`,
      addBtnSelector: `[data-${entity}-detail-add-btn]`,
      initial,
      ensureLoaded,
      getHints: () => {
        const hints = this.getHintsFromDatalist(datalistId);
        if (hints && hints.length) return hints;
        try { return (this._lastCatHints && this._lastCatHints[entity]) || []; } catch(_) { return []; }
      }
    };
    try {
      // debug logs removed
      form._catWidget = window.BlogHelpers?.setupCategoryWidget?.(form, cfg) || null;
      return form._catWidget;
    } catch(_) { return null; }
  }

  // ===== COMMENT RENDERING =====

  renderComments(root, comments, item, opts) {
    const options = opts || {};
    const modalId = this.options?.modalId;
    // derive entity key from detailUrlPrefix: '/api/todo/' -> 'todo'
    let entity = 'content';
    const m = (this.options?.detailUrlPrefix || '').match(/\/api\/([^\/]+)\//);
    if (m && m[1]) entity = m[1];
    const wrapSelector = options.wrapSelector || `[data-${entity}-comments]`;
    const wrap = root?.querySelector ? root.querySelector(wrapSelector) : null;
    if (!wrap) return;
    const markdownToggleSelector = options.markdownToggleSelector || (modalId ? `#${modalId} [data-${entity}-markdown-toggle]` : undefined);
    const deleteEndpointPrefix = options.deleteEndpointPrefix || `/api/${entity}-comments/`;
    const onDeleted = typeof options.onDeleted === 'function' ? options.onDeleted : (id) => {
      const rootSel = this.options?.rootSelector || '';
      const modal = this.byId(this.options?.modalId);
      const r = modal ? modal.querySelector(rootSel) : null;
      try { this.refreshCommentsOnly(r, id); } catch(_) {}
    };
    try {
      window.BlogHelpers?.renderComments?.(wrap, comments || [], { item: item || {}, deleteEndpointPrefix, markdownToggleSelector, onDeleted });
    } catch (_) {
      try { App.utils.tools.del_child(wrap); } catch(_e) {}
      const empty = document.createElement('div');
      empty.className = 'text-muted';
      empty.textContent = 'No comments';
      wrap.appendChild(empty);
    }
  }

  // ===== MODAL OPENING =====

  async openDetail(id) {
    // If a fetch for the same id is already in-flight, reuse it
    if (this._detailFetchPromise && this._detailFetchId === id) {
      return this._detailFetchPromise;
    }
    this._detailFetchId = id;
    const el = this.byId(this.options?.modalId);
    if (!el) return;

    const body = el.querySelector(this.options?.bodySelector || '.modal-body');
    const root = el.querySelector(this.options?.rootSelector);

    // Show a loader in the modal body while fetching
    let loader = null;
    try {
      loader = App?.utils?.ui?.createLoader?.({ lines: 4 }) || null;
    } catch (err) {
      // ignore loader errors
      loader = null;
    }
    if (loader && body) body.appendChild(loader);

    if (root) root.style.visibility = 'hidden';
    const url = `${this.options?.detailUrlPrefix || ''}${id}/detail`;

    this._detailFetchPromise = (async () => {
      try {
        const data = await App.utils.fetchJSONUnified(url, { dedupe: true });
        await this.renderDetail(data);
        this.showModal();
      } catch (err) {
        window.flash?.('Failed to load detail', 'danger');
      } finally {
        // cleanup loader and reset visibility/state
        if (loader && loader.parentNode) {
          try { loader.parentNode.removeChild(loader); } catch (remErr) { /* ignore */ }
        }
        if (root) {
          try { root.style.visibility = ''; } catch (vErr) { /* ignore */ }
        }
        this._detailFetchPromise = null;
        this._detailFetchId = null;
      }
    })();

    return this._detailFetchPromise;
  }

  // ===== ABSTRACT METHOD =====

  async renderDetail(_data) {}
}

// ===== CREATE WIDGET =====

export class BlogBaseCreateWidget extends BaseWidget {
  constructor(root, options) {
    super(root, options);
    this.modal = null;
  }

  // ===== ELEMENT HELPERS =====
  byId(id) {
    return id ? document.getElementById(id) : null;
  }

  // ===== MODAL OPENING =====
  openCreateModal() {
    const m = this.byId(this.options?.modalId);
    if (!m) return;

    const form = m.querySelector(this.options?.formSelector || 'form');
    // Reset and set title
    try { form?.reset(); } catch (err) { /* ignore reset errors */ }
    if (this.options?.titleSelector) {
      const t = m.querySelector(this.options.titleSelector);
      if (t) t.textContent = this.options?.createTitle || 'New';
    }

    // Try to show bootstrap modal if available, otherwise fallback to display block
    try {
      this.modal = window.bootstrap ? bootstrap.Modal.getOrCreateInstance(m) : this.modal;
      if (this.modal) this.modal.show(); else m.style.display = 'block';
    } catch (err) {
      try { m.style.display = 'block'; } catch (err2) { /* ignore */ }
    }

    // Focus first title input if present
    setTimeout(() => {
      try { form?.querySelector('[name="title"]').focus(); } catch (err) { /* ignore */ }
    }, 30);

    // Hook up category widget if available
    this.setupCategories?.(form);
  }

  // ===== BUTTON WIRING =====
  async wireNewButton() {
    const btn = this.byId(this.options?.newBtnId);
    if (btn && !btn._blogBound) {
      this.on(btn, 'click', () => this.openCreateModal());
      btn._blogBound = true;
    }
  }

  // ===== PAYLOAD NORMALIZATION =====
  normalizePayload(payload) {
    if (payload.categories) {
      try {
        const arr = JSON.parse(payload.categories || '[]');
        if (Array.isArray(arr)) payload.category = arr;
      } catch (err) {
        /* ignore parse errors */
      }
      delete payload.categories;
    }
    return payload;
  }

  // ===== FORM SUBMIT WIRING =====
  wireFormSubmit() {
    const m = this.byId(this.options?.modalId);
    const form = m?.querySelector(this.options?.formSelector || 'form');
    const changedEvent = this.options?.changedEvent;
    if (!form || form._blogBound) return;

    this.on(form, 'submit', async (e) => {
      e.preventDefault();
      await App.utils.withSingleFlight(form, async () => {
        const fd = new FormData(form);
        const id = (fd.get('_id') || fd.get('id') || '').toString().trim();
        const payload = Object.fromEntries(fd.entries());
        this.normalizePayload(payload);

        // require at least a title/content/description
        if (!payload.title && !payload.content && !payload.description) return;

        const base = this.options?.createUrlBase;
        const url = id ? `${base}/${id}` : base;
        const method = id ? 'PATCH' : 'POST';

        try {
          await App.utils.fetchJSONUnified(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          window.flash?.('Saved', 'success');
          try { App.utils.EventBus?.emit(changedEvent); } catch (emitErr) { /* ignore */ }
          if (this.modal) {
            try { this.modal.hide(); } catch (hideErr) { /* ignore */ }
          } else if (m) {
            try { m.style.display = 'none'; } catch (hideErr) { /* ignore */ }
          }
        } catch (err) {
          window.flash?.('Failed to save', 'danger');
        }
      });
    });
    form._blogBound = true;
  }

  // ===== LIFECYCLE METHOD =====
  async mount(root) {
    super.mount(root);
    await this.wireNewButton();
    await this.wireFormSubmit();
  }
}
