// widgets/todo_detail_widget.js
import { BlogBaseDetailWidget } from '/static/js/widgets/blog_base.js';

export default class TodoDetailWidget extends BlogBaseDetailWidget {
  constructor(root, options) {
    super(root, Object.assign({
      modalId: 'todoDetailModal',
      rootSelector: '[data-todo-detail-root]',
      bodySelector: '[data-todo-detail-body], .modal-body',
      detailUrlPrefix: '/api/todo/'
    }, options));
  }

  async renderDetail(data) {
    this._clearDetailDisposers();
    const modal = document.getElementById('todoDetailModal');
    const root = modal?.querySelector('[data-todo-detail-root]');
    if (!root) return;
    const item = data?.item || {};

    this._renderHeader(root, item);
    this._setupDescription(modal, root, item, data);
    this._renderHistory(root, item);
    this.renderComments(root, data.comments || [], item);
    this._populateEditForm(root, item);
    this._wireHeaderControls(root);

    const formC = root.querySelector('[data-todo-comment-form]');
    this.wireCommentForm(formC, {
      id: item._id,
      uploadEndpoint: '/api/todo-images',
      selectors: {
        fileInput: '[data-todo-comment-image]',
        triggerBtn: '[data-todo-comment-image-trigger]',
        clearBtn: '[data-todo-comment-images-clear]',
        previewWrap: '[data-todo-comment-images-preview]'
      },
      modalId: 'todoDetailModal',
      buildPostUrl: (id) => `/api/todo/${id}/comments`,
      onPosted: (id) => this.refreshCommentsOnly(root, id)
    });
  }

  _renderHeader(root, item) {
    const titleBody = root.querySelector('[data-todo-detail-title-body]');
    if (titleBody) titleBody.textContent = item.title || 'To-Do';

    const catEl = root.querySelector('[data-todo-detail-category]');
    if (catEl) { this.renderCategoryBadges(catEl, item.category); }

    const stageEl = root.querySelector('[data-todo-detail-stage]');
    if (stageEl) {
      const btn = document.querySelector(`#stageViewMenu [data-stage="${item.stage}"]`);
      stageEl.textContent = btn ? (btn.textContent || '').trim() : (String(item.stage || '').replace(/_/g, ' '));
      try { window.BlogHelpers?.applyStageBadge?.(stageEl, item.stage); } catch(_) {}
    }

    const dueEl = root.querySelector('[data-todo-detail-due]');
    if (dueEl) {
      const dStr = globalThis.SiteDate?.toDateString?.(item.due_date);
      if (dStr) { dueEl.textContent = dStr; dueEl.classList.remove('d-none'); }
      else { dueEl.classList.add('d-none'); }
    }
  }

  _setupDescription(modal, root, item, data) {
    const descEl = root.querySelector('[data-todo-detail-description]');
    const markdownToggle = modal?.querySelector('[data-todo-markdown-toggle]');
    this.setupMarkdownToggle({
      toggleEl: markdownToggle,
      storageKey: 'todo-markdown-enabled',
      contentEl: descEl,
      raw: item.description || '',
      itemId: item._id,
      rerenderComments: () => { this.renderComments(root, data?.comments || [], item); }
    });
  }

  _renderHistory(root, item) {
    const histUl = root.querySelector('[data-todo-stage-history]');
    if (!histUl) return;
    App.utils.tools.del_child(histUl);
    const events = Array.isArray(item.stage_events) ? item.stage_events : [];
    if (!events.length) {
      const li = document.createElement('li');
      li.className = 'text-muted';
      li.textContent = 'No history';
      histUl.appendChild(li);
      return;
    }
    for (const ev of events) {
      const li = document.createElement('li');
      const from = ev.from || '—';
      const to = ev.to || '—';
      const at = globalThis.SiteDate?.toDateTimeString?.(ev.at) || '';
      li.appendChild(document.createTextNode(`${from} → ${to} `));
      const span = document.createElement('span');
      span.className = 'text-muted';
      span.textContent = at;
      li.appendChild(span);
      histUl.appendChild(li);
    }
  }

  _populateEditForm(root, item) {
    const editForm = root.querySelector('[data-todo-detail-edit-form]');
    if (!editForm) return;
    this._editForm = editForm;
    editForm.dataset.todoId = item._id || '';
    const titleInput = editForm.querySelector('[data-todo-detail-edit-title]'); if (titleInput) titleInput.value = item.title || '';
    const descInput = editForm.querySelector('[data-todo-detail-edit-description]'); if (descInput) descInput.value = item.description || '';
    const stageSel = editForm.querySelector('[data-todo-detail-edit-stage]'); if (stageSel) stageSel.value = item.stage || 'wondering';
    const dueInput = editForm.querySelector('[data-todo-detail-edit-due]'); if (dueInput) dueInput.value = item.due_date ? globalThis.SiteDate?.toDateString?.(item.due_date) : '';
    try {
      const initialCats = Array.isArray(item.category) ? item.category : (item.category ? [item.category] : []);
      this.setupDetailCategoryWidget(editForm, { initial: initialCats });
    } catch(_) {}
  }

  _wireHeaderControls(root) {
    this.wireEditControls(root, {
      editBtnSelector: '[data-todo-detail-edit-btn]',
      saveBtnSelector: '[data-todo-detail-save-btn]',
      cancelBtnSelector: '[data-todo-detail-cancel-btn]',
      formSelector: '[data-todo-detail-edit-form]',
      viewSelector: '[data-todo-detail-description]',
      itemIdGetter: (form) => form.dataset.todoId || '',
      buildPatch: (form) => {
        const fd = new FormData(form); const patch = {}; fd.forEach((v,k) => { patch[k]=v.toString(); });
        if (patch.categories) { try { const arr = JSON.parse(patch.categories||'[]'); if (Array.isArray(arr)) patch.category = arr; } catch(_) {} delete patch.categories; }
        if (patch.due_date === '') patch.due_date = null; if (Array.isArray(patch.category) && patch.category.length === 0) patch.category = null;
        return patch;
      },
      saveUrl: (id) => `/api/todo/${id}`,
      changedEvent: 'todo:changed',
      onSaved: (id, r) => this.softRefreshDetail(r, id),
      onToggle: (editing) => {
      }
    });
  }

  async mount(root) {
    super.mount(root);
    const off = App.utils.EventBus?.on?.('todo:item:open', (ev) => { if (ev?.id) this.openDetail(ev.id); });
    if (typeof off === 'function') { this._off = (this._off||[]); this._off.push(off); }
  }
}
