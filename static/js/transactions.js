// transactions.js - Modal handling and transaction form (create/edit)
// Keeps page template clean; paired with dynamic_app.js for listing & deletion.
(function () {
  'use strict';

  // Ensure core utilities are available (app_core.js must load first)
  if (!window.App || !App.utils) {
    console.error('transactions.js: App.utils is required and not available. Ensure app_core.js loads first.');
    return;
  }

  // DOM refs (assigned during init)
  let modalEl, formEl, titleEl, submitBtn, idInput, symbolPrefixEl, currencySelect, categorySelect, typeSelect, dataList, allOptions;
  let bsModal;

  // ---------------------- Utility Helpers ----------------------
  // Use shared utilities
  const U = App.utils;
  function qs(sel, root = document) { return U.qs(sel, root); }
  function qsa(sel, root = document) { return U.qsa(sel, root); }

  function currentPage() {
    const tbl = qs('[data-transactions-table]');
  return parseInt(tbl.getAttribute('data-current-page') || '1', 10);
  }

  function flash(msg, type) { (typeof window.flash === 'function' ? window.flash(msg, type) : console.log(type || 'info', msg)); }


  function updateCurrencySymbol() {
    if (!currencySelect || !symbolPrefixEl) return;
    const opt = currencySelect.options[currencySelect.selectedIndex] || {};
    symbolPrefixEl.textContent = (opt.dataset && opt.dataset.symbol) || window.currencySymbol || '';
  }


  function filterCategoriesForType(typeVal) {
    // Store current value to restore it after rebuilding
    const currentValue = categorySelect.value;
    
    // Clear current select
    if (categorySelect) App.utils.tools.del_child(categorySelect);

    // Add placeholder
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a category';
    categorySelect.appendChild(placeholder);

    // Add only optgroups that are flagged for the requested type. The template marks optgroups
    // with `data-group-income` or `data-group-expense` and we treat those as authoritative.
    (allOptions || []).forEach(opt => {
      if (!opt || !opt.tagName) return;
      if (opt.tagName.toUpperCase() !== 'OPTGROUP') return;
      if (opt.dataset && ((typeVal === 'income' && opt.dataset.groupIncome !== undefined) || (typeVal === 'expense' && opt.dataset.groupExpense !== undefined))) {
        categorySelect.appendChild(opt.cloneNode(true));
      }
    });

    // Restore the previous value if it exists in the new options, otherwise select placeholder
    if (currentValue) {
      categorySelect.value = currentValue;
      // If the value wasn't successfully set (category doesn't exist for this type), reset to placeholder
      if (categorySelect.value !== currentValue) {
        categorySelect.value = '';
      }
    } else {
      // Ensure placeholder is selected when no previous value
      categorySelect.value = '';
    }
  }


  function loanKind(category) {
    const v = (category || '').toLowerCase();
    if (v === 'repaid by me') return 'repaid_by_me';
    if (v === 'repaid to me') return 'repaid_to_me';
    if (v === 'borrowed' || v === 'lent out') return null; // show all
    return undefined; // non-loan category => clear datalist
  }

  async function refreshCounterparties() {
    const kind = loanKind(categorySelect.value);
    if (typeof kind === 'undefined') { if (dataList) App.utils.tools.del_child(dataList); return; }
    try {
      const url = new URL(window.location.origin + '/api/loans/counterparties');
      if (kind) url.searchParams.set('kind', kind);
      const res = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
      const data = await res.json();
      dataList.innerHTML = (data.items || []).map(n => `<option value="${n}"></option>`).join('');
    } catch {
      if (dataList) App.utils.tools.del_child(dataList);
    }
  }

  // ---------------------- Modal Openers ----------------------
  function openCreateTransaction() {
    formEl.reset();
    idInput.value = '';
    titleEl.textContent = 'Add Transaction';
    submitBtn.textContent = 'Add';
    typeSelect.value = 'income';
    filterCategoriesForType('income');
    updateCurrencySymbol();
    bsModal.show();
  }

  function openEditTransaction(raw) {
    const tx = raw || {};
    formEl.reset();
  const model = window.TransactionModel ? new TransactionModel(tx) : null;
  const dateISO = model ? model.dateISO() : (globalThis.SiteDate.toDateString(tx.date) || '');
    idInput.value = tx._id || '';
    formEl.amount.value = tx.amount_original || tx.amount || '';
    formEl.currency.value = tx.currency || window.currencyCode || '';
    formEl.type.value = tx.type || 'income';
    formEl.description.value = tx.description || '';
  formEl.date.value = dateISO || globalThis.SiteDate.toDateString(new Date());
    formEl.related_person.value = tx.related_person || '';
    titleEl.textContent = 'Edit Transaction';
    submitBtn.textContent = 'Update';
    updateCurrencySymbol();
    // Filter categories first, then set the category value
    filterCategoriesForType(formEl.type.value);
    formEl.category.value = tx.category || '';
    bsModal.show();
    refreshCounterparties();
  }

  // ---------------------- Form Submit ----------------------
  async function handleSubmit(evt) {
    evt.preventDefault();
    App.utils.withSingleFlight(formEl, async () => {
      submitBtn.disabled = true;
      const fd = new FormData(formEl);
      const id = idInput.value.trim();
      const payload = Object.fromEntries(fd.entries());
  if (payload.date instanceof Date) payload.date = globalThis.SiteDate.toDateString(payload.date);
      try {
        const url = id ? `/api/transactions/${id}` : '/api/transactions';
        const method = id ? 'PATCH' : 'POST';
        const data = await App.utils.fetchJSONUnified(url, { method, headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(payload) });
        flash('Transaction saved', 'success');
        bsModal.hide();
        if (window.DashboardTransactionsModule && typeof window.DashboardTransactionsModule.loadTransactionsPage === 'function') {
          window.DashboardTransactionsModule.loadTransactionsPage(currentPage());
        } else if (id && data && data.item) {
          try {
            const tbody = qs('[data-transactions-body]');
            const btn = tbody.querySelector(`[data-edit-id="${id}"]`);
            const row = btn.closest('tr');
            if (row) {
              const item = data.item;
              // Use SiteDate for consistent ISO date formatting (YYYY-MM-DD)
              const dateStr = globalThis.SiteDate.toDateString(item.date || item._date || item.created_at);
              const currencySymbol = qs('[data-transactions-table]').getAttribute('data-currency-symbol') || '';
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
          location.reload();
        }
      } catch (e) {
        if (!(e && e.status)) flash('Save failed', 'danger');
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  // ---------------------- Event Wiring ----------------------
  function bindEvents() {
    // Helper: add listener only when element exists
    function safeAdd(el, ev, handler, opts) {
      if (!el) { console.warn(`transactions.js: missing element for event ${ev}`); return; }
      try { el.addEventListener(ev, handler, opts); } catch (err) { console.warn('transactions.js: failed to bind', ev, err); }
    }

    safeAdd(currencySelect, 'change', updateCurrencySymbol);
    safeAdd(typeSelect, 'change', () => { filterCategoriesForType(typeSelect ? typeSelect.value : 'income'); refreshCounterparties(); });
    safeAdd(categorySelect, 'change', refreshCounterparties);
    safeAdd(formEl, 'submit', handleSubmit);

    // Open create (may live outside modal)
  const openBtn = qs('[data-open-tx-modal]');
  safeAdd(openBtn, 'click', openCreateTransaction);

    // Delegate edit buttons (robust: prefer table root, fallback to document.body)
    function editClickHandler(e) {
      const btn = e.target && e.target.closest ? e.target.closest('[data-edit-id]') : null;
      if (!btn) return;
      e.preventDefault();
      let data = null;
      const raw = btn.getAttribute('data-edit-json');
      if (raw) {
        try { data = JSON.parse(raw); } catch (err) { console.warn('Failed to parse data-edit-json', err, raw); }
      }
      if (!data) {
        // Fallback: construct minimal object from attributes
        data = { _id: btn.getAttribute('data-edit-id') };
      }
      openEditTransaction(data);
    }

    const tableRoot = qs('[data-transactions-table]');
    if (tableRoot) {
      try { tableRoot.addEventListener('click', editClickHandler, { passive: true }); }
      catch (err) { console.warn('transactions.js: failed to bind table click handler', err); }
    } else {
      // Fallback to body-level delegation so dynamic pages still work
      try { document.body.addEventListener('click', editClickHandler, { passive: true }); }
      catch (err) { console.warn('transactions.js: failed to bind body click handler', err); }
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

  // ---------------------- Init ----------------------
  function initTransactionModal() {
  modalEl = qs('#transactionModal');
  // If neither the modal nor the transactions table exist, we're not on the transactions page — bail out.
  const tableRootCheck = qs('[data-transactions-table]');
  if (!modalEl && !tableRootCheck) return; // no transaction UI on this page

  // If modal exists, wire up modal-specific DOM refs. Otherwise (rare) we could still proceed with table-only logic.
  if (modalEl) {
    // If modal is nested inside other containers, move it to body so Bootstrap backdrop layering works correctly.
    if (modalEl.parentElement !== document.body) document.body.appendChild(modalEl);
    formEl = modalEl.querySelector('[data-transaction-form]');
    titleEl = modalEl.querySelector('[data-tx-modal-title]');
    submitBtn = modalEl.querySelector('[data-submit-btn]');
    idInput = modalEl.querySelector('[data-tx-id]');
    symbolPrefixEl = modalEl.querySelector('[data-symbol-prefix]');
    currencySelect = modalEl.querySelector('[data-currency-select]');
    categorySelect = modalEl.querySelector('[data-category-select]');
  }
  // store all options (clones) for dynamic filtering
  allOptions = (categorySelect ? Array.from(categorySelect.querySelectorAll('option, optgroup')).map((opt) => opt.cloneNode(true)) : []);
  typeSelect = formEl.querySelector('[name="type"]');
  dataList = qs('#tx_person_options');

    bsModal = bootstrap.Modal.getOrCreateInstance(modalEl);
  // Assume all required elements are present; allow errors to surface if not
  updateCurrencySymbol();
  filterCategoriesForType(typeSelect.value);
  bindEvents();
  }

  document.addEventListener('DOMContentLoaded', initTransactionModal, { once: true });

  // If URL contains ?openModal=1 trigger creation after modal init
  document.addEventListener('DOMContentLoaded', function () {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('openModal') && typeof window.TransactionModal.openCreate === 'function') {
        // Slight delay to ensure bootstrap modal instance ready
        setTimeout(() => window.TransactionModal.openCreate(), 150);
      }
    } catch (_) { }
  }, { once: true });

  // Expose for potential external use
  window.TransactionModal = { openCreate: openCreateTransaction, openEdit: openEditTransaction };
})();
