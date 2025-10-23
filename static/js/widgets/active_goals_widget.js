// widgets/active_goals_widget.js (ES Module)
// Class-based Active Goals widget using BaseWidget lifecycle.
// Renders compact goal cards for dashboard/analysis.

import { BaseWidget } from '/static/js/core/widget.js';

export class ActiveGoalsWidget extends BaseWidget {
  constructor(root, options) {
    super(root, options);
  }

  fmtNumber(val, digits = 2) {
    try { return Number(val).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
    catch (_) { return (Number(val) || 0).toFixed(digits); }
  }

  currencyFor(goal) {
    try {
      const code = (goal.currency || window.currencyCode || '').toString().toUpperCase();
      return window.currencySymbols?.[code] || window.currencySymbol || '$';
    } catch (_) { return window.currencySymbol || '$'; }
  }

  makeLoader() { return App?.utils?.ui?.createLoader?.({ lines: 3 }) || document.createTextNode('Loading...'); }

  renderCompactGoal(item, mode = 'dashboard') {
    const progress = item.progress || {};
    const current = Number(progress.current_amount ?? item.current_amount ?? 0);
    const target = Number(progress.target_amount ?? item.target_amount ?? 0);
    const pctRaw = Number(progress.progress_percent ?? (target ? (current / target) * 100 : 0));
    const pct = Math.max(0, Math.min(100, pctRaw || 0));
    const symbol = this.currencyFor(item);
    const targetDate = item.target_date ? item.target_date.slice(0, 10) : '';

    if (mode === 'dashboard') {
      const container = document.createElement('div');
      container.className = 'mb-3 goal-item';
      const h6 = document.createElement('h6'); h6.textContent = item.description || '(Untitled)';
      container.appendChild(h6);

      const info = document.createElement('div'); info.className = 'd-flex justify-content-between mb-1';
      const left = document.createElement('small'); left.textContent = `Target: ${symbol}${this.fmtNumber(target, 2)}`;
      const right = document.createElement('small'); right.textContent = targetDate || '';
      info.appendChild(left); info.appendChild(right); container.appendChild(info);

      const progEl = document.createElement('new-progress');
      progEl.setAttribute('value', String(target > 0 ? pct : 0));
      progEl.setAttribute('height', '20');
      container.appendChild(progEl);
      return container;
    }

    // analysis mode: richer card layout
    const container = document.createElement('div');
    container.className = 'mb-4';
    const h5 = document.createElement('h5'); h5.textContent = item.description || '(Untitled)';
    container.appendChild(h5);

    const progressRow = document.createElement('div'); progressRow.className = 'd-flex justify-content-between mb-1';
    const progText = document.createElement('span');
    progText.textContent = `Progress: ${symbol}${this.fmtNumber(current, 2)} of ${symbol}${this.fmtNumber(target, 2)}`;
    progressRow.appendChild(progText); container.appendChild(progressRow);

    const progEl = document.createElement('new-progress');
    progEl.className = 'mb-2';
    progEl.setAttribute('value', String(target > 0 ? pct : 0));
    progEl.setAttribute('height', '20');
    container.appendChild(progEl);

    const datesRow = document.createElement('div'); datesRow.className = 'd-flex justify-content-between';
    const started = item.created_at ? item.created_at.slice(0, 10) : '';
    const targ = item.target_date ? item.target_date.slice(0, 10) : '';
    const leftSmall = document.createElement('small'); leftSmall.textContent = `Started: ${started}`;
    const rightSmall = document.createElement('small'); rightSmall.textContent = `Target: ${targ}`;
    datesRow.appendChild(leftSmall); datesRow.appendChild(rightSmall); container.appendChild(datesRow);
    return container;
  }

  async fetchGoals(perPage = 5, mode = 'dashboard') {
    const url = `/api/goals/trimmed?per_page=${encodeURIComponent(perPage)}&mode=${encodeURIComponent(mode)}`;
    try {
      return await App.utils.fetchJSONUnified(url, { dedupe: true });
    } catch (e) { console.warn('ActiveGoalsWidget fetch failed', e); return null; }
  }

  async mount(root) {
    super.mount(root);
    if (!this.root) return;
    const perPage = parseInt(this.root.dataset.perPage || this.root.getAttribute('data-per-page') || '5', 10) || 5;
    const mode = (this.root.dataset.mode || this.root.getAttribute('data-mode') || 'dashboard');
    // Use shared loader for consistent UX
    try { App?.utils?.ui?.showLoader?.(this.root, { lines: mode === 'analysis' ? 4 : 3 }); }
    catch(_) { this.root.innerHTML = ''; const loader = this.makeLoader(); this.root.appendChild(loader); }
    const data = await this.fetchGoals(perPage, mode);
    // Clear container before render
    try { App?.utils?.tools?.del_child?.(this.root); } catch(_) { this.root.innerHTML = ''; }

    if (!data || !Array.isArray(data.items)) {
      this.root.innerHTML = '<div class="text-muted small">Failed to load goals</div>';
      return;
    }
    if (!data.items.length) {
      this.root.innerHTML = '<div class="text-center text-muted small py-3">No active goals.</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    data.items.slice(0, perPage).forEach(it => frag.appendChild(this.renderCompactGoal(it, mode)));
    this.root.appendChild(frag);
    if (mode === 'analysis') {
      const btnWrap = document.createElement('div'); btnWrap.className = 'text-end mt-2';
      btnWrap.innerHTML = `<a class="btn btn-sm btn-glassy" href="/goals">View All Goals</a>`;
      this.root.appendChild(btnWrap);
    }
  }

  async refresh() {
    // Re-run mount to refresh contents
    await this.mount(this.root);
  }
}

export default ActiveGoalsWidget;
