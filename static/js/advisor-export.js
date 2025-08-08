class DataExporter {
    static init() {
        document.getElementById('export-csv')?.addEventListener('click', this.exportCSV);
        document.getElementById('export-json')?.addEventListener('click', this.exportJSON);
        document.getElementById('export-pdf')?.addEventListener('click', this.exportPDF);
    }

    static async exportCSV() {
        try {
            const response = await fetch('/api/ai/advice-history?limit=1000');
            const data = await response.json();
            
            let csv = 'Date,Description,Amount,Category,Recommendation,Reason\n';
            data.forEach(item => {
                csv += `"${new Date(item.created_at).toLocaleString()}","${item.request.description}",${item.request.amount},"${item.request.category}","${item.advice.recommendation}","${item.advice.reason.replace(/"/g, '""')}"\n`;
            });
            
            this.downloadFile('purchase_advice.csv', 'text/csv', csv);
        } catch (error) {
            console.error('Export failed:', error);
            alert('Export failed. Please try again.');
        }
    }

    static async exportJSON() {
        try {
            const response = await fetch('/api/ai/advice-history?limit=1000');
            const data = await response.json();
            this.downloadFile('purchase_advice.json', 'application/json', JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('Export failed:', error);
            alert('Export failed. Please try again.');
        }
    }

    static exportPDF() {
        // This would typically use a library like jsPDF or call a server endpoint
        alert('PDF export would be implemented with a PDF generation library');
    }

    static downloadFile(filename, type, data) {
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

document.addEventListener('DOMContentLoaded', () => DataExporter.init());