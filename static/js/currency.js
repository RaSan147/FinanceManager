;(function () {
    'use strict';

    // Convert input to a finite Number. Non-finite values become 0.
    function safeNumber(n) {
        const v = Number(n);
        return Number.isFinite(v) ? v : 0;
    }

    /**
     * formatNumber(amount, digits = 2)
     * - Localized formatting for numeric values using Intl.NumberFormat.
     * - Treats invalid or non-finite inputs as 0.
     * - Returns a string (e.g. "1,234.56").
     */
    function formatNumber(amount, digits = 2) {
        const num = safeNumber(amount);
        return new Intl.NumberFormat(undefined, {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
        }).format(num);
    }

    /**
     * formatMoney(amount, symbol = '')
     * - Convenience wrapper to prepend a currency symbol to the formatted number.
     * - Caller is responsible for passing the desired symbol (e.g. "$", "€").
     */
    function formatMoney(amount, symbol = '') {
        return (symbol || '') + formatNumber(amount, 2);
    }

    // Expose functions on window for backward compatibility with other scripts
    if (typeof window !== 'undefined') {
        window.formatNumber = formatNumber;
        window.formatMoney = formatMoney;
    }
})();
