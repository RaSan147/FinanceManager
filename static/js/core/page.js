// page.js (ES Module)
// BasePage: object-oriented page lifecycle and simple widget orchestration.

export class BasePage {
  constructor(ctx) {
    this.ctx = ctx || {};
    this.utils = this.ctx.utils || {};
    this.EventBus = this.ctx.EventBus;
    this.pageName = this.ctx.pageName || 'unknown';
    this.widgets = [];
    this._disposers = [];
  }

  // Optional: override to setup DOM, bind events, mount widgets
  // Return void or Promise.
  async mount() {}

  // Optional: called when tab becomes visible or manual refresh
  async refresh() {}

  // Optional: clean up listeners, intervals, and widgets
  async destroy() {
    // Dispose listeners
    while (this._disposers.length) {
      try { this._disposers.pop()(); } catch(_) {}
    }
    // Destroy widgets
    for (const w of this.widgets) {
      try { w.destroy?.(); } catch(_) {}
    }
    this.widgets.length = 0;
  }

  // Helper to track event listeners for auto-dispose
  on(el, evt, fn, opts) {
    if (!el || !fn) return () => {};
    el.addEventListener(evt, fn, opts);
    const off = () => { try { el.removeEventListener(evt, fn, opts); } catch(_) {} };
    this._disposers.push(off);
    return off;
  }

  // Helper to register widgets
  registerWidget(widget) {
    if (widget) this.widgets.push(widget);
    return widget;
  }
}

export function looksLikeClass(fn) {
  if (typeof fn !== 'function') return false;
  const src = Function.prototype.toString.call(fn);
  return /^class\s/.test(src);
}
