// transactions.js - Modal handling and transaction form (create/edit)
// Keeps page template clean; paired with dynamic_app.js for listing & deletion.
(function () {
  'use strict';

  // DOM refs (assigned during init)
  let modalEl, formEl, titleEl, submitBtn, idInput, symbolPrefixEl, currencySelect, categorySelect, typeSelect, dataList, allOptions;
  let bsModal;

  // ---------------------- Utility Helpers ----------------------
  function qs(sel, root = document) { return root.querySelector(sel); }
  function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

  function currentPage() {
    const tbl = qs('[data-transactions-table]');
    return parseInt(tbl?.getAttribute('data-current-page') || '1', 10);
  }

  function flash(msg, type) { (window.flash && window.flash(msg, type)) || console.log(type || 'info', msg); }


  function updateCurrencySymbol() {
    const opt = currencySelect.options[currencySelect.selectedIndex];
    symbolPrefixEl.textContent = opt?.dataset?.symbol || window.currencySymbol || '';
  }


  function filterCategoriesForType(typeVal) {
    // Store current value to restore it after rebuilding
    const currentValue = categorySelect.value;
    
    // Clear current select
    categorySelect.innerHTML = '';

    // Add placeholder
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a category';
    categorySelect.appendChild(placeholder);

    // Add only options for selected type
    allOptions.forEach(opt => {
      if (opt.tagName === 'OPTION') return; // skip top-level options outside optgroup
      if (typeVal === 'income' && opt.dataset.groupIncome !== undefined) {
        categorySelect.appendChild(opt.cloneNode(true));
      } else if (typeVal === 'expense' && opt.dataset.groupExpense !== undefined) {
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
    if (typeof kind === 'undefined') { dataList.innerHTML = ''; return; }
    try {
      const url = new URL(window.location.origin + '/api/loans/counterparties');
      if (kind) url.searchParams.set('kind', kind);
      const res = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
      const data = await res.json();
      dataList.innerHTML = (data.items || []).map(n => `<option value="${n}"></option>`).join('');
    } catch { dataList.innerHTML = ''; }
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
    const dateISO = model ? model.dateISO() : (typeof tx.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(tx.date) ? tx.date.slice(0, 10) : (window.__normalizeTxDate ? window.__normalizeTxDate(tx.date) : ''));
    idInput.value = tx._id || '';
    formEl.amount.value = tx.amount_original || tx.amount || '';
    formEl.currency.value = tx.currency || window.currencyCode || '';
    formEl.type.value = tx.type || 'income';
    formEl.description.value = tx.description || '';
    formEl.date.value = dateISO || new Date().toISOString().slice(0, 10);
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
      if (payload.date instanceof Date) payload.date = payload.date.toISOString().slice(0, 10);
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
            const btn = tbody?.querySelector(`[data-edit-id="${id}"]`);
            const row = btn?.closest('tr');
            if (row) {
              const item = data.item;
              const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
              const d = new Date(item.date || item._date || item.created_at);
              const dateStr = isNaN(d) ? '' : `${monthNames[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}, ${d.getUTCFullYear()}`;
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
                    date: (item.date || '').slice ? (item.date || '').slice(0, 10) : item.date,
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
    currencySelect.addEventListener('change', updateCurrencySymbol);
    typeSelect.addEventListener('change', () => { filterCategoriesForType(typeSelect.value); refreshCounterparties(); });
    categorySelect.addEventListener('change', refreshCounterparties);
    formEl.addEventListener('submit', handleSubmit);

    // Open create
    qs('[data-open-tx-modal]')?.addEventListener('click', openCreateTransaction);

    // Delegate edit buttons (robust: listen on body AND table root to survive dynamic re-renders)
    function editClickHandler(e) {
      const btn = e.target.closest('[data-edit-id]');
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
    // Single delegated listener at table root (was duplicated on tbody causing double open & potential double-submit side effects)
    const tableRoot = qs('[data-transactions-table]');
    tableRoot && tableRoot.addEventListener('click', editClickHandler, { passive: true });

    modalEl.addEventListener('shown.bs.modal', () => {
      setTimeout(() => formEl.querySelector('input,select,textarea')?.focus(), 35);
    });
  }

  // ---------------------- Init ----------------------
  function initTransactionModal() {
    modalEl = qs('#transactionModal');
    if (!modalEl) return; // Not on transactions page
    // If modal is nested inside other containers, move it to body so Bootstrap backdrop layering works correctly.
    if (modalEl.parentElement !== document.body) {
      document.body.appendChild(modalEl);
    }
    formEl = modalEl.querySelector('[data-transaction-form]');
    titleEl = modalEl.querySelector('[data-tx-modal-title]');
    submitBtn = modalEl.querySelector('[data-submit-btn]');
    idInput = modalEl.querySelector('[data-tx-id]');
    symbolPrefixEl = modalEl.querySelector('[data-symbol-prefix]');
    currencySelect = modalEl.querySelector('[data-currency-select]');
    categorySelect = modalEl.querySelector('[data-category-select]');
    // store all options
    allOptions = Array.from(categorySelect.querySelectorAll('option, optgroup')).map(opt => opt.cloneNode(true));
    console.log('Stored', allOptions, 'category options for dynamic filtering');
    console.trace()
    typeSelect = formEl.querySelector('[name="type"]');
    dataList = qs('#tx_person_options');

    bsModal = bootstrap.Modal.getOrCreateInstance(modalEl);
    updateCurrencySymbol();
    filterCategoriesForType(typeSelect.value);
    bindEvents();
  }

  document.addEventListener('DOMContentLoaded', initTransactionModal, { once: true });

  // If URL contains ?openModal=1 trigger creation after modal init
  document.addEventListener('DOMContentLoaded', function () {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('openModal') && window.TransactionModal && typeof window.TransactionModal.openCreate === 'function') {
        // Slight delay to ensure bootstrap modal instance ready
        setTimeout(() => window.TransactionModal.openCreate(), 150);
      }
    } catch (_) { }
  }, { once: true });

  // Expose for potential external use
  window.TransactionModal = { openCreate: openCreateTransaction, openEdit: openEditTransaction };
})();
