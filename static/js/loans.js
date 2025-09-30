class Loan {
    constructor(data, helpers) {
        this.data = data;
        this.helpers = helpers;
        this.currencySymbol = window.currencySymbol || '$';
    }

    _createElement(tag, {
        classes,
        text,
        html
    } = {}) {
        const el = document.createElement(tag);
        if (classes) {
            el.className = Array.isArray(classes) ? classes.join(' ') : classes;
        }
        if (text) {
            el.textContent = text;
        }
        if (html) {
            el.innerHTML = html;
        }
        return el;
    }

    _createStatusBadge() {
        const badge = this._createElement('span', {
            classes: ['badge']
        });
        if (this.data.status === 'open') {
            badge.classList.add('bg-success');
            badge.textContent = 'Open';
        } else {
            badge.classList.add('bg-secondary');
            badge.textContent = 'Closed';
        }
        return badge;
    }

    _createActionButton() {
        if (this.data.status === 'open') {
            const button = this._createElement('button', {
                classes: ['btn', 'btn-sm', 'btn-danger', 'action-btn'],
                text: 'End Loan'
            });
            button.dataset.closeLoan = this.data._id;
            return button;
        }
        return this._createElement('span', {
            classes: 'text-muted',
            text: '—'
        });
    }

    renderRow() {
        const {
            escapeHtml,
            money,
            cap
        } = this.helpers;
        const tr = this._createElement('tr');
        tr.dataset.loanId = this.data._id;

        const statusCell = this._createElement('td');
        statusCell.appendChild(this._createStatusBadge());

        const createdDate = LoansModule._formatDate(this.data.created_at);
        const closedDate = LoansModule._formatDate(this.data.closed_at);

    // Build cells sequentially for clarity
    // Each cell gets data-label for mobile responsive stack view
    statusCell.setAttribute('data-label', 'Status');
    tr.appendChild(statusCell);
    const dir = this._createElement('td', { text: cap(this.data.direction) }); dir.setAttribute('data-label', 'Direction'); tr.appendChild(dir);
    const cp = this._createElement('td', { text: this.data.counterparty || '' }); cp.setAttribute('data-label', 'Counterparty'); tr.appendChild(cp);
    const princ = this._createElement('td', { text: money(this.data.principal_amount || 0, this.currencySymbol) }); princ.setAttribute('data-label', 'Principal'); tr.appendChild(princ);
    const out = this._createElement('td', { text: money(this.data.outstanding_amount || 0, this.currencySymbol) }); out.setAttribute('data-label', 'Outstanding'); tr.appendChild(out);
    const curr = this._createElement('td', { text: this.data.base_currency || '' }); curr.setAttribute('data-label', 'Currency'); tr.appendChild(curr);
    const createdCell = this._createElement('td', { text: createdDate }); createdCell.setAttribute('data-label', 'Created'); tr.appendChild(createdCell);
    const closedCell = this._createElement('td', { text: closedDate || '—' }); closedCell.setAttribute('data-label', 'Closed'); tr.appendChild(closedCell);
    const actionCell = this._createElement('td');
    actionCell.appendChild(this._createActionButton());
    actionCell.setAttribute('data-label', 'Actions');
    tr.appendChild(actionCell);

        return tr;
    }
}


class LoansModule {
    static init(utils) {
        this.utils = utils;
        const loansTable = this.utils.qs('[data-loans-table]');
        if (loansTable) {
            this.loadLoans();
            loansTable.addEventListener('click', (e) => this.onAction(e));
        }
    }

    static async loadLoans() {
        const tbody = this.utils.qs('[data-loans-body]');
        if (!tbody) {
            return;
        }

        try {
            const data = await this.utils.fetchJSON('/api/loans/list');
            const items = data.items || [];

            tbody.innerHTML = ''; // Clear existing rows

            if (items.length === 0) {
                const tr = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 9;
                td.className = 'text-muted text-center';
                td.textContent = 'No loans';
                tr.appendChild(td);
                tbody.appendChild(tr);
                return;
            }

            items.forEach(loanData => {
                const loan = new Loan(loanData, this.helpers());
                tbody.appendChild(loan.renderRow());
            });

        } catch (error) {
            console.error('Failed to load loans:', error);
            tbody.innerHTML = '<tr><td colspan="9" class="text-danger text-center">Failed to load loans</td></tr>';
        }
    }

    static _formatDate(val) {
        const inst = (window.DateTime || window.DateTimeManager);

        function normalize(v) {
            if (!v) return null;
            if (v instanceof Date) return isNaN(v) ? null : v;
            if (typeof v === 'object') {
                if (v.$date) return normalize(v.$date);
                if (v.date) return normalize(v.date);
            }
                if (typeof v === 'number') {
                    if (!window.SiteDate) throw new Error('SiteDate is required but missing');
                    return window.SiteDate.parse(v);
                }
            if (typeof v === 'string') {
                if (!window.SiteDate) throw new Error('SiteDate is required but missing');
                const parsed = window.SiteDate.parse(v);
                if (parsed) return parsed;
            }
            return null;
        }

        const d = normalize(val);
        if (!d) return '';

        if (inst && typeof inst.formatDate === 'function') {
            return inst.formatDate(d);
        }

        // Prefer SiteDate formatting for consistency
        if (window.SiteDate && typeof window.SiteDate.toDateString === 'function') {
            return window.SiteDate.toDateString(d);
        }

        try {
            return d.toLocaleDateString(undefined, {
                month: 'short',
                day: '2-digit',
                year: 'numeric'
            });
        } catch (_) {
            return d.toISOString().slice(0, 10);
        }
    }

    static async onAction(event) {
        const button = event.target.closest('[data-close-loan]');
        if (!button) {
            return;
        }

        const loanId = button.getAttribute('data-close-loan');
        button.disabled = true;
        button.textContent = 'Closing...';

        try {
            const formData = new FormData();
            formData.set('note', 'Closed via UI');

            const response = await fetch(`/api/loans/${loanId}/close`, {
                method: 'POST',
                body: formData,
                headers: {
                    'Accept': 'application/json'
                }
            });

            const data = await response.json();

            if (!data.success) {
                throw new Error('Failed to close loan');
            }

            if (window.flash) {
                window.flash('Loan closed successfully', 'success');
            }

            await this.loadLoans();

        } catch (err) {
            console.error('Error closing loan:', err);
            if (window.flash) {
                window.flash('Failed to close loan', 'danger');
            }
            button.disabled = false;
            button.textContent = 'End Loan';
        }
    }

    static helpers() {
        const {
            qs,
            escapeHtml,
            fmt,
            money,
            cap,
            fetchJSON
        } = this.utils;
        return {
            qs,
            escapeHtml,
            fmt,
            money,
            cap,
            fetchJSON: fetchJSON || (App && App.utils && App.utils.fetchJSON)
        };
    }
}

App.register(LoansModule);

