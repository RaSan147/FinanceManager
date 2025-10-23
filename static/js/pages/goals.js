// pages/goals.js (ES Module)
import { BasePage } from '/static/js/core/page.js';

export default class GoalsPage extends BasePage {
  async mount() {
    try { console.debug('[pages/goals] mount'); } catch(_) {}
    // Keep minimal: existing goals.js binds handlers via App.init().
    // Optionally kick a refresh if needed (no global to call safely here).
    try {
      // If the goals list exists and module loaded, ensure first page loads
      if (document.querySelector('[data-goals-list]') && window.GoalsModule?.loadGoals) {
        await window.GoalsModule.loadGoals(1);
      }
    } catch(_) {}
  }
  async refresh() {
    try {
      if (document.querySelector('[data-goals-list]') && window.GoalsModule?.loadGoals) {
        // Reload current page if state available, else page 1
        const p = (window.GoalsModule?.state?.page) || 1;
        await window.GoalsModule.loadGoals(p);
      }
    } catch(_) {}
  }
  async destroy() { await super.destroy(); }
}
