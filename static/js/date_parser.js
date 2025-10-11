(() => {
  // SiteDate: central date parsing and formatting utilities used across the site.
  // Exposes a single frozen global instance `SiteDate` (attached to `globalThis`).
  // Public API: parse, toDateString, toDateTimeString, toISOString, format, relative

  class SiteDateUtil {
    /**
     * Parse various inputs into a Date or null.
     * Accepts: Date, numeric timestamps (seconds or ms), ISO-like strings,
     * or objects containing keys like $date, date, iso, datetime, at, value.
     */
    parse(input) {
      if (input == null) return null;

      // Already a Date instance
      if (input instanceof Date) return isNaN(input.getTime()) ? null : input;

      // Numbers: timestamp in seconds or milliseconds
      if (typeof input === 'number') {
        return new Date(input > 1e12 ? input : input * 1000);
      }

      // Strings: handle empty, numeric timestamps, ISO, or space-separated date/time
      if (typeof input === 'string') {
        const s = input.trim();
        if (!s) return null;

        // Pure integer strings: treat as unix timestamp (seconds or ms)
        if (/^-?\d+$/.test(s)) {
          const n = Number(s);
          return new Date(n > 1e12 ? n : n * 1000);
        }

        // Try built-in parser first (covers ISO and many browser-supported formats)
        const parsed = Date.parse(s);
        if (!isNaN(parsed)) return new Date(parsed);

        // Some inputs use a space instead of 'T' between date and time (e.g. "YYYY-MM-DD hh:mm")
        const alt = s.replace(' ', 'T');
        const parsed2 = Date.parse(alt);
        if (!isNaN(parsed2)) return new Date(parsed2);

        return null;
      }

      // Objects with date-like fields (Mongo-style or wrapped values)
      if (typeof input === 'object') {
        const keys = ['$date', 'date', 'iso', 'datetime', 'at', 'value'];
        for (const k of keys) {
          if (k in input) return this.parse(input[k]);
        }
      }

      return null;
    }

    /**
     * Return UTC date in YYYY-MM-DD (empty string for invalid input)
     */
    toDateString(input) {
      const d = this.parse(input);
      if (!d) return '';
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }

    /**
     * Return UTC date/time in "YYYY-MM-DD HH:MM" (minutes precision)
     */
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

    /**
     * Return an ISO string or empty string for invalid input
     */
    toISOString(input) {
      const d = this.parse(input);
      return d ? d.toISOString() : '';
    }

    /**
     * Locale-aware formatted representation using Intl.DateTimeFormat.
     * `opts` follows Intl.DateTimeFormat options. Falls back to YYYY-MM-DD on error.
     */
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

    /**
     * Human-friendly relative time: '5s ago', '10m ago', '3h ago', '2d ago', etc.
     */
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

  // Expose a single, frozen instance globally via globalThis (works in browsers and Node-like envs)
  globalThis.SiteDate = Object.freeze(new SiteDateUtil());
})();
