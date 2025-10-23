// page_runtime.js (ES Module)
// Object-oriented page entrypoint system.
// Contract:
// - base.html sets <body data-page="{{ request.endpoint }}">
// - This runtime detects a page key and attempts to import /static/js/pages/<key>.js
// - Preferred: default export is a class (extending BasePage) with mount/refresh/destroy.
// - Fallback: default export is a function init(ctx) that returns optional { refresh, destroy }.
// - ctx = { pageName, endpoint, utils: window.App?.utils, EventBus: window.App?.utils?.EventBus }
// - If the module is missing, this is a no-op.

import { BasePage, looksLikeClass } from './page.js';

function detectPageKeys() {
  const endpoint = document.body?.dataset?.page || '';
  const keys = [];
  if (endpoint) {
    const parts = endpoint.split('.');
    if (parts.length) keys.push(parts[parts.length - 1]); // prefer last segment first (e.g. "transactions")
    keys.push(endpoint); // full endpoint
    if (parts.length) keys.push(parts[0]); // blueprint name
  }
  // Also try a hint from main content wrapper if provided
  const main = document.querySelector('main [data-page]');
  if (main && main.getAttribute('data-page')) keys.unshift(main.getAttribute('data-page'));
  // Deduplicate while preserving order
  return Array.from(new Set(keys.filter(Boolean)));
}

async function tryImport(name) {
  const url = `/static/js/pages/${name}.js`;
  try {
    const mod = await import(url);
    return mod || null;
  } catch (e) {
    // 404 or syntax error — only warn in debug
    if (typeof console !== 'undefined' && (window.__DEV__ || window.localStorage?.getItem('debug') === '1')) {
      console.debug('[page_runtime] no module for', name, e?.message || e);
    }
    return null;
  }
}

async function boot() {
  const keys = detectPageKeys();
  if (!keys.length) return;
  // Load the first module that exists
  let mod = null, pageName = null;
  for (const k of keys) {
    mod = await tryImport(k);
    if (mod) { pageName = k; break; }
  }
  if (!mod) return; // no-op if not found

  const ctx = {
    pageName,
    endpoint: document.body?.dataset?.page || '',
    utils: window.App?.utils || {},
    EventBus: window.App?.utils?.EventBus,
  };

  let api = null;
  let instance = null;
  const def = mod.default || mod.Page || null;
  try {
    if (def && looksLikeClass(def)) {
      instance = new def(ctx);
      if (!(instance instanceof BasePage)) {
        // still allow any class with mount/refresh/destroy
      }
      if (typeof instance.mount === 'function') {
        await instance.mount();
      } else if (typeof instance.init === 'function') {
        await instance.init();
      }
      api = instance;
    } else if (typeof def === 'function') {
      // Back-compat functional init(ctx)
      api = await def(ctx) || null;
    }
  } catch (e) {
    console.warn('[page_runtime] init failed for', pageName, e);
  }

  // Simple lifecycle hooks
  if (api && typeof api.refresh === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        try { api.refresh(); } catch (_) {}
      }
    });
  }

  window.PageRuntime = Object.assign(window.PageRuntime || {}, {
    pageName,
    api,
    instance,
    refresh() { try { api?.refresh?.(); } catch(_) {} },
    destroy() { try { api?.destroy?.(); } catch(_) {} },
  });
}

// Start after DOM is ready, but modules load independently
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
