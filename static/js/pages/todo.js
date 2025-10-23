// pages/todo.js (ES Module)
import { BasePage } from '/static/js/core/page.js';
import TodoListWidget from '/static/js/widgets/todo_list_widget.js';
import TodoCreateWidget from '/static/js/widgets/todo_create_widget.js';
import TodoDetailWidget from '/static/js/widgets/todo_detail_widget.js';

export default class TodoPage extends BasePage {
  async mount() {
    try { console.debug('[pages/todo] mount'); } catch(_) {}
    const root = document;
    // Mount create, list, and detail widgets
    const createW = this.registerWidget(new TodoCreateWidget(root));
    const listW = this.registerWidget(new TodoListWidget(root));
    const detailW = this.registerWidget(new TodoDetailWidget(root));
    try { await createW.mount(root); } catch(_) {}
    try { await listW.mount(root); } catch(_) {}
    try { await detailW.mount(root); } catch(_) {}
  }
  async refresh() {
    // Refresh widgets
    for (const w of this.widgets) { try { await w.refresh?.(); } catch(_) {} }
  }
  async destroy() { await super.destroy(); }
}
