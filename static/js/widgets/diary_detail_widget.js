// widgets/diary_detail_widget.js
// Diary detail modal using BlogBaseDetailWidget with per-render cleanup and single-flight

import { BlogBaseDetailWidget } from '/static/js/widgets/blog_base.js';

export default class DiaryDetailWidget extends BlogBaseDetailWidget {
  constructor(root, options) {
    super(root, Object.assign({
      modalId: 'diaryDetailModal',
      rootSelector: '[data-diary-detail-root]',
      bodySelector: '.modal-body',
      detailUrlPrefix: '/api/diary/'
    }, options));
  }

  async renderDetail(data) {
    this._clearDetailDisposers();
    const modalEl = document.getElementById('diaryDetailModal');
    const root = modalEl?.querySelector('[data-diary-detail-root]');
    if (!root) return;
    const item = data?.item || {};

    // Header
    const titleEl = root.querySelector('[data-diary-detail-title]'); if (titleEl) titleEl.textContent = item.title || '(Untitled)';
    const catEl = root.querySelector('[data-diary-detail-category]');
    if (catEl) { this.renderCategoryBadges(catEl, item.category); }

    const contentView = root.querySelector('[data-diary-detail-content]');
    const markdownToggle = modalEl?.querySelector('[data-diary-markdown-toggle]');
    this.setupMarkdownToggle({
      toggleEl: markdownToggle,
      storageKey: 'diary-markdown-enabled',
      contentEl: contentView,
      raw: item.content || '',
      itemId: item._id,
      rerenderComments: () => { this.renderComments(root, data.comments || [], item); }
    });

    // Edit form populate
    const editForm = root.querySelector('[data-diary-detail-edit-form]');
    if (editForm) {
      this._editForm = editForm;
      editForm.dataset.diaryId = item._id || '';
      const t = editForm.querySelector('[data-diary-detail-edit-title]'); if (t) t.value = item.title || '';
      const c = editForm.querySelector('[data-diary-detail-edit-content]'); if (c) c.value = item.content || '';
      try {
        const initialCats = Array.isArray(item.category) ? item.category : (item.category ? [item.category] : []);
        this.setupDetailCategoryWidget(editForm, { initial: initialCats });
      } catch(_) {}
    }

    // Edit/save/cancel (using base helper)
    this.wireEditControls(root, {
      editBtnSelector: '[data-diary-detail-edit-btn]',
      saveBtnSelector: '[data-diary-detail-save-btn]',
      cancelBtnSelector: '[data-diary-detail-cancel-btn]',
      formSelector: '[data-diary-detail-edit-form]',
      viewSelector: '[data-diary-detail-content]',
      itemIdGetter: (form) => form.dataset.diaryId || '',
      buildPatch: (form) => {
        const fd = new FormData(form); const patch = {}; fd.forEach((v,k) => { patch[k] = v.toString(); });
        if (patch.categories) { try { const arr = JSON.parse(patch.categories||'[]'); if (Array.isArray(arr)) patch.category = arr; } catch(_) {} delete patch.categories; }
        if (patch.title === '') patch.title = null; if (patch.content === '') patch.content = null; if (Array.isArray(patch.category) && !patch.category.length) patch.category = null;
        return patch;
      },
      saveUrl: (id) => `/api/diary/${id}`,
      changedEvent: 'diary:changed',
      onSaved: (id, r) => this.softRefreshDetail(r, id),
      onToggle: (editing) => {
      }
    });

    // Comments
    this.renderComments(root, data.comments || [], item);
    // Wire comment form (partial refresh on post)
    const formC = root.querySelector('[data-diary-comment-form]');
    this.wireCommentForm(formC, {
      id: item._id,
      uploadEndpoint: '/api/diary-images',
      selectors: {
        fileInput: '[data-diary-comment-image]',
        triggerBtn: '[data-diary-comment-image-trigger]',
        clearBtn: '[data-diary-comment-images-clear]',
        previewWrap: '[data-diary-comment-images-preview]'
      },
      modalId: 'diaryDetailModal',
      buildPostUrl: (id) => `/api/diary/${id}/comments`,
      onPosted: (id) => this.refreshCommentsOnly(root, id)
    });
  }

  // comments are rendered via BlogBaseDetailWidget.renderComments

  async mount(root) { super.mount(root); const off = App.utils.EventBus?.on?.('diary:item:open', (ev) => { if (ev?.id) this.openDetail(ev.id); }); if (typeof off === 'function') { this._off = (this._off||[]); this._off.push(off); } }
}
