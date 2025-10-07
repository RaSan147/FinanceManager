(() => {
  if (window.SiteDate) return;

  // SiteDate: central date parsing and formatting utilities used across the site.
  // Public API (preserved):
  // - parse(obj): returns a Date or null
  // - toDateString(obj): 'YYYY-MM-DD' or '' (UTC-based)
  // - toDateTimeString(obj): 'YYYY-MM-DD HH:MM' or '' (UTC-based)
  // - toISOString(obj): ISO string or ''
  class SiteDateUtil {
    parse(input) {
      if (input == null) return null;
      // If already a Date
      if (input instanceof Date) return isNaN(input.getTime()) ? null : input;

      // Numbers (timestamps in seconds or milliseconds)
      if (typeof input === 'number') {
        return new Date(input > 1e12 ? input : input * 1000);
      }

      // Strings: try Date.parse first (handles ISO and many common formats)
      if (typeof input === 'string') {
        const s = input.trim();
        if (!s) return null;
        // Fast numeric string -> treat as timestamp
        if (/^-?\d+$/.test(s)) {
          const n = Number(s);
          return new Date(n > 1e12 ? n : n * 1000);
        }
        // Try Date.parse
        const parsed = Date.parse(s);
        if (!isNaN(parsed)) return new Date(parsed);
        // Try normalizing common "YYYY-MM-DD hh:mm" without T to ISO
        const alt = s.replace(' ', 'T');
        const parsed2 = Date.parse(alt);
        if (!isNaN(parsed2)) return new Date(parsed2);
        return null;
      }

      // Objects with typical date keys
      if (typeof input === 'object') {
        const keys = ['$date', 'date', 'iso', 'datetime', 'at', 'value'];
        for (const k of keys) {
          if (k in input) {
            return this.parse(input[k]);
          }
        }
      }

      return null;
    }

    // Format helpers
    toDateString(input) {
      const d = this.parse(input);
      if (!d) return '';
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }

    toDateTimeString(input) {
      const d = this.parse(input);
      if (!d) return '';
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      return `${y}-${m}-${day} ${hh}:${mm}`;
    }

    toISOString(input) {
      const d = this.parse(input);
      return d ? d.toISOString() : '';
    }

    // Locale-aware display formatting using Intl.DateTimeFormat
    // Example opts: { year: 'numeric', month: 'short', day: '2-digit' }
    format(input, opts) {
      const d = this.parse(input);
      if (!d) return '';
      try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        return new Intl.DateTimeFormat(undefined, Object.assign({ timeZone: tz }, opts || { year: 'numeric', month: 'short', day: '2-digit' })).format(d);
      } catch (_) {
        return this.toDateString(d);
      }
    }

    // Human-friendly relative time like '5m ago', '2h ago', '3d ago'.
    relative(input) {
      const d = this.parse(input);
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
  }

  // Expose a single, frozen instance to encourage read-only usage.
  window.SiteDate = Object.freeze(new SiteDateUtil());
})();
