// dynamic_app.js - Dashboard & Transactions module (improved readability & naming)

// --- Model / View Helpers --------------------------------------------------
// Unified Transaction view model for both full transactions page & dashboard recent list.
// Transaction rendering now handled by shared TransactionModel (see transaction_model.js)

class ActiveGoalPreview {
  constructor(goal, helpers, currency, userCurrencySymbol) {
    this.goal = goal;
    this.h = helpers;
    this.currency = currency;
    this.displaySymbol = window.currencySymbols?.[goal.currency] || userCurrencySymbol || '';
  }
  build() {
    const { createEl, escapeHtml, safeDateString, money } = this.h;
    const percentRaw = Number(this.goal.progress?.progress_percent ?? 0);
    const percent = Math.min(100, Math.max(0, percentRaw));
    const container = createEl('div', { class: 'mb-3 goal-item' });
    container.appendChild(createEl('h6', {}, escapeHtml(this.goal.description || '')));
    const meta = createEl('div', { class: 'd-flex justify-content-between mb-1' });
    meta.appendChild(createEl('small', {}, 'Target: ' + money(this.goal.target_amount, this.displaySymbol)));
    meta.appendChild(createEl('small', {}, safeDateString(this.goal.target_date)));
    container.appendChild(meta);
    const progressWrap = createEl('div', { class: 'progress' });
    const bar = createEl('div', {
      class: 'progress-bar',
      role: 'progressbar',
      style: `width:${percent}%`,
      'aria-valuenow': String(percent),
      'aria-valuemin': '0',
      'aria-valuemax': '100'
    }, percent.toFixed(0) + '%');
    progressWrap.appendChild(bar);
    container.appendChild(progressWrap);
    return container;
  }
}

// --- Dashboard & Transactions Module ---------------------------------------
class DashboardTransactionsModule {
  static init(utils) {
    this.utils = utils; // stored helpers
    this.bindTransactionsTable();
    this.refreshDashboardData();
    if (utils.qs('[data-dynamic-dashboard]')) {
      setInterval(() => this.refreshDashboardData(), 60_000);
    }
  }

  // Dashboard ----------------------------------------------------------------
  static async refreshDashboardData() {
    const { qs, fetchJSON } = this.utils || App.utils;
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
    if (!summary) return;
    const { qs, money } = this.utils || App.utils;
    const root = qs('[data-monthly-summary]');
    if (!root) return;
    root.querySelector('[data-ms-income]').textContent = money(summary.total_income, currency.symbol);
    root.querySelector('[data-ms-expenses]').textContent = money(summary.total_expenses, currency.symbol);
    root.querySelector('[data-ms-savings]').textContent = money(summary.savings, currency.symbol);
    root.querySelector('[data-ms-title]').textContent = `Monthly Summary - ${summary.month} (${currency.code})`;
  }

  static renderLifetimeSummary(lifetime, currency) {
    if (!lifetime) return;
    const { qs, money } = this.utils || App.utils;
    const root = qs('[data-lifetime-summary]');
    if (!root) return;
    root.querySelector('[data-lt-income]').textContent = money(lifetime.total_income, currency.symbol);
    root.querySelector('[data-lt-expenses]').textContent = money(lifetime.total_expenses, currency.symbol);
    root.querySelector('[data-lt-balance]').textContent = money(lifetime.current_balance, currency.symbol);
    root.querySelector('[data-lt-count]').textContent = `Based on ${lifetime.total_transactions} transactions`;
  }

  static renderRecentTransactions(transactions, currency) {
    const { qs, createEl } = this.utils || App.utils;
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
    transactions.forEach(tx => {
  try { frag.appendChild(new TransactionModel(tx, this.utils, currency.symbol).buildRow('recent')); } catch (e) { /* ignore bad row */ }
    });
    tbody.appendChild(frag);
  }

  static renderActiveGoals(goals, currency) {
    const { qs, createEl } = this.utils || App.utils;
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
    goals.forEach(g => { try { frag.appendChild(new ActiveGoalPreview(g, this.utils, currency, currency.symbol).build()); } catch (_) {} });
    container.appendChild(frag);
  }

  static renderIncomeCountdown(daysUntil) {
    const { qs } = this.utils || App.utils;
    const el = qs('[data-income-countdown]');
    if (!el) return;
    if (daysUntil == null) { el.classList.add('d-none'); return; }
    el.classList.remove('d-none');
    el.textContent = `Next income in ${daysUntil} day${daysUntil === 1 ? '' : 's'}.`;
  }

  // Transactions -------------------------------------------------------------
  static bindTransactionsTable() {
    const { qs } = this.utils || App.utils;
    const tableRoot = qs('[data-transactions-table]');
    if (!tableRoot) return;

    const paginationRoot = qs('[data-pagination]');
    if (paginationRoot) {
      paginationRoot.addEventListener('click', evt => {
        const link = evt.target.closest('a[data-page]');
        if (!link) return;
        evt.preventDefault();
        this.loadTransactionsPage(parseInt(link.dataset.page, 10));
      });
    }

    tableRoot.addEventListener('click', evt => {
      const deleteBtn = evt.target.closest('[data-delete-id]');
      if (!deleteBtn) return;
      evt.preventDefault();
      const id = deleteBtn.getAttribute('data-delete-id');
      if (!confirm('Delete this transaction?')) return;
      this.deleteTransaction(id)
        .then(() => {
          window.flash && window.flash('Deleted', 'success');
          const current = parseInt(tableRoot.getAttribute('data-current-page') || '1', 10);
          this.loadTransactionsPage(current);
        })
        .catch(() => window.flash && window.flash('Delete failed', 'danger'));
    });
  }

  static async loadTransactionsPage(page) {
    const { qs, fetchJSON } = this.utils || App.utils;
    const tableRoot = qs('[data-transactions-table]');
    if (!tableRoot) return;
    const perPage = parseInt(tableRoot.getAttribute('data-per-page') || '10', 10);
    try {
      const data = await fetchJSON(`/api/transactions/list?page=${page}&per_page=${perPage}`);
      this.renderTransactionsTable(data);
    } catch (err) {
      console.error('Failed to load transactions page', err);
    }
  }

  static renderTransactionsTable(data) {
    const { qs, createEl, escapeHtml, safeDateString, money } = this.utils || App.utils;
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
      data.items.forEach(tx => {
  try { frag.appendChild(new TransactionModel(tx, this.utils, symbol).buildRow('full')); } catch (_) {}
      });
      tbody.appendChild(frag);
    }
    this.renderPagination(data.page, data.per_page, data.total);
  }

  static renderPagination(currentPage, perPage, totalItems) {
    const { qs, createEl } = this.utils || App.utils;
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
    return res.json();
  }
}

App.register(DashboardTransactionsModule);

// Expose globally so other scripts (transactions.js) can invoke pagination reloads
window.DashboardTransactionsModule = DashboardTransactionsModule;

