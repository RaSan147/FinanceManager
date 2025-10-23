// pages/purchase_advisor.js (ES Module)
import { BasePage } from '/static/js/core/page.js';

export default class PurchaseAdvisorPage extends BasePage {
  async mount() {
    try { console.debug('[pages/purchase_advisor] mount'); } catch(_) {}
    try {
      // Ensure charts and history are rendered on entry
      if (window.PurchaseAdvisor?.loadVisualizationData) await window.PurchaseAdvisor.loadVisualizationData();
      if (window.PurchaseAdvisor?.loadRecommendationHistory) await window.PurchaseAdvisor.loadRecommendationHistory();
    } catch(_) {}
  }
  async refresh() {
    try {
      if (window.PurchaseAdvisor?.loadVisualizationData) await window.PurchaseAdvisor.loadVisualizationData();
      if (window.PurchaseAdvisor?.loadRecommendationHistory) await window.PurchaseAdvisor.loadRecommendationHistory();
    } catch(_) {}
  }
  async destroy() { await super.destroy(); }
}
