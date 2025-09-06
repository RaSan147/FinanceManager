// Improved readability with proper indentation and comments
(function() {
    function safeNumber(n) {
        const v = Number(n);
        return Number.isFinite(v) ? v : 0;
    }

    function formatNumber(amount, digits = 2) {
        return new Intl.NumberFormat(undefined, {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits
        }).format(safeNumber(amount));
    }

    function formatMoney(amount, symbol = '') {
        return (symbol || '') + formatNumber(amount, 2);
    }

    // Expose utility functions globally
    window.formatNumber = formatNumber;
    window.formatMoney = formatMoney;
})();
