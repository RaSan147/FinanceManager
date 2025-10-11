// Dashboard and transactions UI helpers (shared with transactions.js)

class ActiveGoalPreview {
  // Small helper to render a single active goal preview element
  constructor(goal, helpers, currency, userCurrencySymbol) {
    this.goal = goal || {};
    this.h = helpers || {};
    this.currency = currency;
    // Prefer mapped symbol, fallback to provided user symbol or empty string
    this.displaySymbol = (window.currencySymbols && window.currencySymbols[this.goal.currency]) || userCurrencySymbol || '';
  }

  build() {
    const { createEl, safeDateString, money } = this.h;
    const percentRaw = Number(this.goal.progress?.progress_percent ?? 0);
    const percent = Math.min(100, Math.max(0, percentRaw));

    const container = createEl('div', { class: 'mb-3 goal-item' });
    container.appendChild(createEl('h6', {}, this.goal.description || ''));

    const meta = createEl('div', { class: 'd-flex justify-content-between mb-1' });
    meta.appendChild(createEl('small', {}, 'Target: ' + money(this.goal.target_amount, this.displaySymbol)));
    meta.appendChild(createEl('small', {}, safeDateString(this.goal.target_date)));
    container.appendChild(meta);

    const progressWrap = createEl('div', { class: 'progress' });
    const bar = createEl(
      'div',
      {
        class: 'progress-bar',
        role: 'progressbar',
        style: `width:${percent}%`,
        'aria-valuenow': String(percent),
        'aria-valuemin': '0',
        'aria-valuemax': '100'
      },
      percent.toFixed(0) + '%'
    );
    progressWrap.appendChild(bar);
    container.appendChild(progressWrap);

    return container;
  }
}

class DashboardTransactionsModule {
  // Initialize with shared utilities (App.utils)
  static init(utils) {
    this.utils = utils;
    this.bindTransactionsTable();
    this.refreshDashboardData();

    // Periodically refresh dashboard if dashboard area is present
    if (utils.qs('[data-dynamic-dashboard]')) {
      setInterval(() => this.refreshDashboardData(), 60_000);
    }

    // If a transactions table exists on the page, render initial pagination from server-provided attributes
    try {
      const tableRoot = utils.qs('[data-transactions-table]');
      if (tableRoot) {
        const totalAttr = tableRoot.getAttribute('data-total-transactions');
        if (totalAttr) {
          const current = parseInt(tableRoot.getAttribute('data-current-page') || '1', 10);
          const perPage = parseInt(tableRoot.getAttribute('data-per-page') || '10', 10);
          const total = parseInt(totalAttr, 10);
          this.renderPagination(current, perPage, total);
        }
      }
    } catch (e) {
      // non-fatal; keep UI resilient
    }
  }

  // Refresh dashboard via API and update several sub-views
  static async refreshDashboardData() {
    if (!this.utils) return;
    const { qs, fetchJSON } = this.utils;
    if (!qs('[data-dynamic-dashboard]')) return;
    try {
      const data = await fetchJSON('/api/dashboard');
      this.renderMonthlySummary(data.monthly_summary, data.currency);
      this.renderLifetimeSummary(data.lifetime, data.currency);
      this.renderRecentTransactions(data.recent_transactions, data.currency);
      this.renderActiveGoals(data.goals, data.currency);
      this.renderIncomeCountdown(data.days_until_income);
    } catch (err) {
      console.warn('Dashboard refresh failed', err);
    }
  }

  static renderMonthlySummary(summary, currency) {
    if (!summary || !this.utils) return;
    const { qs, money } = this.utils;
    const root = qs('[data-monthly-summary]');
    if (!root) return;
    root.querySelector('[data-ms-income]').textContent = money(summary.total_income, currency.symbol);
    root.querySelector('[data-ms-expenses]').textContent = money(summary.total_expenses, currency.symbol);
    root.querySelector('[data-ms-savings]').textContent = money(summary.savings, currency.symbol);
    root.querySelector('[data-ms-title]').textContent = `Monthly Summary - ${summary.month} (${currency.code})`;
  }

  static renderLifetimeSummary(lifetime, currency) {
    if (!lifetime || !this.utils) return;
    const { qs, money } = this.utils;
    const root = qs('[data-lifetime-summary]');
    if (!root) return;
    root.querySelector('[data-lt-income]').textContent = money(lifetime.total_income, currency.symbol);
    root.querySelector('[data-lt-expenses]').textContent = money(lifetime.total_expenses, currency.symbol);
    root.querySelector('[data-lt-balance]').textContent = money(lifetime.current_balance, currency.symbol);
    root.querySelector('[data-lt-count]').textContent = `Based on ${lifetime.total_transactions} transactions`;
  }

  // Recent transactions list on the dashboard (compact rows)
  static renderRecentTransactions(transactions, currency) {
    if (!this.utils) return;
    const { qs, createEl } = this.utils;
    const tbody = qs('[data-recent-transactions-body]');
    if (!tbody) return;
    tbody.textContent = '';

    if (!Array.isArray(transactions) || !transactions.length) {
      const tr = createEl('tr');
      tr.appendChild(createEl('td', { colspan: '4', class: 'text-center text-muted' }, 'No transactions'));
      tbody.appendChild(tr);
      return;
    }

    const frag = document.createDocumentFragment();
    transactions.forEach((tx) => {
      try {
        // TransactionModel is defined in transaction_model.js and is expected to be available
        frag.appendChild(new TransactionModel(tx, this.utils, currency.symbol).buildRow('recent'));
      } catch (e) {
        // ignore bad row data
      }
    });
    tbody.appendChild(frag);
  }

  static renderActiveGoals(goals, currency) {
    if (!this.utils) return;
    const { qs, createEl } = this.utils;
    const container = qs('[data-active-goals]');
    if (!container) return;
    container.textContent = '';

    if (!goals || !goals.length) {
      const emptyWrap = createEl('div', { class: 'text-center py-4' });
      emptyWrap.appendChild(createEl('p', { class: 'text-muted' }, 'No active goals.'));
      emptyWrap.appendChild(createEl('a', { href: '/goals', class: 'btn btn-primary' }, 'Set a Goal'));
      container.appendChild(emptyWrap);
      return;
    }

    const frag = document.createDocumentFragment();
    goals.forEach((g) => {
      try {
        frag.appendChild(new ActiveGoalPreview(g, this.utils, currency, currency.symbol).build());
      } catch (_) {
        // skip invalid goal
      }
    });
    container.appendChild(frag);
  }

  static renderIncomeCountdown(daysUntil) {
    if (!this.utils) return;
    const { qs } = this.utils;
    const el = qs('[data-income-countdown]');
    if (!el) return;
    if (daysUntil == null) {
      el.classList.add('d-none');
      return;
    }
    el.classList.remove('d-none');
    el.textContent = `Next income in ${daysUntil} day${daysUntil === 1 ? '' : 's'}.`;
  }

  // Transactions table wiring: pagination and delete handling
  static bindTransactionsTable() {
    if (!this.utils) return;
    const { qs } = this.utils;
    const tableRoot = qs('[data-transactions-table]');
    if (!tableRoot) return;

    const paginationRoot = qs('[data-pagination]');
    if (paginationRoot) {
      paginationRoot.addEventListener('click', (evt) => {
        const link = evt.target.closest('a[data-page]');
        if (!link) return;
        evt.preventDefault();
        this.loadTransactionsPage(parseInt(link.dataset.page, 10));
      });
    }

    tableRoot.addEventListener('click', (evt) => {
      const deleteBtn = evt.target.closest('[data-delete-id]');
      if (!deleteBtn) return;
      evt.preventDefault();
      const id = deleteBtn.getAttribute('data-delete-id');
      if (!confirm('Delete this transaction?')) return;
      this.deleteTransaction(id)
        .then(() => {
          // flash() may be provided globally by other scripts
          flash('Deleted', 'success');
          const current = parseInt(tableRoot.getAttribute('data-current-page') || '1', 10);
          this.loadTransactionsPage(current);
        })
        .catch(() => {flash('Delete failed', 'danger')});
    });
  }

  static async loadTransactionsPage(page) {
    if (!this.utils) return;
    const { qs, fetchJSON } = this.utils;
    const tableRoot = qs('[data-transactions-table]');
    if (!tableRoot) return;
    const perPage = parseInt(tableRoot.getAttribute('data-per-page') || '10', 10);
    try {
      const raw = await fetchJSON(`/api/transactions/list?page=${page}&per_page=${perPage}`);
      const data = raw && raw.data ? raw.data : raw; // support envelope or plain
      this.renderTransactionsTable(data);
    } catch (err) {
      console.error('Failed to load transactions page', err);
    }
  }

  static renderTransactionsTable(data) {
    if (!this.utils) return;
    const { qs, createEl } = this.utils;
    const tbody = qs('[data-transactions-body]');
    const tableRoot = qs('[data-transactions-table]');
    if (!tbody || !tableRoot) return;
    tableRoot.setAttribute('data-current-page', data.page);
    const symbol = tableRoot.getAttribute('data-currency-symbol') || '';
    tbody.textContent = '';

    if (!data.items.length) {
      const tr = createEl('tr');
      tr.appendChild(createEl('td', { colspan: '6', class: 'text-center text-muted' }, 'No transactions'));
      tbody.appendChild(tr);
    } else {
      const frag = document.createDocumentFragment();
      data.items.forEach((tx) => {
        try { frag.appendChild(new TransactionModel(tx, this.utils, symbol).buildRow('full')); } catch (_) { }
      });
      tbody.appendChild(frag);
    }
    this.renderPagination(data.page, data.per_page, data.total);
  }

  static renderPagination(currentPage, perPage, totalItems) {
    if (!this.utils) return;
    const { qs, createEl } = this.utils;
    const wrapper = qs('[data-pagination]');
    if (!wrapper) return;
    const totalPages = Math.ceil(totalItems / perPage);
    wrapper.textContent = '';
    if (totalPages <= 1) return; // nothing to paginate

    const ul = createEl('ul', { class: 'pagination justify-content-center' });
    const addPageLink = (label, page, disabled = false, active = false) => {
      const li = createEl('li', { class: `page-item ${active ? 'active' : ''} ${disabled ? 'disabled' : ''}` });
      const a = createEl('a', { class: 'page-link', href: '#', 'data-page': String(page) }, label);
      if (disabled) a.setAttribute('tabindex', '-1');
      li.appendChild(a);
      ul.appendChild(li);
    };

    addPageLink('Previous', currentPage - 1, currentPage === 1, false);
    for (let p = 1; p <= totalPages; p++) addPageLink(String(p), p, false, p === currentPage);
    addPageLink('Next', currentPage + 1, currentPage === totalPages, false);

    wrapper.appendChild(ul);
  }

  static async deleteTransaction(id) {
    const res = await fetch(`/api/transactions/${id}`, { method: 'DELETE', headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('Delete failed');
    const raw = await res.json();
    return raw && raw.data ? raw.data : raw;
  }
}

App.register(DashboardTransactionsModule);

// Expose for external callers (transactions.js uses this to refresh pagination)
window.DashboardTransactionsModule = DashboardTransactionsModule;

