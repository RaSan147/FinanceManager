// global_modals.js - Provides global access to transaction & goal modals
(function(){
  'use strict';

  // Utility helpers (lightweight fallback if App.utils not yet loaded)
  const U = window.App?.utils || {
    qs: (s, r=document)=>r.querySelector(s),
    qsa: (s, r=document)=>Array.from(r.querySelectorAll(s)),
    fetchJSON: async (url, opts={}) => {
      const res = await fetch(url, opts); if(!res.ok) throw new Error('HTTP '+res.status); return res.json();
    }
  };

  // ---------------- Transaction Modal Lazy Wrapper -----------------
  function ensureTransactionModal(){
    if (window.TransactionModal && typeof window.TransactionModal.openCreate === 'function') return true; // transactions.js already loaded
    // If modal element exists but logic not loaded (transactions.js only loads on transactions page)
    // Provide minimal on-demand logic (create only) for global use.
  const modalEl = U.qs('#transactionModal');
    if(!modalEl) return false;
  // Ensure appended to body for consistent stacking
  if(modalEl.parentElement !== document.body) document.body.appendChild(modalEl);
    const formEl = modalEl.querySelector('[data-transaction-form]');
    const titleEl = modalEl.querySelector('[data-tx-modal-title]');
    const submitBtn = modalEl.querySelector('[data-submit-btn]');
    const idInput = modalEl.querySelector('[data-tx-id]');
    const currencySelect = modalEl.querySelector('[data-currency-select]');
    const symbolPrefix = modalEl.querySelector('[data-symbol-prefix]');
    const categorySelect = modalEl.querySelector('[data-category-select]');
    const typeSelect = formEl.querySelector('[name="type"]');
    const dataList = U.qs('#tx_person_options');
    const bsModal = bootstrap.Modal.getOrCreateInstance(modalEl);

    function updateSymbol(){
      const opt = currencySelect.options[currencySelect.selectedIndex];
      symbolPrefix.textContent = opt?.dataset?.symbol || window.currencySymbol || '';
    }
    function filterCategories(typeVal){
      const inc = categorySelect.querySelector('[data-group-income]');
      const exp = categorySelect.querySelector('[data-group-expense]');
      if(!inc||!exp) return;
      if(typeVal==='income'){ inc.style.display=''; exp.style.display='none'; }
      else { exp.style.display=''; inc.style.display='none'; }
    }
    function loanKind(category){
      const v=(category||'').toLowerCase();
      if(v==='repaid by me') return 'repaid_by_me';
      if(v==='repaid to me') return 'repaid_to_me';
      if(v==='borrowed'||v==='lent out') return null;
      return undefined;
    }
    async function refreshCounterparties(){
      const kind = loanKind(categorySelect.value);
      if(typeof kind === 'undefined'){ dataList && (dataList.innerHTML=''); return; }
      try {
        const url = new URL(window.location.origin + '/api/loans/counterparties');
        if(kind) url.searchParams.set('kind', kind);
        const data = await U.fetchJSON(url.toString(), { headers: { 'Accept':'application/json' }});
        if(dataList) dataList.innerHTML = (data.items||[]).map(n=>`<option value="${n}"></option>`).join('');
      } catch { if(dataList) dataList.innerHTML=''; }
    }

    function openCreate(){
      formEl.reset();
      idInput.value='';
      titleEl.textContent='Add Transaction';
      submitBtn.textContent='Save';
      typeSelect.value='income';
      filterCategories('income');
      updateSymbol();
      bsModal.show();
      refreshCounterparties();
    }

    formEl.addEventListener('submit', (e)=>{
      e.preventDefault();
      (window.App?.utils?.withSingleFlight || ((el,fn)=>fn()))(formEl, async () => {
        submitBtn.disabled = true;
        try {
          const fd = new FormData(formEl);
          const payload = Object.fromEntries(fd.entries());
          await (window.App?.utils?.fetchJSONUnified || U.fetchJSON)('/api/transactions', { method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body: JSON.stringify(payload)});
          window.flash && window.flash('Transaction saved','success');
          bsModal.hide();
          window.DashboardTransactionsModule?.refreshDashboardData?.();
        } catch(err){ window.flash && window.flash('Save failed','danger'); }
        finally { submitBtn.disabled=false; }
      });
    });

    currencySelect.addEventListener('change', updateSymbol);
    typeSelect.addEventListener('change', ()=>{ filterCategories(typeSelect.value); refreshCounterparties(); });
    categorySelect.addEventListener('change', refreshCounterparties);

    updateSymbol(); filterCategories(typeSelect.value); refreshCounterparties();

    window.TransactionModal = { openCreate };
    return true;
  }

  // ---------------- Goal Modal Lazy Wrapper -----------------
  function ensureGoalModal(){
    if(window.GoalModal && typeof window.GoalModal.openCreate==='function') return true;
  const modalEl = U.qs('#goalModal');
    if(!modalEl) return false;
  if(modalEl.parentElement !== document.body) document.body.appendChild(modalEl);
    const form = modalEl.querySelector('[data-goal-form]');
    const titleEl = modalEl.querySelector('[data-goal-modal-title]');
    const idInput = modalEl.querySelector('[data-goal-id]');
    const currencySel = modalEl.querySelector('[data-goal-currency]');
    const symbolPrefix = modalEl.querySelector('[data-goal-symbol-prefix]');
    const submitBtn = modalEl.querySelector('[data-goal-submit-btn]');
    const bsModal = bootstrap.Modal.getOrCreateInstance(modalEl);

    function updateSymbol(){
      const opt = currencySel.options[currencySel.selectedIndex];
      symbolPrefix.textContent = opt?.dataset?.symbol || window.currencySymbol || '';
    }

    function openCreate(){
      form.reset();
      idInput.value='';
      titleEl.textContent='Add Goal';
      submitBtn.textContent='Save';
  // Sanitize any stale aria-hidden left if previously force-closed
  modalEl.removeAttribute('aria-hidden');
  modalEl.setAttribute('aria-modal','true');
  modalEl.setAttribute('role','dialog');
      updateSymbol();
      bsModal.show();
    }

    form.addEventListener('submit', (e)=>{
      e.preventDefault();
      (window.App?.utils?.withSingleFlight || ((el,fn)=>fn()))(form, async () => {
        submitBtn.disabled = true;
        try {
          const fd = new FormData(form);
          const payload = Object.fromEntries(fd.entries());
          await (window.App?.utils?.fetchJSONUnified || U.fetchJSON)('/api/goals', { method:'POST', headers:{'Content-Type':'application/json','Accept':'application/json'}, body: JSON.stringify(payload)});
          window.flash && window.flash('Goal saved','success');
          bsModal.hide();
          if(window.GoalsModule?.loadGoals) {
            window.GoalsModule.loadGoals(1);
          } else {
            setTimeout(()=>{ try { window.GoalsModule?.loadGoals?.(1); } catch(_){} }, 300);
            setTimeout(()=>{ try { window.GoalsModule?.loadGoals?.(1); } catch(_){} }, 1200);
          }
          try { window.dispatchEvent(new CustomEvent('goal:created')); } catch(_) {}
          window.DashboardTransactionsModule?.refreshDashboardData?.();
        } catch(err){ window.flash && window.flash('Save failed','danger'); }
        finally { submitBtn.disabled=false; }
      });
    });

    currencySel.addEventListener('change', updateSymbol);
    updateSymbol();

    window.GoalModal = { openCreate };
    return true;
  }

  // ---------------- Global Triggers -----------------
  function bindGlobalTriggers(){
    document.addEventListener('click', (e)=>{
      const txBtn = e.target.closest('[data-open-transaction-modal]');
      if(txBtn){ e.preventDefault(); if(ensureTransactionModal()) window.TransactionModal.openCreate(); }
      const goalBtn = e.target.closest('[data-open-goal-modal]');
      if(goalBtn){ e.preventDefault(); if(ensureGoalModal()) window.GoalModal.openCreate(); }
    });
  }

  // ---------------- Auto Refresh Dashboard Recent -----------------
  function setupDashboardAutoRefresh(){
    const DASH_INTERVAL_MS = 60_000; // 1m
    if(!document.querySelector('[data-dynamic-dashboard]')) return;
    if(window.__dashAutoRefreshAttached) return; // idempotent
    window.__dashAutoRefreshAttached = true;
    setInterval(()=>{
      try { window.DashboardTransactionsModule?.refreshDashboardData?.(); } catch(_){ }
    }, DASH_INTERVAL_MS);
  }

  document.addEventListener('DOMContentLoaded', function(){
    bindGlobalTriggers();
    setupDashboardAutoRefresh();
  });

  // Keyboard shortcuts (Alt+T, Alt+G)
  document.addEventListener('keydown', (e)=>{
    if(e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey){
      if(e.code === 'KeyT'){ if(ensureTransactionModal()) { e.preventDefault(); window.TransactionModal.openCreate(); } }
      if(e.code === 'KeyG'){ if(ensureGoalModal()) { e.preventDefault(); window.GoalModal.openCreate(); } }
    }
  });
})();
