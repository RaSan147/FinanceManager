// widgets/diary_create_widget.js
// Create/update modal for Diary using BlogBaseCreateWidget

import { BlogBaseCreateWidget } from '/static/js/widgets/blog_base.js';

export default class DiaryCreateWidget extends BlogBaseCreateWidget {
  constructor(root, options) {
    super(root, Object.assign({
      modalId: 'diaryModal',
      formSelector: '[data-diary-form]',
      titleSelector: '[data-diary-modal-title]',
      createTitle: 'New Entry',
      newBtnId: 'btnNewDiaryTop',
      createUrlBase: '/api/diary',
      changedEvent: 'diary:changed'
    }, options));
  }

  setupCategories(form) {
    try {
      form._catWidget = window.BlogHelpers?.setupCategoryWidget?.(form, {
        chipsSelector: '[data-diary-create-categories]',
        inputSelector: '[data-diary-create-category-input]',
        jsonInputSelector: '[data-diary-create-categories-json]',
        addBtnSelector: '[data-diary-create-add-btn]',
        ensureLoaded: () => this.loadHints(),
        getHints: () => this._hints || []
      });
      this.loadHints();
    } catch(_) {}
  }

  openCreateModal() {
    super.openCreateModal();
    try {
      const m = document.getElementById('diaryModal');
      const form = m?.querySelector('[data-diary-form]');
      // Do not auto-focus/show typeahead on open.
    } catch(_) {}
  }

  async loadHints() {
    if (this._hints && this._hints.length) return;
    try {
      const data = await App.utils.fetchJSONUnified('/api/diary-categories', { dedupe: true });
      this._hints = (data.items || []).map(c => c.name).filter(Boolean).slice(0, 200);
      const dl = document.getElementById('diaryCategoriesGlobal');
      if (dl) { dl.innerHTML = this._hints.map(n => `<option value="${n}"></option>`).join(''); dl.dataset.loaded = '1'; }
    } catch(_) {
      const dl = document.getElementById('diaryCategoriesGlobal');
      if (dl) this._hints = Array.from(dl.querySelectorAll('option')).map(o => o.value).filter(Boolean).slice(0, 200);
    }
  }
}
