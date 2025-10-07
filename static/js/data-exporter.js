/* Generic DataExporter - uses optional frontend libs loaded via CDN
   - fetchItems(exportType, limit) -> fetches sanitized items from server
   - downloadJSON(filename, items) -> removes _id before download
   - downloadCSV(filename, items) -> uses PapaParse if available, else internal builder
   - downloadPDF(filename, items) -> uses jsPDF + autotable if available, else falls back to JSON PDF
*/
class GenericExporter {
    static async fetchItems(exportType, limit = 1000) {
        limit = Math.min(Number(limit) || 1000, 1000);
        const res = await fetch('/api/profile/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ export_type: exportType, limit })
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => res.statusText);
            throw new Error(`Server returned ${res.status}: ${txt}`);
        }
        const payload = await res.json();
        const items = Array.isArray(payload.items) ? payload.items : [];
        return items.map(i => GenericExporter._stripIds(i));
    }

    static _stripIds(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        const out = {};
        Object.keys(obj).forEach(k => {
            if (k === '_id' || k.toLowerCase() === 'id') return; // omit id fields
            const v = obj[k];
            // don't deep-convert for performance; just convert top-level ObjectId strings if any
            out[k] = v;
        });
        return out;
    }

    static downloadJSON(filename, items) {
        const sanitized = (Array.isArray(items) ? items.map(i => GenericExporter._stripIds(i)) : []);
        const data = JSON.stringify(sanitized, null, 2);
        GenericExporter._downloadFile(filename, 'application/json', data);
    }

    static downloadCSV(filename, items) {
        const sanitized = (Array.isArray(items) ? items.map(i => GenericExporter._stripIds(i)) : []);
        if (typeof Papa !== 'undefined' && Papa.unparse) {
            try {
                const csv = Papa.unparse(sanitized);
                GenericExporter._downloadFile(filename, 'text/csv', csv);
                return;
            } catch (e) {
                console.warn('PapaParse failed, falling back to builtin CSV builder', e);
            }
        }
        // Fallback CSV builder: compute headers from union of keys
        const cols = new Set();
        sanitized.forEach(it => { Object.keys(it || {}).forEach(k => cols.add(k)); });
        const headers = Array.from(cols);
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

    static async downloadPDF(filename, items) {
        const sanitized = (Array.isArray(items) ? items.map(i => GenericExporter._stripIds(i)) : []);
        // Prefer jsPDF + autotable when available
        if (window.jspdf && window.jspdf.jsPDF && typeof window.jspdf.jsPDF === 'function' && window.jspdf_autoTable) {
            try {
                const { jsPDF } = window.jspdf;
                const doc = new jsPDF({ unit: 'pt', format: 'a4' });
                if (sanitized.length === 0) {
                    doc.text('No items', 40, 40);
                    doc.save(filename);
                    return;
                }
                // Generate columns and rows
                const cols = Object.keys(sanitized[0]);
                const head = [cols.map(c => ({ title: c, dataKey: c }))];
                const body = sanitized.map(r => {
                    const out = {};
                    cols.forEach(c => { out[c] = (r[c] === undefined ? '' : (typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c]))); });
                    return out;
                });
                // Use autoTable
                // jspdf_autoTable(doc, { head: [cols], body: body.map(o => cols.map(c => o[c])) }); // alternate API
                doc.autoTable({ head: [cols], body: body.map(o => cols.map(c => o[c])) , startY: 40});
                doc.save(filename);
                return;
            } catch (e) {
                console.warn('jsPDF/autotable failed, falling back to JSON PDF', e);
            }
        }
        // Fallback: simple JSON written into a text PDF using jsPDF if available
        if (window.jspdf && window.jspdf.jsPDF) {
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF({ unit: 'pt', format: 'a4' });
            const text = JSON.stringify(sanitized, null, 2).slice(0, 20000); // keep modest size
            const lines = doc.splitTextToSize(text, 520);
            doc.text(lines, 40, 40);
            doc.save(filename);
            return;
        }
        // No PDF libs available: provide JSON file and inform user
        GenericExporter.downloadJSON(filename.replace(/\.pdf$/i, '.json'), sanitized);
        alert('PDF generation library not available. Downloaded JSON instead.');
    }

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

// Make available globally for simple use in inline scripts
window.GenericExporter = GenericExporter;
