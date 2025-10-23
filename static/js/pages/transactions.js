// pages/transactions.js (ES Module)
// Object-oriented page entry for Transactions page.
import { BasePage } from '/static/js/core/page.js';

// This module owns the transactions page lifecycle including the
// transactions table refresh and the transaction modal/form handling
// (merged from the older global `transactions.js`). The code intentionally
// re-uses App.utils for DOM helpers and networking.

export default class TransactionsPage extends BasePage {
  async mount() {
    try { console.debug('[pages/transactions] mount', { page: this.pageName }); } catch(_) {}
    // Ensure initial view is consistent by calling refresh once (non-blocking).
    try { await this.refresh(); } catch(_) {}
    // Initialize transaction modal/form UI (previously in static/js/transactions.js)
    try { this._initTransactionModal(); } catch (err) { console.warn('transactions page: modal init failed', err); }
  }

  async refresh() {
    const tableRoot = document.querySelector('[data-transactions-table]');
    if (!tableRoot) return; // not on this page
    const current = parseInt(tableRoot.getAttribute('data-current-page') || '1', 10);
    try {
      await window.DashboardTransactionsModule?.loadTransactionsPage?.(current);
    } catch(_) {}
  }

  async destroy() {
    await super.destroy();
  }

  // -------------------- Merged transaction modal & form handling --------------------
  _initTransactionModal() {
    if (!window.App || !App.utils) {
      console.error('TransactionsPage: App.utils required');
      return;
    }

    const U = App.utils;
    const qs = (s, r=document) => U.qs(s, r);

    // DOM refs
    let modalEl = qs('#transactionModal');
    // If neither the modal nor the transactions table exist, bail out.
    const tableRootCheck = qs('[data-transactions-table]');
    if (!modalEl && !tableRootCheck) return;

    // Elements inside modal/form
    let formEl = modalEl ? modalEl.querySelector('[data-transaction-form]') : null;
    let titleEl = modalEl ? modalEl.querySelector('[data-tx-modal-title]') : null;
    let submitBtn = modalEl ? modalEl.querySelector('[data-submit-btn]') : null;
    let idInput = modalEl ? modalEl.querySelector('[data-tx-id]') : null;
    let symbolPrefixEl = modalEl ? modalEl.querySelector('[data-symbol-prefix]') : null;
    let currencySelect = modalEl ? modalEl.querySelector('[data-currency-select]') : null;
    let categorySelect = modalEl ? modalEl.querySelector('[data-category-select]') : null;
    let allOptions = (categorySelect ? Array.from(categorySelect.querySelectorAll('option, optgroup')).map((opt)=>opt.cloneNode(true)) : []);
    let typeSelect = formEl ? formEl.querySelector('[name="type"]') : null;
    let dataList = qs('#tx_person_options');
    let bsModal = null;

    function updateCurrencySymbol() {
      if (!currencySelect || !symbolPrefixEl) return;
      const opt = currencySelect.options[currencySelect.selectedIndex] || {};
      symbolPrefixEl.textContent = (opt.dataset && opt.dataset.symbol) || window.currencySymbol || '';
    }

    function filterCategoriesForType(typeVal) {
      const currentValue = categorySelect ? categorySelect.value : '';
      if (!categorySelect) return;
      U.tools.del_child(categorySelect);
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select a category';
      categorySelect.appendChild(placeholder);
      (allOptions || []).forEach(opt => {
        if (!opt || !opt.tagName) return;
        if (opt.tagName.toUpperCase() !== 'OPTGROUP') return;
        if (opt.dataset && ((typeVal === 'income' && opt.dataset.groupIncome !== undefined) || (typeVal === 'expense' && opt.dataset.groupExpense !== undefined))) {
          categorySelect.appendChild(opt.cloneNode(true));
        }
      });
      if (currentValue) {
        categorySelect.value = currentValue;
        if (categorySelect.value !== currentValue) categorySelect.value = '';
      } else categorySelect.value = '';
    }

    function loanKind(category) {
      const v = (category || '').toLowerCase();
      if (v === 'repaid by me') return 'repaid_by_me';
      if (v === 'repaid to me') return 'repaid_to_me';
      if (v === 'borrowed' || v === 'lent out') return null;
      return undefined;
    }

    async function refreshCounterparties() {
      const kind = loanKind(categorySelect?.value);
      if (typeof kind === 'undefined') { if (dataList) U.tools.del_child(dataList); return; }
      try {
        const url = new URL(window.location.origin + '/api/loans/counterparties');
        if (kind) url.searchParams.set('kind', kind);
        const res = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
        const data = await res.json();
        const q = (formEl?.related_person?.value || '').trim().toLowerCase();
        const items = Array.isArray(data.items) ? data.items : [];
        let ordered = items;
        if (q) {
          const starts = items.filter(n => (n || '').toLowerCase().startsWith(q));
          const contains = items.filter(n => (n || '').toLowerCase().includes(q) && !starts.includes(n));
          ordered = starts.concat(contains);
        }
        const limited = ordered.slice(0, 50);
        if (dataList) dataList.innerHTML = limited.map(n => `<option value="${n}"></option>`).join('');
      } catch {
        if (dataList) U.tools.del_child(dataList);
      }
    }

    function openCreateTransaction() {
      if (!formEl) return;
      formEl.reset();
      if (idInput) idInput.value = '';
      if (titleEl) titleEl.textContent = 'Add Transaction';
      if (submitBtn) submitBtn.textContent = 'Add';
      if (typeSelect) typeSelect.value = 'income';
      filterCategoriesForType('income');
      updateCurrencySymbol();
      if (bsModal) bsModal.show();
    }

    function openEditTransaction(raw) {
      const tx = raw || {};
      if (!formEl) return;
      formEl.reset();
      const model = window.TransactionModel ? new TransactionModel(tx) : null;
      const dateISO = model ? model.dateISO() : (globalThis.SiteDate.toDateString(tx.date) || '');
      if (idInput) idInput.value = tx._id || '';
      if (formEl.amount) formEl.amount.value = tx.amount_original || tx.amount || '';
      if (formEl.currency) formEl.currency.value = tx.currency || window.currencyCode || '';
      if (formEl.type) formEl.type.value = tx.type || 'income';
      if (formEl.description) formEl.description.value = tx.description || '';
      if (formEl.date) formEl.date.value = dateISO || globalThis.SiteDate.toDateString(new Date());
      if (formEl.related_person) formEl.related_person.value = tx.related_person || '';
      if (titleEl) titleEl.textContent = 'Edit Transaction';
      if (submitBtn) submitBtn.textContent = 'Update';
      updateCurrencySymbol();
      filterCategoriesForType(formEl.type.value);
      if (formEl.category) formEl.category.value = tx.category || '';
      if (bsModal) bsModal.show();
      refreshCounterparties();
    }

    async function handleSubmit(evt) {
      evt.preventDefault();
      await U.withSingleFlight(formEl, async () => {
        if (submitBtn) submitBtn.disabled = true;
        const fd = new FormData(formEl);
        const id = idInput ? idInput.value.trim() : '';
        const payload = Object.fromEntries(fd.entries());
        if (payload.date instanceof Date) payload.date = globalThis.SiteDate.toDateString(payload.date);
        try {
          const url = id ? `/api/transactions/${id}` : '/api/transactions';
          const method = id ? 'PATCH' : 'POST';
          const data = await U.fetchJSONUnified(url, { method, headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(payload) });
          (typeof window.flash === 'function' ? window.flash('Transaction saved', 'success') : console.log('success', 'Transaction saved'));
          if (bsModal) bsModal.hide();
          // Emit CRUD events for other modules (e.g., loans page)
          try {
            if (id) {
              window.dispatchEvent(new CustomEvent('transaction:updated', { detail: { id, item: data?.item || null } }));
            } else {
              window.dispatchEvent(new CustomEvent('transaction:created', { detail: { item: data?.item || null } }));
            }
          } catch (_) {}
          if (window.DashboardTransactionsModule && typeof window.DashboardTransactionsModule.loadTransactionsPage === 'function') {
            window.DashboardTransactionsModule.loadTransactionsPage(parseInt(document.querySelector('[data-transactions-table]')?.getAttribute('data-current-page') || '1', 10));
          } else if (id && data && data.item) {
            try {
              const tbody = qs('[data-transactions-body]');
              const btn = tbody.querySelector(`[data-edit-id="${id}"]`);
              const row = btn ? btn.closest('tr') : null;
              if (row) {
                const item = data.item;
                const dateStr = globalThis.SiteDate.toDateString(item.date || item._date || item.created_at);
                const currencySymbol = qs('[data-transactions-table]')?.getAttribute('data-currency-symbol') || '';
                const sign = item.type === 'income' ? '+' : '-';
                const cls = item.type === 'income' ? 'text-success' : 'text-danger';
                const cells = row.querySelectorAll('td');
                if (cells.length >= 6) {
                  cells[0].textContent = dateStr;
                  cells[1].textContent = item.description || '';
                  cells[2].textContent = item.category || '';
                  cells[3].className = cls;
                  const amt = Number(item.amount || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
                  cells[3].textContent = `${sign}${currencySymbol}${amt}`;
                  cells[4].textContent = (item.type || '').replace(/^./, c => c.toUpperCase());
                  if (btn) {
                    const editPayload = {
                      _id: item._id,
                      amount_original: item.amount_original || item.amount,
                      currency: item.currency,
                      type: item.type,
                      category: item.category,
                      description: item.description,
                      date: globalThis.SiteDate.toDateString(item.date || item._date || item.created_at),
                      related_person: item.related_person || ''
                    };
                    btn.setAttribute('data-edit-json', JSON.stringify(editPayload));
                  }
                }
              }
            } catch (err) { console.warn('Inline row update failed', err); }
          } else if (!id && data && data.item) {
            // Newly created: reload current page without full-page refresh
            try {
              const tbl = document.querySelector('[data-transactions-table]');
              const page = parseInt(tbl?.getAttribute('data-current-page') || '1', 10) || 1;
              await window.DashboardTransactionsModule?.loadTransactionsPage?.(page);
            } catch(_) {
              // Fallback to hard reload if dynamic refresh fails
              location.reload();
            }
          }
        } catch (e) {
          if (!(e && e.status)) (typeof window.flash === 'function' ? window.flash('Save failed', 'danger') : console.error('Save failed'));
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }

    function bindEvents() {
      function safeAdd(el, ev, handler, opts) {
        if (!el) { console.warn(`transactions page: missing element for event ${ev}`); return; }
        try { el.addEventListener(ev, handler, opts); } catch (err) { console.warn('transactions page: failed to bind', ev, err); }
      }

      safeAdd(currencySelect, 'change', updateCurrencySymbol);
      safeAdd(typeSelect, 'change', () => { filterCategoriesForType(typeSelect ? typeSelect.value : 'income'); refreshCounterparties(); });
      safeAdd(categorySelect, 'change', refreshCounterparties);
      safeAdd(formEl?.related_person, 'input', () => { if (loanKind(categorySelect?.value) !== undefined) refreshCounterparties(); });
      safeAdd(formEl, 'submit', handleSubmit);

      const openBtn = qs('[data-open-tx-modal]');
      safeAdd(openBtn, 'click', openCreateTransaction);

      function editClickHandler(e) {
        const btn = e.target && e.target.closest ? e.target.closest('[data-edit-id]') : null;
        if (!btn) return;
        e.preventDefault();
        let data = null;
        const raw = btn.getAttribute('data-edit-json');
        if (raw) {
          try { data = JSON.parse(raw); } catch (err) { console.warn('Failed to parse data-edit-json', err, raw); }
        }
        if (!data) data = { _id: btn.getAttribute('data-edit-id') };
        openEditTransaction(data);
      }

      const tableRoot = qs('[data-transactions-table]');
      if (tableRoot) {
        try { tableRoot.addEventListener('click', editClickHandler, { passive: true }); }
        catch (err) { console.warn('transactions page: failed to bind table click handler', err); }
      } else {
        try { document.body.addEventListener('click', editClickHandler, { passive: true }); }
        catch (err) { console.warn('transactions page: failed to bind body click handler', err); }
      }

      if (modalEl) {
        safeAdd(modalEl, 'shown.bs.modal', () => {
          setTimeout(() => {
            const el = formEl ? formEl.querySelector('input,select,textarea') : document.querySelector('input,select,textarea');
            if (el && typeof el.focus === 'function') el.focus();
          }, 35);
        });
      }
    }

    // Bootstrap modal instance
    try { bsModal = modalEl ? bootstrap.Modal.getOrCreateInstance(modalEl) : null; } catch(_) { bsModal = null; }
    // Wire initial state
    updateCurrencySymbol();
    if (typeSelect) filterCategoriesForType(typeSelect.value || 'income');

    // Enhance Related Person with TagTypeahead suggestions (parity with legacy script)
    try {
      const rpInput = formEl?.querySelector('input[name="related_person"][list="tx_person_options"]') || null;
      if (rpInput && window.TagTypeahead) {
        let latest = [];
        const getKind = () => loanKind(categorySelect?.value);
        const ensureLoaded = async () => {
          try {
            const url = new URL(window.location.origin + '/api/loans/counterparties');
            const kind = getKind();
            if (typeof kind !== 'undefined' && kind) url.searchParams.set('kind', kind);
            const res = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
            const data = await res.json();
            latest = Array.isArray(data.items) ? data.items : [];
          } catch(_) { latest = []; }
        };
        const getHints = () => {
          const q = (rpInput.value || '').trim().toLowerCase();
          if (!q) return latest;
          const starts = latest.filter(n => (n||'').toLowerCase().startsWith(q));
          const contains = latest.filter(n => (n||'').toLowerCase().includes(q) && !starts.includes(n));
          return starts.concat(contains);
        };
        const widget = window.TagTypeahead.create({ inputEl: rpInput, ensureLoaded, getHints, mode: 'suggest', maxVisible: 8 });
        if (categorySelect) categorySelect.addEventListener('change', () => widget.focusToShow());
      }
    } catch (e) { console.warn('transactions page: Related Person suggest init failed', e); }

    bindEvents();

    // Expose minimal API for external callers
    window.TransactionModal = { openCreate: openCreateTransaction, openEdit: openEditTransaction };
  }
}
