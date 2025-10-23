// pages/diary.js
import { BasePage } from '/static/js/core/page.js';
import DiaryListWidget from '/static/js/widgets/diary_list_widget.js';
import DiaryCreateWidget from '/static/js/widgets/diary_create_widget.js';
import DiaryDetailWidget from '/static/js/widgets/diary_detail_widget.js';

export default class DiaryPage extends BasePage {
  async mount() {
    const root = document;
    const createW = this.registerWidget(new DiaryCreateWidget(root));
    const listW = this.registerWidget(new DiaryListWidget(root));
    const detailW = this.registerWidget(new DiaryDetailWidget(root));
    try { await createW.mount(root); } catch(_) {}
    try { await listW.mount(root); } catch(_) {}
    try { await detailW.mount(root); } catch(_) {}
  }
  async refresh() {
    for (const w of this.widgets) { try { await w.refresh?.(); } catch(_) {} }
  }
  async destroy() { await super.destroy(); }
}
// end
