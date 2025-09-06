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

    const App = {
        modules: [],
        register(mod) {
            this.modules.push(mod);
        },
        utils: { qs, qsa, html, fmt, money, cap, escapeHtml, safeDateString, fetchJSON, createEl },
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
