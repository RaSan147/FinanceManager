// Lightweight, dependency-tolerant data exporter for browser
// - fetchItems(exportType, limit) -> fetch sanitized items from server
// - downloadJSON/downloadCSV -> client-side downloads
class GenericExporter {
    // Fetch items from server and remove ID fields
    static async fetchItems(exportType, limit = 1000) {
        const capped = Math.min(Number(limit) || 1000, 1000);
        const res = await fetch('/api/profile/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ export_type: exportType, limit: capped })
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => res.statusText);
            throw new Error(`Server returned ${res.status}: ${txt}`);
        }
        const payload = await res.json();
        const items = Array.isArray(payload.items) ? payload.items : [];
        return items.map(i => GenericExporter._stripIds(i));
    }

    // Remove common ID fields from top-level object (shallow)
    static _stripIds(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        const out = {};
        for (const k of Object.keys(obj)) {
            if (k === '_id' || k.toLowerCase() === 'id') continue;
            out[k] = obj[k];
        }
        return out;
    }

    // Download JSON file
    static downloadJSON(filename, items) {
        const sanitized = Array.isArray(items) ? items.map(i => GenericExporter._stripIds(i)) : [];
        const data = JSON.stringify(sanitized, null, 2);
        GenericExporter._downloadFile(filename, 'application/json', data);
    }

    // Download CSV. Prefer PapaParse when it is present; otherwise use a simple builder.
    static downloadCSV(filename, items) {
        const sanitized = Array.isArray(items) ? items.map(i => GenericExporter._stripIds(i)) : [];
        try {
            if (typeof Papa !== 'undefined' && Papa.unparse) {
                const csv = Papa.unparse(sanitized);
                GenericExporter._downloadFile(filename, 'text/csv', csv);
                return;
            }
        } catch (e) {
            // If PapaParse is present but errors, fall through to builtin builder
            console.warn('PapaParse unavailable or failed, using builtin CSV builder', e);
        }

        // Build CSV from union of keys (shallow). Values are escaped for CSV.
        const colsSet = new Set();
        sanitized.forEach(it => { Object.keys(it || {}).forEach(k => colsSet.add(k)); });
        const headers = Array.from(colsSet);
        const escape = (v) => {
            if (v === null || v === undefined) return '';
            if (typeof v === 'object') return JSON.stringify(v);
            return String(v).replace(/"/g, '""');
        };
        let csv = headers.map(h => `"${h.replace(/"/g, '""')}"`).join(',') + '\n';
        sanitized.forEach(it => {
            const row = headers.map(h => `"${escape(it[h])}"`).join(',');
            csv += row + '\n';
        });
        GenericExporter._downloadFile(filename, 'text/csv', csv);
    }

    // (PDF support removed) For PDF functionality remove this file or implement server-side conversion.

    // Create a Blob and trigger a download
    static _downloadFile(filename, type, data) {
        const blob = new Blob([data], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

// Expose the exporter globally for inline scripts (unchanged behavior)
window.GenericExporter = GenericExporter;
