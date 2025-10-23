# Page Runtime and Widgets (OOP)

This folder contains an object-oriented page system and a minimal widget base class.

Goals:
- Each page has a dedicated entry class loaded automatically via `body[data-page]`.
- Clear lifecycle: `mount()`, `refresh()`, `destroy()` for pages and widgets.
- Backwards compatible: no page class = no-op, existing scripts still work.

## How it works

1. `templates/base.html` sets `data-page` on `<body>` to the Flask `request.endpoint`.
2. `static/js/core/page_runtime.js` (ESM) detects the page key and tries to import `/static/js/pages/<key>.js`.
   - Tries in order: full endpoint (e.g. `transactions_routes.transactions`), last segment (`transactions`), first segment (`transactions_routes`).
3. Preferred: default export is a class (ideally extending `BasePage`) with `mount/refresh/destroy`.
   - Fallback: default export is a function `init(ctx)` returning optional `{ refresh, destroy }`.
4. Runtime wires `refresh()` on `visibilitychange` and exposes `window.PageRuntime.refresh()`.

## Create a page entry (class-based)

Create a file under `static/js/pages/`:

```js
// static/js/pages/transactions.js
import { BasePage } from '/static/js/core/page.js';

export default class TransactionsPage extends BasePage {
  async mount() {
    // bind events, preload data, register listeners
  }
  async refresh() {
    // re-fetch and update DOM
  }
  async destroy() {
    await super.destroy();
    // additional cleanup
  }
}
```

## Build a widget

Use `BaseWidget` as a starting point:

```js
import { BaseWidget } from '/static/js/core/widget.js';

class MyWidget extends BaseWidget {
  mount(root) {
    super.mount(root);
    this.root.textContent = 'Hello';
  }
  refresh() {
    // update DOM with new data
  }
  destroy() {
    super.destroy(); // clears listeners
  }
}
```

## Migration tips

- Start with one page (e.g., Dashboard). Add a class entry and call existing global modules from `mount()`.
- Gradually move page-specific code out of large global scripts and into page classes.
- Reuse `window.App.utils` (EventBus, Guard, fetch helpers) for consistency.
- No page class? The runtime no-ops; nothing breaks.
