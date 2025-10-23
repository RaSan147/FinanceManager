// pages/profile.js (ES Module)
import { BasePage } from '/static/js/core/page.js';

export default class ProfilePage extends BasePage {
  async mount() {
    try { console.debug('[pages/profile] mount'); } catch(_) {}
  }
  async refresh() {}
  async destroy() { await super.destroy(); }
}
