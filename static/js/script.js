

// Enhanced flash with basic de-duplication (prevents double identical messages firing rapidly)
window.flash = function(message, category = 'info', timeout = 4000) {
    const key = category + '::' + message;
    const now = Date.now();
    // Maintain a short-lived registry of recent flashes
    if (!window.__recentFlashRegistry) window.__recentFlashRegistry = new Map();
    // Prune old entries (> 2s)
    for (const [k, ts] of window.__recentFlashRegistry.entries()) {
        if (now - ts > 2000) window.__recentFlashRegistry.delete(k);
    }
    if (window.__recentFlashRegistry.has(key)) return; // suppress duplicate
    window.__recentFlashRegistry.set(key, now);

    let container = document.getElementById('js-flash-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'js-flash-container';
        Object.assign(container.style, {
            position: 'fixed',
            top: '70px',
            right: '20px',
            zIndex: 2000,
            maxWidth: '360px'
        });
        document.body.appendChild(container);
    }

    const alert = document.createElement('div');
    alert.className = `alert alert-${category} alert-dismissible fade show shadow-sm mb-2`;
    alert.role = 'alert';
    alert.innerHTML = `
        <div class="d-flex align-items-start">
            <div class="flex-grow-1">${message}</div>
            <button type="button" class="btn-close ms-2" data-bs-dismiss="alert"></button>
        </div>`;
    container.appendChild(alert);

    // Auto-dismiss
    const closeTimer = setTimeout(() => {
        alert.classList.remove('show');
        alert.classList.add('hide');
        setTimeout(() => alert.remove(), 400);
    }, timeout);

    // If manually closed early cancel timer
    alert.addEventListener('closed.bs.alert', () => clearTimeout(closeTimer));
};

document.addEventListener('DOMContentLoaded', function() {
    // Initialize tooltips
    var tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'))
    var tooltipList = tooltipTriggerList.map(function (tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl)
    });
    
    // Set today's date as default for date inputs
    var today = (window.SiteDate && typeof window.SiteDate.toDateString === 'function') ? window.SiteDate.toDateString(new Date()) : new Date().toISOString().split('T')[0];
    document.getElementById('date')?.setAttribute('value', today);
    document.getElementById('target_date')?.setAttribute('min', today);
    
    // Form validation
    var forms = document.querySelectorAll('.needs-validation');
    Array.prototype.slice.call(forms).forEach(function(form) {
        form.addEventListener('submit', function(event) {
            if (!form.checkValidity()) {
                event.preventDefault();
                event.stopPropagation();
            }
            form.classList.add('was-validated');
        }, false);
    });
});


