/* Active Goals Widget
   - Finds elements with [data-active-goals-widget] and fetches /api/goals/list?per_page=... to render
   - mode: 'dashboard' -> shows target date + money need (max 5)
           'analysis'  -> shows start date, target date, money have + money need, plus View All
*/
(function(){
  if (window.__activeGoalsWidgetLoaded) return; window.__activeGoalsWidgetLoaded = true;

  const qs = sel => document.querySelector(sel);
  const qsa = sel => Array.from(document.querySelectorAll(sel));

  function fmtNumber(val, digits=2) {
    try {
      return Number(val).toLocaleString(undefined, {minimumFractionDigits: digits, maximumFractionDigits: digits});
    } catch (e) { return (Number(val) || 0).toFixed(digits); }
  }

  function currencyFor(goal) {
    try {
      const code = (goal.currency || window.currencyCode || '').toString().toUpperCase();
      return window.currencySymbols?.[code] || window.currencySymbol || '$';
    } catch (e) { return window.currencySymbol || '$'; }
  }

  async function fetchGoals(perPage=5, mode='dashboard') {
    // Use trimmed API which returns only the fields needed by the widget
    const url = `/api/goals/trimmed?per_page=${encodeURIComponent(perPage)}&mode=${encodeURIComponent(mode)}`;
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('fetch failed');
      return await res.json();
    } catch (e) { console.warn('activeGoalsWidget fetch failed', e); return null; }
  }

  function makeLoader() {
    // Use shared loader utility for consistency
    return App.utils.ui.createLoader({ lines: 3 });
  }

  function renderCompactGoal(item, mode='dashboard') {
    // item: goal dict from API (includes progress)
    const progress = item.progress || {};
    const current = Number(progress.current_amount ?? item.current_amount ?? 0);
    const target = Number(progress.target_amount ?? item.target_amount ?? 0);
    const remaining = Math.max(0, target - current);
    const pctRaw = Number(progress.progress_percent ?? (target ? (current / target) * 100 : 0));
    const pct = Math.max(0, Math.min(100, pctRaw || 0));
    const symbol = currencyFor(item);
  const targetDate = item.target_date ? item.target_date.slice(0,10) : '';

    // If dashboard mode, render compact old-style item markup
    if (mode === 'dashboard') {
  const container = document.createElement('div');
  container.className = 'mb-3 goal-item';
      const h6 = document.createElement('h6'); h6.textContent = item.description || '(Untitled)';
      container.appendChild(h6);

      const info = document.createElement('div'); info.className = 'd-flex justify-content-between mb-1';
      const left = document.createElement('small'); left.textContent = `Target: ${symbol}${fmtNumber(target,2)}`;
      const right = document.createElement('small'); right.textContent = targetDate || '';
      info.appendChild(left);
      info.appendChild(right);
      container.appendChild(info);

  const progEl = document.createElement('new-progress');
  progEl.setAttribute('value', String(target > 0 ? pct : 0));
  progEl.setAttribute('height', '20');
  container.appendChild(progEl);
      return container;
    }

    // Card container (analysis mode should look like the user's sample)
    const container = document.createElement('div');
    container.className = 'mb-4';

    const h5 = document.createElement('h5'); h5.textContent = item.description || '(Untitled)';
    container.appendChild(h5);

    // Progress row: 'Progress: X of Y' on left, percentage removed (only inside bar)
    const progressRow = document.createElement('div'); progressRow.className = 'd-flex justify-content-between mb-1';
    const progText = document.createElement('span');
    progText.textContent = `Progress: ${symbol}${fmtNumber(current,2)} of ${symbol}${fmtNumber(target,2)}`;
    progressRow.appendChild(progText);
    // intentionally omit external percentage span; percentage will be inside the bar
    container.appendChild(progressRow);

    // Progress bar with centered percentage text and high-contrast styling
  const progEl = document.createElement('new-progress');
  progEl.className = 'mb-2';
  progEl.setAttribute('value', String(target > 0 ? pct : 0));
  progEl.setAttribute('height', '20');
  container.appendChild(progEl);

    // Started / Target small row
    const datesRow = document.createElement('div'); datesRow.className = 'd-flex justify-content-between';
    const started = item.created_at ? item.created_at.slice(0,10) : '';
    const targ = item.target_date ? item.target_date.slice(0,10) : '';
    const leftSmall = document.createElement('small'); leftSmall.textContent = `Started: ${started}`;
    const rightSmall = document.createElement('small'); rightSmall.textContent = `Target: ${targ}`;
    datesRow.appendChild(leftSmall);
    datesRow.appendChild(rightSmall);
    container.appendChild(datesRow);

    return container;
  }

  async function initWidget(el) {
    const perPage = parseInt(el.dataset.perPage || el.getAttribute('data-per-page') || '5', 10) || 5;
    const mode = (el.dataset.mode || el.getAttribute('data-mode') || 'dashboard');
    // show loader
    el.innerHTML = '';
  const loader = makeLoader(); el.appendChild(loader);

  const data = await fetchGoals(perPage, mode);
  el.removeChild(loader);
    if (!data || !Array.isArray(data.items)) {
      el.innerHTML = '<div class="text-muted small">Failed to load goals</div>';
      return;
    }

    if (!data.items.length) {
      el.innerHTML = '<div class="text-center text-muted small py-3">No active goals.</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    const items = data.items.slice(0, perPage);
    items.forEach(it => frag.appendChild(renderCompactGoal(it, mode)));
    el.appendChild(frag);

    if (mode === 'analysis') {
      const btn = document.createElement('div'); btn.className='text-end mt-2';
      btn.innerHTML = `<a class="btn btn-sm btn-glassy" href="/goals">View All Goals</a>`;
      el.appendChild(btn);
    }
  }

  function boot() {
    qsa('[data-active-goals-widget]').forEach(el => {
      try { initWidget(el); } catch (e) { console.error('activeGoalsWidget init failed', e); }
    });
  }

  // Boot after DOM content loaded
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

})();
