// widgets/todo_create_widget.js
// Refactored to reuse BlogBaseCreateWidget; keeps To‑Do specific bits minimal

import { BlogBaseCreateWidget } from '/static/js/widgets/blog_base.js';

export default class TodoCreateWidget extends BlogBaseCreateWidget {
  constructor(root, options) { super(root, Object.assign({
    modalId: 'todoModal',
    formSelector: '[data-todo-form]',
    titleSelector: '[data-todo-modal-title]',
    createTitle: 'Add To-Do',
    newBtnId: 'btnNewTodoTop',
    createUrlBase: '/api/todo',
    changedEvent: 'todo:changed'
  }, options)); }

  setupCategories(form) {
    try {
      form._catWidget = window.BlogHelpers?.setupCategoryWidget?.(form, {
        chipsSelector: '[data-todo-create-categories]',
        inputSelector: '[data-todo-create-category-input]',
        jsonInputSelector: '[data-todo-create-categories-json]',
        ensureLoaded: () => this.loadHints(),
        getHints: () => this._hints || []
      });
      this.loadHints();
    } catch(_) {}
  }

  async loadHints() {
    if (this._hints && this._hints.length) return;
    try {
      const data = await App.utils.fetchJSONUnified('/api/todo-categories', { dedupe: true });
      this._hints = (data.items || []).map(c => c.name).filter(Boolean).slice(0, 200);
      const dl = document.getElementById('todoCategoriesGlobal');
      if (dl) { dl.innerHTML = this._hints.map(n => `<option value="${n}"></option>`).join(''); dl.dataset.loaded = '1'; }
    } catch(_) {
      const dl = document.getElementById('todoCategoriesGlobal');
      if (dl) this._hints = Array.from(dl.querySelectorAll('option')).map(o => o.value).filter(Boolean).slice(0, 200);
    }
  }

  openCreateModal() {
    super.openCreateModal();
    try {
      const m = document.getElementById('todoModal');
      const form = m?.querySelector('[data-todo-form]');
      const active = document.querySelector('#stageViewMenu .dropdown-item.active');
      const stage = active?.getAttribute('data-stage');
      const stageSel = form?.querySelector('[data-todo-stage-select]');
      if (stageSel && stage && stage !== 'all') stageSel.value = stage;
      // Do not auto-focus or auto-show typeahead. Let user interaction trigger suggestions.
    } catch(_) {}
  }

  normalizePayload(payload) {
    const p = super.normalizePayload(payload);
    if (p.due_date === '') p.due_date = null;
    if (Array.isArray(p.category) && p.category.length === 0) p.category = null;
    return p;
  }
}
