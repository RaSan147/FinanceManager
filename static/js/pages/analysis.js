// pages/analysis.js (ES Module)
import { BasePage } from '/static/js/core/page.js';
import ActiveGoalsWidget from '/static/js/widgets/active_goals_widget.js';

export default class AnalysisPage extends BasePage {
  async mount() {
    try { console.debug('[pages/analysis] mount'); } catch(_) {}
    // Mount Active Goals widgets if present
    document.querySelectorAll('[data-active-goals-widget]').forEach(el => {
      const w = this.registerWidget(new ActiveGoalsWidget(el));
      try { w.mount(el); } catch(_) {}
    });
  }
  async refresh() {
    for (const w of this.widgets) { try { await w.refresh?.(); } catch(_) {} }
  }
  async destroy() { await super.destroy(); }
}
