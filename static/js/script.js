

window.flash = function(message, category = 'info', timeout = 4000) {
    // Find or create the flash container
    let container = document.getElementById('js-flash-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'js-flash-container';
        container.style.position = 'fixed';
        container.style.top = '70px';
        container.style.right = '20px';
        container.style.zIndex = 2000;
        document.body.appendChild(container);
    }
    // Create alert
    const alert = document.createElement('div');
    alert.className = `alert alert-${category} alert-dismissible fade show`;
    alert.role = 'alert';
    alert.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
    `;
    container.appendChild(alert);
    // Auto-dismiss
    setTimeout(() => {
        alert.classList.remove('show');
        alert.classList.add('hide');
        setTimeout(() => alert.remove(), 500);
    }, timeout);
};

document.addEventListener('DOMContentLoaded', function() {
    // Initialize tooltips
    var tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'))
    var tooltipList = tooltipTriggerList.map(function (tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl)
    });
    
    // Set today's date as default for date inputs
    var today = new Date().toISOString().split('T')[0];
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


