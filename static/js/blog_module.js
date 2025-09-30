(() => {
  if (window.BlogModule) return;

  /*
    BlogModule - a small class providing shared blog-like behavior across Diary, Todo, etc.
    - Depends on window.BlogHelpers (will throw if missing) so failures are loud.
    - Provides date formatting, debounce, navigation warnings, inline image uploader glue,
      and a thin wrapper for comment rendering.
    Usage:
      const bm = new BlogModule();
      bm.formatDate(...)
      bm.setupNavigationWarnings(() => hasUnsaved());
      bm.attachInlineImageUploader({...});
  */

  class BlogModule {
    constructor(options = {}) {
      this.options = options || {};
      if (!window.BlogHelpers) throw new Error('BlogHelpers is required by BlogModule');
      this.helpers = window.BlogHelpers;
    }

    // Use the site-wide SiteDate utility for parsing/formatting.
    formatDate(v) {
      if (!window.SiteDate) throw new Error('SiteDate is required by BlogModule');
      return window.SiteDate.toDateString(v);
    }

    formatDateTime(v) {
      if (!window.SiteDate) throw new Error('SiteDate is required by BlogModule');
      return window.SiteDate.toDateTimeString(v);
    }

    // Delegate navigation warnings to BlogHelpers (expects a hasUnsaved boolean function)
    setupNavigationWarnings(hasUnsavedFn) {
      if (!hasUnsavedFn || typeof hasUnsavedFn !== 'function') {
        throw new Error('setupNavigationWarnings requires a function that returns whether there are unsaved changes');
      }
      return this.helpers.setupNavigationWarnings(hasUnsavedFn);
    }

    // Debounce via helpers
    debounce(fn, wait) {
      return this.helpers.debounce(fn, wait);
    }

    // Inline image uploader glue. opts: { contentEl, fileInput, trigger, uploadEndpoint }
    attachInlineImageUploader(opts) {
      return this.helpers.attachInlineImageUploader(opts);
    }

    // Render comments using BlogHelpers renderer; keep simple wrapper for possible overrides
    renderComments(container, comments, opts = {}) {
      return this.helpers.renderComments(container, comments, opts);
    }
  }

  window.BlogModule = BlogModule;
})();
