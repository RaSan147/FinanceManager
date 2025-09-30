(() => {
  if (window.SiteDate) return;

  // SiteDate: central date parsing and formatting utilities used across the site.
  // - parse(obj): returns a Date or null
  // - toDateString(obj): YYYY-MM-DD or ''
  // - toDateTimeString(obj): YYYY-MM-DD HH:MM or ''
  // - toISOString(obj): ISO string or ''
  const SiteDate = {
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
            return SiteDate.parse(input[k]);
          }
        }
      }

      return null;
    },

    // Format helpers
    toDateString(input) {
      const d = SiteDate.parse(input);
      if (!d) return '';
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    },

    toDateTimeString(input) {
      const d = SiteDate.parse(input);
      if (!d) return '';
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      return `${y}-${m}-${day} ${hh}:${mm}`;
    },

    toISOString(input) {
      const d = SiteDate.parse(input);
      return d ? d.toISOString() : '';
    }
  };

  window.SiteDate = SiteDate;
})();
