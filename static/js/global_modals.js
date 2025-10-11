// global_modals.js - Provides global access to transaction & goal modals
(function(){
  'use strict';

  // Assume App.utils is registered by app_core.js and available.
  const { qs, qsa, fetchJSON, fetchJSONUnified, withSingleFlight } = App.utils;

  // -------------- Shared Comment & Text Formatting Functions --------------
  
  /**
   * Format comment text while preserving whitespace and line breaks
   * @param {string} text - The raw comment text
   * @returns {string} HTML formatted text with preserved formatting
   */
  // Format comment text preserving indentation and newlines (safe-escapes)
  function formatCommentText(text) {
    if (!text) return '';
    const escaped = text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return escaped
      .split('\n')
      .map(line => {
        const leading = line.match(/^(\s*)/)[1];
        const rest = line.slice(leading.length);
        const preserved = leading.replace(/ /g, '&nbsp;').replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
        return preserved + rest;
      })
      .join('<br/>');
  }

  /**
   * Clear modal form data when modal is closed to prevent state issues
   * @param {HTMLElement} modalElement - The modal element
   * @param {string[]} formSelectors - Array of form selectors within the modal
   */
  // Reset forms and minor aria/focus fixes when bootstrap hides modals
  function setupModalCleanup(modalElement, formSelectors = ['form']) {
    if (!modalElement) return;
    modalElement.addEventListener('hide.bs.modal', () => {
      const focused = modalElement.querySelector(':focus');
      if (focused && modalElement.contains(focused)) focused.blur();
      // Small delay to mirror Bootstrap's internal timing
      setTimeout(() => modalElement.removeAttribute('aria-hidden'), 10);
    });

    modalElement.addEventListener('hidden.bs.modal', () => {
      formSelectors.forEach(selector => {
        modalElement.querySelectorAll(selector).forEach(form => {
          form.reset();
          const preview = form.querySelector('[data-comment-images-preview], [data-diary-comment-images-preview], [data-todo-comment-images-preview]');
          if (preview) preview.innerHTML = '';
          form.querySelectorAll('input[type="hidden"]').forEach(i => i.value = '');
        });
      });
      modalElement.removeAttribute('aria-hidden');
    });
  }

  // Make these functions globally available
  window.CommentFormatter = {
    formatText: formatCommentText,
    setupModalCleanup: setupModalCleanup
  };

  // ---------------- Transaction Modal Lazy Wrapper -----------------
  // Ensure a minimal transaction modal API exists when transactions.js isn't loaded.
  // If full `window.TransactionModal.openCreate` exists, prefer that implementation.
  function ensureTransactionModal() {
    if (typeof window.TransactionModal?.openCreate === 'function') return true;
    const modalEl = qs('#transactionModal');
    if (!modalEl) return false;
    if (modalEl.parentElement !== document.body) document.body.appendChild(modalEl);

    const formEl = modalEl.querySelector('[data-transaction-form]');
    const titleEl = modalEl.querySelector('[data-tx-modal-title]');
    const submitBtn = modalEl.querySelector('[data-submit-btn]');
    const idInput = modalEl.querySelector('[data-tx-id]');
    const currencySelect = modalEl.querySelector('[data-currency-select]');
    const symbolPrefix = modalEl.querySelector('[data-symbol-prefix]');
    const categorySelect = modalEl.querySelector('[data-category-select]');
    const typeSelect = formEl.querySelector('[name="type"]');
    const dataList = qs('#tx_person_options');
    const bsModal = bootstrap.Modal.getOrCreateInstance(modalEl);

    const updateSymbol = () => {
      const opt = currencySelect.options[currencySelect.selectedIndex];
      symbolPrefix.textContent = opt?.dataset?.symbol || window.currencySymbol || '';
    };

    const filterCategories = (typeVal) => {
      const inc = categorySelect.querySelector('[data-group-income]');
      const exp = categorySelect.querySelector('[data-group-expense]');
      if (!inc || !exp) return;
      const current = categorySelect.value;
      if (typeVal === 'income') { inc.style.display = ''; exp.style.display = 'none'; }
      else { exp.style.display = ''; inc.style.display = 'none'; }
      if (current) {
        const isVisible = Array.from(categorySelect.options).some(opt => opt.value === current && opt.offsetParent !== null);
        categorySelect.value = isVisible ? current : '';
      } else {
        categorySelect.value = '';
      }
    };

    const loanKind = (category) => {
      const v = (category || '').toLowerCase();
      if (v === 'repaid by me') return 'repaid_by_me';
      if (v === 'repaid to me') return 'repaid_to_me';
      if (v === 'borrowed' || v === 'lent out') return null;
      return undefined;
    };

    const refreshCounterparties = async () => {
      const kind = loanKind(categorySelect.value);
      if (typeof kind === 'undefined') { if (dataList) dataList.innerHTML = ''; return; }
      try {
        const url = new URL(window.location.origin + '/api/loans/counterparties');
        if (kind) url.searchParams.set('kind', kind);
        const data = await fetchJSON(url.toString(), { headers: { 'Accept': 'application/json' } });
        if (dataList) dataList.innerHTML = (data.items || []).map(n => `<option value="${n}"></option>`).join('');
      } catch { if (dataList) dataList.innerHTML = ''; }
    };

    const openCreate = () => {
      formEl.reset();
      idInput.value = '';
      titleEl.textContent = 'Add Transaction';
      submitBtn.textContent = 'Save';
      typeSelect.value = 'income';
      filterCategories('income');
      updateSymbol();
      bsModal.show();
      refreshCounterparties();
    };

    formEl.addEventListener('submit', (e) => {
      e.preventDefault();
      withSingleFlight(formEl, async () => {
        submitBtn.disabled = true;
        try {
          const fd = new FormData(formEl);
          const payload = Object.fromEntries(fd.entries());
          await fetchJSONUnified('/api/transactions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(payload) });
          window.flash?.('Transaction saved', 'success');
          bsModal.hide();
          window.DashboardTransactionsModule?.refreshDashboardData?.();
            try { window.dispatchEvent(new CustomEvent('transaction:created')); } catch(_) {}
        } catch (err) { window.flash?.('Save failed', 'danger'); }
        finally { submitBtn.disabled = false; }
      });
    });

    currencySelect.addEventListener('change', updateSymbol);
    typeSelect.addEventListener('change', () => { filterCategories(typeSelect.value); refreshCounterparties(); });
    categorySelect.addEventListener('change', refreshCounterparties);

    updateSymbol(); filterCategories(typeSelect.value); refreshCounterparties();

    window.TransactionModal = { openCreate };
    return true;
  }

  // ---------------- Goal Modal Lazy Wrapper -----------------
  // Minimal Goal modal fallback when goals.js isn't present
  function ensureGoalModal() {
    if (typeof window.GoalModal?.openCreate === 'function') return true;
    const modalEl = qs('#goalModal');
    if (!modalEl) return false;
    if (modalEl.parentElement !== document.body) document.body.appendChild(modalEl);

    const form = modalEl.querySelector('[data-goal-form]');
    const titleEl = modalEl.querySelector('[data-goal-modal-title]');
    const idInput = modalEl.querySelector('[data-goal-id]');
    const currencySel = modalEl.querySelector('[data-goal-currency]');
    const symbolPrefix = modalEl.querySelector('[data-goal-symbol-prefix]');
    const submitBtn = modalEl.querySelector('[data-goal-submit-btn]');
    const bsModal = bootstrap.Modal.getOrCreateInstance(modalEl);

    const updateSymbol = () => {
      const opt = currencySel.options[currencySel.selectedIndex];
      symbolPrefix.textContent = opt?.dataset?.symbol || window.currencySymbol || '';
    };

    const openCreate = () => {
      form.reset();
      idInput.value = '';
      titleEl.textContent = 'Add Goal';
      submitBtn.textContent = 'Save';
      modalEl.removeAttribute('aria-hidden');
      modalEl.setAttribute('aria-modal', 'true');
      modalEl.setAttribute('role', 'dialog');
      updateSymbol();
      bsModal.show();
    };

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      withSingleFlight(form, async () => {
        submitBtn.disabled = true;
        try {
          const fd = new FormData(form);
          const payload = Object.fromEntries(fd.entries());
          await fetchJSONUnified('/api/goals', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(payload) });
          window.flash?.('Goal saved', 'success');
          bsModal.hide();
          if (window.GoalsModule?.loadGoals) {
            window.GoalsModule.loadGoals(1);
          } else {
            setTimeout(() => { try { window.GoalsModule?.loadGoals?.(1); } catch (_) {} }, 300);
            setTimeout(() => { try { window.GoalsModule?.loadGoals?.(1); } catch (_) {} }, 1200);
          }
          try { window.dispatchEvent(new CustomEvent('goal:created')); } catch (_) {}
          window.DashboardTransactionsModule?.refreshDashboardData?.();
        } catch (err) { window.flash?.('Save failed', 'danger'); }
        finally { submitBtn.disabled = false; }
      });
    });

    currencySel.addEventListener('change', updateSymbol);
    updateSymbol();

    window.GoalModal = { openCreate };
    return true;
  }

  // ---------------- Global Triggers -----------------
  function bindGlobalTriggers() {
    document.addEventListener('click', (e) => {
      const txBtn = e.target.closest('[data-open-transaction-modal], [data-open-tx-modal]');
      if (txBtn) { e.preventDefault(); if (ensureTransactionModal()) window.TransactionModal.openCreate(); }
      const goalBtn = e.target.closest('[data-open-goal-modal]');
      if (goalBtn) { e.preventDefault(); if (ensureGoalModal()) window.GoalModal.openCreate(); }
    });
  }

  // ---------------- Auto Refresh Dashboard Recent -----------------
  function setupDashboardAutoRefresh() {
    const DASH_INTERVAL_MS = 60_000; // 1m
    if (!document.querySelector('[data-dynamic-dashboard]')) return;
    if (window.__dashAutoRefreshAttached) return;
    window.__dashAutoRefreshAttached = true;
    setInterval(() => { try { window.DashboardTransactionsModule?.refreshDashboardData?.(); } catch (_) {} }, DASH_INTERVAL_MS);
  }

  document.addEventListener('DOMContentLoaded', function () {
    bindGlobalTriggers();
    setupDashboardAutoRefresh();
    // Ensure only one bootstrap modal visible at once
    if (!window.__singleModalEnforced) {
      window.__singleModalEnforced = true;
      document.addEventListener('show.bs.modal', (ev) => {
        const incoming = ev.target;
        document.querySelectorAll('.modal.show').forEach(m => {
          if (m !== incoming) { const inst = bootstrap.Modal.getInstance(m); inst && inst.hide(); }
        });
      });
    }
  });

  // Keyboard shortcuts (Alt+T, Alt+G)
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      if (e.code === 'KeyT') { if (ensureTransactionModal()) { e.preventDefault(); window.TransactionModal.openCreate(); } }
      if (e.code === 'KeyG') { if (ensureGoalModal()) { e.preventDefault(); window.GoalModal.openCreate(); } }
    }
  });
})();
