// widget.js (ES Module)
// BaseWidget: minimal lifecycle and refresh contract for page widgets.
// Usage:
//   import { BaseWidget } from '/static/js/core/widget.js';
//   class MyWidget extends BaseWidget {
//     mount(root) { /* build DOM */ }
//     refresh() { /* pull latest data and update */ }
//     destroy() { /* remove listeners, timers */ }
//   }

export class BaseWidget {
  constructor(root, options) {
    this.root = root || null;
    this.options = options || {};
    this._mounted = false;
    this._disposers = [];
  }

  on(el, evt, fn, opts) {
    if (!el || !fn) return () => {};
    el.addEventListener(evt, fn, opts);
    const off = () => { try { el.removeEventListener(evt, fn, opts); } catch(_) {} };
    this._disposers.push(off);
    return off;
  }

  mount(root) {
    // override in subclass
    this.root = root || this.root || document.createElement('div');
    this._mounted = true;
  }

  refresh() {
    // override in subclass
  }

  destroy() {
    // override in subclass (call super.destroy() if you extend)
    while (this._disposers.length) {
      try { this._disposers.pop()(); } catch(_) {}
    }
    this._mounted = false;
  }
}
