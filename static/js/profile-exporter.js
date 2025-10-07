document.addEventListener('DOMContentLoaded', () => {
    const container = document.querySelector('[data-profile-export-root]');
    if (!container) return;

    const typeSelect = container.querySelector('#export-type');
    const formatSelect = container.querySelector('#export-format');
    const limitInput = container.querySelector('#export-limit');
    const exportBtn = container.querySelector('#do-export');
    const feedback = container.querySelector('#export-feedback');

    function setFeedback(msg, isError = false) {
        if (!feedback) return;
        feedback.innerHTML = `<div class="alert ${isError ? 'alert-danger' : 'alert-success'}" role="alert">${msg}</div>`;
    }

    exportBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        setFeedback('Preparing export...');
        const type = typeSelect.value;
        const fmt = formatSelect.value;
        const limit = Math.min(1000, Math.max(1, Number(limitInput.value) || 1000));
        try {
            const items = await window.GenericExporter.fetchItems(type, limit);
            if (fmt === 'json') {
                window.GenericExporter.downloadJSON(`${type}_export.json`, items);
            } else if (fmt === 'csv') {
                window.GenericExporter.downloadCSV(`${type}_export.csv`, items);
            } else {
                setFeedback('Unknown format selected', true);
                return;
            }
            setFeedback(`Exported ${items.length} item(s) (${fmt.toUpperCase()}).`);
        } catch (err) {
            console.error('Export error', err);
            setFeedback(`Export failed: ${err.message || 'Please try again.'}`, true);
        }
    });
});
