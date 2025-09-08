// app_core.js - Shared utility core & lightweight module system
(function() {
    class DateTimeManager {
        constructor() {
            this.timeZone = this.detectTimeZone();
        }

        detectTimeZone() {
            try {
                return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
            } catch (_) {
                return 'UTC';
            }
        }

        parse(val) {
            if (!val) return null;
            if (val instanceof Date) return isNaN(val) ? null : val;

            if (typeof val === 'object') {
                if (val.$date) return this.parse(val.$date);
                const maybeDate = val.date || val._date;
                if (maybeDate) return this.parse(maybeDate);
            }

            if (typeof val === 'string') {
                const s = val.trim();
                if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00Z');
                const norm = s.replace(/\+00:00$/, 'Z').replace(' ', 'T');
                const d = new Date(norm);
                if (!isNaN(d)) return d;
            }

            if (typeof val === 'number') {
                const d = new Date(val);
                return isNaN(d) ? null : d;
            }

            return null;
        }

        format(val, opts) {
            const d = this.parse(val);
            if (!d) return '';

            try {
                return new Intl.DateTimeFormat(undefined, Object.assign({ timeZone: this.timeZone }, opts)).format(d);
            } catch (_) {
                return d.toLocaleDateString();
            }
        }

        formatDate(val) {
            return this.format(val, { year: 'numeric', month: 'short', day: '2-digit' });
        }

        formatDateTime(val) {
            return this.format(val, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        }

        formatShort(val) {
            return this.format(val, { month: 'short', day: '2-digit' });
        }

        relative(val) {
            const d = this.parse(val);
            if (!d) return '';

            const now = new Date();
            const diffMs = now - d;
            const sec = Math.floor(diffMs / 1000);

            if (sec < 60) return sec + 's ago';
            const min = Math.floor(sec / 60);
            if (min < 60) return min + 'm ago';
            const hr = Math.floor(min / 60);
            if (hr < 24) return hr + 'h ago';
            const day = Math.floor(hr / 24);
            if (day < 7) return day + 'd ago';
            const wk = Math.floor(day / 7);
            if (wk < 5) return wk + 'w ago';
            const mo = Math.floor(day / 30);
            if (mo < 12) return mo + 'mo ago';
            const yr = Math.floor(day / 365);
            return yr + 'y ago';
        }

        toUTCISOStringFromLocalDate(dateStr) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return null;
            const parts = dateStr.split('-');
            const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 0, 0, 0, 0);
            return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString();
        }
    }

    const DateTime = new DateTimeManager();

    // Expose instance globally
    window.DateTimeManager = DateTime;
    window.DateTime = DateTime;

    function safeNumber(n) {
        const v = Number(n);
        return Number.isFinite(v) ? v : 0;
    }

    function qs(sel, root = document) {
        return root.querySelector(sel);
    }

    function qsa(sel, root = document) {
        return Array.from(root.querySelectorAll(sel));
    }

    function html(str) {
        const d = document.createElement('div');
        d.innerHTML = str;
        return d.firstElementChild;
    }

    function fmt(amount, digits = 2) {
        return window.formatNumber ? window.formatNumber(amount, digits) : safeNumber(amount).toFixed(digits);
    }

    function money(amount, symbol = '') {
        return window.formatMoney ? window.formatMoney(amount, symbol) : (symbol || '') + fmt(amount, 2);
    }

    function cap(s) {
        return (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
    }

    function escapeHtml(str) {
        return (str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
    }

    function safeDateString(val, opts) {
        const o = opts || { year: 'numeric', month: 'short', day: '2-digit' };
        return DateTime.format(val, o);
    }

    function createEl(tag, props = {}, children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (k === 'class') el.className = v;
            else if (k === 'dataset') Object.assign(el.dataset, v);
            else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
            else if (v != null) el.setAttribute(k, v);
        }
        if (children != null) {
            if (Array.isArray(children)) children.forEach(c => append(el, c));
            else append(el, children);
        }
        return el;
    }

    function append(parent, child) {
        if (child == null) return;
        if (child instanceof Node) parent.appendChild(child);
        else parent.appendChild(document.createTextNode(String(child)));
    }

    async function fetchJSON(url, opts) {
        const headers = Object.assign({ 'Accept': 'application/json', 'X-Client-TZ': DateTime.timeZone }, (opts && opts.headers) || {});
        const finalOpts = Object.assign({}, opts, { headers });
        const res = await fetch(url, finalOpts);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

        // Unified single-flight (duplicate submit) guard for forms/buttons.
        // Usage: App.utils.withSingleFlight(formElement, async () => { ... });
        async function withSingleFlight(el, fn) {
            if (!el) return await fn();
            if (el.dataset.submitting === '1') return; // already in-flight
            el.dataset.submitting = '1';
            try { return await fn(); } finally { delete el.dataset.submitting; }
        }

        // Simple pub/sub event bus for cross-module communication
        const EventBus = (() => {
            const map = new Map();
            return {
                on(evt, fn) { if(!map.has(evt)) map.set(evt, new Set()); map.get(evt).add(fn); return () => this.off(evt, fn); },
                off(evt, fn) { const set = map.get(evt); if(set){ set.delete(fn); if(!set.size) map.delete(evt);} },
                emit(evt, data) { const set = map.get(evt); if(set) [...set].forEach(f => { try { f(data); } catch(e){ console.warn('Event handler error', evt, e); } }); }
            };
        })();

        // Keyed single-flight (deduplicate concurrent identical async calls) + short-term response cache
        const RequestCoordinator = (() => {
            const inflight = new Map(); // key -> Promise
            const cache = new Map(); // key -> {ts,data}
            const CACHE_MS = 4000;
            function key(method, url, body) { return method + ' ' + url + ' ' + (body ? JSON.stringify(body) : ''); }
            async function run(method, url, opts) {
                const body = opts && opts.body ? opts.body : null;
                const k = key(method, url, body);
                const now = Date.now();
                // Serve fresh cache if recent and no-cache override not set
                if(!opts?.noCache){
                    const c = cache.get(k);
                    if(c && (now - c.ts) < CACHE_MS) return c.data;
                }
                if(inflight.has(k)) return inflight.get(k);
                const p = (async () => {
                    try {
                        const res = await fetch(url, opts);
                        if(!res.ok) throw new Error('HTTP '+res.status);
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

        // Enhanced fetchJSON that leverages RequestCoordinator and supports options: { dedupe: true, noCache: true }
        async function fetchJSONUnified(url, opts) {
            const method = (opts?.method || 'GET').toUpperCase();
            const headers = Object.assign({ 'Accept': 'application/json', 'X-Client-TZ': DateTime.timeZone }, (opts && opts.headers) || {});
            const final = Object.assign({}, opts, { headers });
            if(final.dedupe) {
                return RequestCoordinator.run(method, url, final);
            }
            let res;
            try { res = await fetch(url, final); } catch(networkErr){
                window.flash && window.flash('Network error', 'danger');
                throw networkErr;
            }
            let data = null;
            const isJson = (res.headers.get('content-type')||'').includes('application/json');
            if(isJson){
                try { data = await res.json(); } catch(_) { /* ignore parse failure */ }
            }
            if(!res.ok){
                // Derive message
                let msg = (data && (data.error || data.message)) || ('Request failed ('+res.status+')');
                // Collect validation errors array (Pydantic style: {'errors':[{'loc':['field'],'msg':'...'}]})
                if(data && Array.isArray(data.errors)){
                    const lines = data.errors.slice(0,4).map(e=>{
                        try { const loc = Array.isArray(e.loc)? e.loc.filter(p=> typeof p==='string').join('.') : ''; return (loc? loc+': ':'') + (e.msg || e.message || 'Invalid'); } catch { return ''; }
                    }).filter(Boolean);
                    if(lines.length) msg = msg + '<br>' + lines.join('<br>');
                }
                window.flash && window.flash(msg, 'danger', 7000);
                const err = new Error(msg);
                err.status = res.status; // @ts-ignore
                err.payload = data; // attach raw
                throw err;
            }
            return data != null ? data : (isJson? {}: null);
        }

        // Guard helpers namespace
        const Guard = {
            submit(formEl, handler){
                formEl.addEventListener('submit', e => {
                    e.preventDefault();
                    withSingleFlight(formEl, () => handler(e, formEl));
                });
            },
            click(btnEl, handler){
                btnEl.addEventListener('click', e => {
                    withSingleFlight(btnEl, () => handler(e, btnEl));
                });
            },
            oncePer(intervalMs, key, fn){
                const STORE = (Guard._onceStore = Guard._onceStore || {});
                const now = Date.now();
                if(STORE[key] && (now - STORE[key]) < intervalMs) return false;
                STORE[key] = now;
                fn();
                return true;
            }
        };

        // SPA skeleton: optional interception of internal link clicks.
        // For future expansion; currently just emits navigation events.
        function enableSPALinkInterception(){
            if(window.__spaLinksEnabled) return; window.__spaLinksEnabled = true;
            document.addEventListener('click', e => {
                const a = e.target.closest('a[data-spa]');
                if(!a) return;
                const href = a.getAttribute('href');
                if(!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) return;
                e.preventDefault();
                EventBus.emit('spa:navigate:start', { href });
                fetch(href, { headers: { 'Accept': 'text/html' } })
                    .then(r => r.text())
                    .then(html => {
                        // Minimal swap: replace main container content only (future TODO: server provide JSON partial)
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(html, 'text/html');
                        const newMain = doc.querySelector('main .container');
                        const curMain = document.querySelector('main .container');
                        if(newMain && curMain){
                            curMain.innerHTML = newMain.innerHTML;
                            window.history.pushState({}, '', href);
                            EventBus.emit('spa:navigate:complete', { href });
                            // Re-run module init for any dynamic components in swapped content
                            App.init();
                        } else {
                            window.location.href = href; // fallback
                        }
                    })
                    .catch(()=> window.location.href = href);
            });
            window.addEventListener('popstate', () => EventBus.emit('spa:popstate', { href: location.pathname }));
        }

    const App = {
        modules: [],
        register(mod) {
            this.modules.push(mod);
        },
    utils: { qs, qsa, html, fmt, money, cap, escapeHtml, safeDateString, fetchJSON, createEl, withSingleFlight, fetchJSONUnified, Guard, EventBus, enableSPALinkInterception },
        init() {
            this.modules.forEach(m => {
                try {
                    m.init && m.init(this.utils);
                } catch (e) {
                    console.warn('Module init failed', m, e);
                }
            });
        },
        ready(fn) {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        App.init();

        // Relative time auto-refresh
        const refreshRel = () => {
            document.querySelectorAll('[data-rel-time]').forEach(el => {
                const v = el.getAttribute('data-rel-time');
                el.textContent = DateTime.relative(v);
            });
        };
        refreshRel();
        setInterval(refreshRel, 60000);
    });

    window.App = App;
})();
