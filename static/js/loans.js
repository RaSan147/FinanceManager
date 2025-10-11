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
        this.state = { page: 1, perPage: 10, total: 0 };
        const loansTable = this.utils.qs('[data-loans-table]');
        if (loansTable) {
            this.initLoansPage();
            loansTable.addEventListener('click', (e) => this.onAction(e));
        }
    }

    static initLoansPage() {
        const { qs } = this.utils;
        const table = qs('[data-loans-table]');
        if (!table) return;

        // Pagination click handler
        qs('[data-loans-pagination]')?.addEventListener('click', e => {
            const a = e.target.closest('a[data-page]');
            if (!a) return;
            e.preventDefault();
            this.loadLoans(parseInt(a.dataset.page, 10));
        });

        // Listen for global events that should refresh loans list
        window.addEventListener('transaction:created', () => { try { this.loadLoans(1); } catch(_) {} }, { passive: true });
        window.addEventListener('loan:closed', () => { try { this.loadLoans(this.state.page); } catch(_) {} }, { passive: true });

        this.loadLoans(1);
    }

    static async loadLoans(page = 1) {
        const tbody = this.utils.qs('[data-loans-body]');
        if (!tbody) return;

        const perPage = this.state.perPage || parseInt(tbody.closest('[data-loans-table]')?.getAttribute('data-per-page') || '10', 10);

        try {
            const data = await this.utils.fetchJSON(`/api/loans/list?page=${page}&per_page=${perPage}`);
            const items = data.items || [];

            this.state.page = data.page || page;
            this.state.perPage = data.per_page || perPage;
            this.state.total = data.total || 0;

            tbody.innerHTML = ''; // Clear existing rows

            if (items.length === 0) {
                const tr = document.createElement('tr');
                const td = document.createElement('td');
                td.colSpan = 9;
                td.className = 'text-muted text-center';
                td.textContent = 'No loans';
                tr.appendChild(td);
                tbody.appendChild(tr);
                this.renderPagination();
                return;
            }

            const frag = document.createDocumentFragment();
            items.forEach(loanData => {
                const loan = new Loan(loanData, this.helpers());
                frag.appendChild(loan.renderRow());
            });
            tbody.appendChild(frag);
            this.renderPagination();

        } catch (error) {
            console.error('Failed to load loans:', error);
            tbody.innerHTML = '<tr><td colspan="9" class="text-danger text-center">Failed to load loans</td></tr>';
        }
    }

    static renderPagination() {
        const { qs, createEl } = this.utils;
        const wrap = qs('[data-loans-pagination]');
        if (!wrap) return;

        const totalPages = Math.ceil((this.state.total || 0) / (this.state.perPage || 10));
        wrap.innerHTML = '';
        if (totalPages <= 1) return;

        const ul = createEl('ul', { class: 'pagination justify-content-center mt-3' });

        const createPageItem = (text, page, isActive = false, isDisabled = false) => {
            const li = createEl('li', { class: `page-item ${isActive ? 'active' : ''} ${isDisabled ? 'disabled' : ''}` });
            const a = createEl('a', { class: 'page-link', href: '#', dataset: { page } }, text);
            li.appendChild(a);
            return li;
        };

        if (this.state.page > 1) ul.appendChild(createPageItem('Previous', this.state.page - 1));

        for (let p = 1; p <= totalPages; p++) {
            ul.appendChild(createPageItem(p, p, p === this.state.page));
        }

        if (this.state.page < totalPages) ul.appendChild(createPageItem('Next', this.state.page + 1));

        wrap.appendChild(ul);
    }

    static _formatDate(val) {
    const inst = null; // DateTimeManager removed; rely on SiteDate

        function normalize(v) {
            if (!v) return null;
            if (v instanceof Date) return isNaN(v) ? null : v;
            if (typeof v === 'object') {
                if (v.$date) return normalize(v.$date);
                if (v.date) return normalize(v.date);
            }
                if (typeof v === 'number') {
                    return globalThis.SiteDate.parse(v);
                }
            if (typeof v === 'string') {
                const parsed = globalThis.SiteDate.parse(v);
                if (parsed) return parsed;
            }
            return null;
        }

        const d = normalize(val);
        if (!d) return '';

        // Consistent: rely on SiteDate formatting
    return globalThis.SiteDate.toDateString(d);
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

            try { window.dispatchEvent(new CustomEvent('loan:closed', { detail: { loanId } })); } catch(_) {}
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
        if (!this.utils) {
            console.error('LoansModule: missing utils. Ensure app_core.js initialized before this module.');
            // Provide minimal fallbacks that are safe no-ops to avoid crashes
            return {
                qs: (s, r = document) => r.querySelector(s),
                escapeHtml: (s) => (s || '').toString(),
                fmt: (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '0.00'),
                money: (n, sym) => (sym || '') + (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '0.00'),
                cap: (s) => (s || '').charAt(0).toUpperCase() + (s || '').slice(1),
                fetchJSON: (url, opts) => fetch(url, opts).then((r) => r.json())
            };
        }
        const { qs, escapeHtml, fmt, money, cap, fetchJSON } = this.utils;
        return { qs, escapeHtml, fmt, money, cap, fetchJSON };
    }
}

App.register(LoansModule);

