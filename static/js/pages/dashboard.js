// pages/dashboard.js (ES Module)
// Object-oriented page entry for Dashboard.
import { BasePage } from '/static/js/core/page.js';
import ActiveGoalsWidget from '/static/js/widgets/active_goals_widget.js';

export default class DashboardPage extends BasePage {
  async mount() {
    try { console.debug('[pages/dashboard] mount', { page: this.pageName }); } catch(_) {}

    // Enable conservative SPA link interception (optional)
    try { this.utils?.enableSPALinkInterception?.(); } catch(_) {}

    // Kick an initial refresh if the dashboard widget area exists
    if (document.querySelector('[data-dynamic-dashboard]') &&
        window.DashboardTransactionsModule?.refreshDashboardData) {
      try { await window.DashboardTransactionsModule.refreshDashboardData(); } catch(_) {}
    }

    // Mount Active Goals widgets if present
    document.querySelectorAll('[data-active-goals-widget]').forEach(el => {
      const w = this.registerWidget(new ActiveGoalsWidget(el));
      try { w.mount(el); } catch(_) {}
    });
  }

  async refresh() {
    try {
      await window.DashboardTransactionsModule?.refreshDashboardData?.();
    } catch(_) {}
    // Refresh widgets
    for (const w of this.widgets) { try { await w.refresh?.(); } catch(_) {} }
  }

  async destroy() {
    await super.destroy();
    // nothing else to cleanup for now
  }
}
