// app_core.js - Shared utilities and tiny module system
(function () {
    // SiteDate (date formatting) is required for consistent date handling across modules.
    // The global instance is available as `globalThis.SiteDate`.

    // --- Small helpers -----------------------------------------------------
    /** Return a finite number or 0 */
    function safeNumber(n) {
        const v = Number(n);
        return Number.isFinite(v) ? v : 0;
    }

    /** Query single element (shallow wrapper) */
    function qs(sel, root = document) {
        return root.querySelector(sel);
    }

    /** Query multiple elements and return an Array */
    function qsa(sel, root = document) {
        return Array.from(root.querySelectorAll(sel));
    }

    /** Create a DOM element from an HTML string and return the first element */
    function html(str) {
        const d = document.createElement('div');
        d.innerHTML = str;
        return d.firstElementChild;
    }

    /** Format a number (hooks into optional window.formatNumber) */
    function fmt(amount, digits = 2) {
        return window.formatNumber ? window.formatNumber(amount, digits) : safeNumber(amount).toFixed(digits);
    }

    /** Format currency text (hooks into optional window.formatMoney) */
    function money(amount, symbol = '') {
        return window.formatMoney ? window.formatMoney(amount, symbol) : (symbol || '') + fmt(amount, 2);
    }

    /** Capitalize first letter */
    function cap(s) {
        return (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
    }

    /** Escape HTML special characters */
    function escapeHtml(str) {
        return (str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    /** Convert value to consistent date string using SiteDate */
    function safeDateString(val) {
        return globalThis.SiteDate.toDateString(val);
    }

    /** Create an element with attributes and children (children may be string, Node, or array) */
    function createEl(tag, props = {}, children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (k === 'class') el.className = v;
            else if (k === 'dataset') Object.assign(el.dataset, v);
            else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
            else if (v != null) el.setAttribute(k, v);
        }
        if (children != null) {
            if (Array.isArray(children)) children.forEach((c) => append(el, c));
            else append(el, children);
        }
        return el;
    }

    function append(parent, child) {
        if (child == null) return;
        if (child instanceof Node) parent.appendChild(child);
        else parent.appendChild(document.createTextNode(String(child)));
    }

    // --- Lightweight fetch helpers ----------------------------------------
    async function fetchJSON(url, opts) {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        const headers = Object.assign({ Accept: 'application/json', 'X-Client-TZ': tz }, (opts && opts.headers) || {});
        const finalOpts = Object.assign({}, opts, { headers });
        const res = await fetch(url, finalOpts);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    // Prevent duplicate submissions: set dataset.submitting on the element
    async function withSingleFlight(el, fn) {
        if (!el) return await fn();
        if (el.dataset.submitting === '1') return;
        el.dataset.submitting = '1';
        try {
            return await fn();
        } finally {
            delete el.dataset.submitting;
        }
    }

    // --- Tiny event bus ---------------------------------------------------
    const EventBus = (() => {
        const map = new Map();
        return {
            on(evt, fn) {
                if (!map.has(evt)) map.set(evt, new Set());
                map.get(evt).add(fn);
                return () => this.off(evt, fn);
            },
            off(evt, fn) {
                const set = map.get(evt);
                if (set) {
                    set.delete(fn);
                    if (!set.size) map.delete(evt);
                }
            },
            emit(evt, data) {
                const set = map.get(evt);
                if (set) [...set].forEach((f) => {
                    try {
                        f(data);
                    } catch (e) {
                        console.warn('Event handler error', evt, e);
                    }
                });
            },
        };
    })();

    // Single-flight + small in-memory cache for identical requests
    const RequestCoordinator = (() => {
        const inflight = new Map();
        const cache = new Map();
        const CACHE_MS = 4000;
        function key(method, url, body) {
            return method + ' ' + url + ' ' + (body ? JSON.stringify(body) : '');
        }
        async function run(method, url, opts) {
            const body = opts && opts.body ? opts.body : null;
            const k = key(method, url, body);
            const now = Date.now();
            if (!opts?.noCache) {
                const c = cache.get(k);
                if (c && now - c.ts < CACHE_MS) return c.data;
            }
            if (inflight.has(k)) return inflight.get(k);
            const p = (async () => {
                try {
                    const res = await fetch(url, opts);
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const data = await res.json();
                    cache.set(k, { ts: now, data });
                    return data;
                } finally {
                    inflight.delete(k);
                }
            })();
            inflight.set(k, p);
            return p;
        }
        return { run };
    })();

    // fetch wrapper that integrates request dedupe + standardized error handling
    async function fetchJSONUnified(url, opts) {
        const method = (opts?.method || 'GET').toUpperCase();
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        const headers = Object.assign({ Accept: 'application/json', 'X-Client-TZ': tz }, (opts && opts.headers) || {});
        const final = Object.assign({}, opts, { headers });
        if (final.dedupe) return RequestCoordinator.run(method, url, final);
        let res;
        try {
            res = await fetch(url, final);
        } catch (networkErr) {
            window.flash?.('Network error', 'danger');
            throw networkErr;
        }
        let data = null;
        const isJson = (res.headers.get('content-type') || '').includes('application/json');
        if (isJson) {
            try {
                data = await res.json();
            } catch (_) {
                /* ignore parse failure */
            }
        }
        if (!res.ok) {
            let msg = (data && (data.error || data.message)) || ('Request failed (' + res.status + ')');
            if (data && Array.isArray(data.errors)) {
                const lines = data.errors.slice(0, 4).map((e) => {
                    try {
                        const loc = Array.isArray(e.loc) ? e.loc.filter((p) => typeof p === 'string').join('.') : '';
                        return (loc ? loc + ': ' : '') + (e.msg || e.message || 'Invalid');
                    } catch {
                        return '';
                    }
                }).filter(Boolean);
                if (lines.length) msg = msg + '<br>' + lines.join('<br>');
            }
            window.flash?.(msg, 'danger', 7000);
            const err = new Error(msg);
            err.status = res.status; // attach status
            err.payload = data; // attach raw payload
            throw err;
        }
        return data != null ? data : (isJson ? {} : null);
    }

    // Convenience guards for common UI patterns
    const Guard = {
        submit(formEl, handler) {
            formEl.addEventListener('submit', (e) => {
                e.preventDefault();
                withSingleFlight(formEl, () => handler(e, formEl));
            });
        },
        click(btnEl, handler) {
            btnEl.addEventListener('click', (e) => {
                withSingleFlight(btnEl, () => handler(e, btnEl));
            });
        },
        oncePer(intervalMs, key, fn) {
            const STORE = (Guard._onceStore = Guard._onceStore || {});
            const now = Date.now();
            if (STORE[key] && now - STORE[key] < intervalMs) return false;
            STORE[key] = now;
            fn();
            return true;
        },
    };

    // Optional lightweight SPA link interception (keeps behavior conservative)
    function enableSPALinkInterception() {
        if (window.__spaLinksEnabled) return;
        window.__spaLinksEnabled = true;
        document.addEventListener('click', (e) => {
            const a = e.target.closest && e.target.closest('a[data-spa]');
            if (!a) return;
            const href = a.getAttribute('href');
            if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) return;
            e.preventDefault();
            EventBus.emit('spa:navigate:start', { href });
            fetch(href, { headers: { Accept: 'text/html' } })
                .then((r) => r.text())
                .then((htmlText) => {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(htmlText, 'text/html');
                    const newMain = doc.querySelector('main .container');
                    const curMain = document.querySelector('main .container');
                    if (newMain && curMain) {
                        curMain.innerHTML = newMain.innerHTML;
                        window.history.pushState({}, '', href);
                        EventBus.emit('spa:navigate:complete', { href });
                        App.init();
                    } else {
                        window.location.href = href;
                    }
                })
                .catch(() => (window.location.href = href));
        });
        window.addEventListener('popstate', () => EventBus.emit('spa:popstate', { href: location.pathname }));
    }

    // --- App container ---------------------------------------------------
    const App = {
        modules: [],
        register(mod) {
            this.modules.push(mod);
        },
        utils: {
            qs,
            qsa,
            html,
            fmt,
            money,
            cap,
            escapeHtml,
            safeDateString,
            fetchJSON,
            createEl,
            withSingleFlight,
            fetchJSONUnified,
            Guard,
            EventBus,
            enableSPALinkInterception,
            // lightweight tools inspired by script_global.js
            tools: {
                del_child(elm) {
                    if (!elm) return;
                    if (typeof elm === 'string') elm = document.getElementById(elm);
                    if (!elm) return;
                    while (elm.firstChild) elm.removeChild(elm.lastChild);
                },
                replaceChildren(el) {
                    if (!el) return;
                    if (typeof el.replaceChildren === 'function') el.replaceChildren();
                    else {
                        while (el.firstChild) el.removeChild(el.lastChild);
                    }
                },
                exists(name) {
                    return typeof window[name] !== 'undefined';
                }
            }
        },
        init() {
            this.modules.forEach((m) => {
                try {
                    m.init && m.init(this.utils);
                } catch (e) {
                    console.warn('Module init failed', m, e);
                }
            });
        },
        ready(fn) {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        },
    };

    // When DOM is ready, run module inits and start lightweight recurring tasks
    document.addEventListener('DOMContentLoaded', () => {
        // Debug: confirm app_core ran
        try { console.debug('app_core: DOMContentLoaded - initializing App'); console.log('app_core: DOMContentLoaded - initializing App'); } catch (_) {}
        App.init();

        const refreshRel = () => {
            document.querySelectorAll('[data-rel-time]').forEach((el) => {
                const v = el.getAttribute('data-rel-time');
                el.textContent = globalThis.SiteDate.relative(v);
            });
        };
        refreshRel();
        setInterval(refreshRel, 60000);
    });

    window.App = App;
    try { console.debug('app_core: window.App assigned'); console.log('app_core: window.App assigned'); } catch (_) {}
})();
