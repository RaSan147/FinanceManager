// widgets/todo_list_widget.js (ES Module)
// Refactored to reuse BlogBaseListWidget (smart diff, single-flight, common toolbar patterns)

import { BlogBaseListWidget } from '/static/js/widgets/blog_base.js';

export default class TodoListWidget extends BlogBaseListWidget {
  constructor(root, options) {
    super(root, Object.assign({
      listElId: 'todoFlatList',
      tmplId: 'todoItemTemplate',
      sortMenuId: 'todoSortMenu',
      sortLabelId: 'todoCurrentSortLabel',
      filterToggleId: 'btnTodoFilterToggle',
      filterBoxId: 'todoInlineFilters',
      applyBtnId: 'btnToDoApplyFilters',
      clearBtnId: 'btnClearFilters',
      searchId: 'todoSearch',
      categoryId: 'todoFilterCategory',
      activeFiltersBarId: 'activeFiltersBar',
      sortPrefName: 'todo',
      changedEvent: 'todo:changed'
    }, options));
    this.state.viewStage = 'all';
  }

  date10(v) { return globalThis.SiteDate?.toDateString?.(v) || ''; }

  buildListUrl(forceFresh=false) {
    let url = `/api/todo?per_page=100` + (forceFresh ? `&__ts=${Date.now()}` : '');
    if (this.state.sortExplicit && this.state.sort) url += `&sort=${encodeURIComponent(this.state.sort)}`;
    if (this.state.viewStage !== 'all') url += `&stage=${encodeURIComponent(this.state.viewStage)}`;
    if (this.state.q) url += `&q=${encodeURIComponent(this.state.q)}`;
    if (this.state.category) url += `&category=${encodeURIComponent(this.state.category)}`;
    return url;
  }

  equalItem(a, b) {
    if (!a || !b) return false;
    return (
      a.title === b.title &&
      a.stage === b.stage &&
      !!a.pinned === !!b.pinned &&
      (a.due_date || '') === (b.due_date || '') &&
      (a.category || '') === (b.category || '') &&
      (a.description || '') === (b.description || '')
    );
  }

  hydrateItem(node, it) {
    node.dataset.id = it._id;
    if (!node.classList.contains('todo-item')) node.classList.add('todo-item');
    node.classList.add(it.stage);
    if (it.stage === 'done') node.classList.add('done');
    // Ensure pinned styling (right yellow border) reflects initial state
    node.classList.toggle('pinned', !!it.pinned);

    const title = node.querySelector('.todo-title'); if (title) title.textContent = it.title || '';
    const cat = node.querySelector('.todo-category');
    if (cat) { try { window.BlogHelpers?.renderCategoryBadges?.(cat, it.category); } catch(_) {} if (cat.textContent) cat.classList.remove('d-none'); }
    const due = node.querySelector('.todo-due'); if (due && it.due_date) { const dStr = this.date10(it.due_date); if (dStr) { due.textContent = dStr; due.classList.remove('d-none'); } }
    const desc = node.querySelector('.todo-desc'); if (desc) desc.textContent = (it.description || '').slice(0, 400) + ((it.description || '').length > 400 ? '…' : '');

    const stageChip = node.querySelector('.todo-stage');
    if (stageChip) {
      const btn = document.querySelector(`#stageViewMenu [data-stage="${it.stage}"]`);
      stageChip.textContent = btn ? (btn.textContent || '').trim() : (String(it.stage || '').replace(/_/g, ' '));
      try { window.BlogHelpers?.applyStageBadge?.(stageChip, it.stage); } catch(_) {}
      stageChip.classList.toggle('d-none', !it.stage);
    }
    const sel = node.querySelector('.todo-stage-select-inline');
    if (sel) { sel.value = it.stage; this.on(sel, 'change', () => this.quickStage(it._id, sel.value, node)); }

    const pinBtn = node.querySelector('.btn-pin');
    if (pinBtn) {
      pinBtn.classList.toggle('btn-warning', !!it.pinned);
      pinBtn.classList.toggle('btn-outline-warning', !it.pinned);
      pinBtn.title = it.pinned ? 'Unpin' : 'Pin';
      const lbl = pinBtn.querySelector('.pin-label') || pinBtn.querySelector('.pinLabel') || pinBtn.querySelector('span'); if (lbl) lbl.textContent = it.pinned ? 'Unpin' : 'Pin';
      this.on(pinBtn, 'click', async (e) => {
        e.stopPropagation();
        const before = !!it.pinned; it.pinned = !before;
        node.classList.toggle('pinned', !!it.pinned);
        pinBtn.classList.toggle('btn-warning', !!it.pinned);
        pinBtn.classList.toggle('btn-outline-warning', !it.pinned);
        pinBtn.title = it.pinned ? 'Unpin' : 'Pin'; if (lbl) lbl.textContent = it.pinned ? 'Unpin' : 'Pin';
        try { await App.utils.fetchJSONUnified(`/api/todo/${it._id}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: it.pinned }) }); await this.fetchList(true); }
        catch(_) { it.pinned = before; node.classList.toggle('pinned', !!it.pinned); pinBtn.classList.toggle('btn-warning', !!it.pinned); pinBtn.classList.toggle('btn-outline-warning', !it.pinned); if (lbl) lbl.textContent = it.pinned ? 'Unpin' : 'Pin'; window.flash?.('Pin toggle failed', 'danger'); this.fetchList(true); }
      });
    }

    const delBtn = node.querySelector('.btn-delete'); if (delBtn) { this.on(delBtn, 'click', (e) => { e.stopPropagation(); this.deleteTodo(it._id); }); }
    this.on(node, 'click', () => { try { App.utils.EventBus?.emit('todo:item:open', { id: it._id }); } catch(_) {} });
  }

  async quickStage(id, newStage, node) {
    const menu = document.getElementById('stageViewMenu');
    const stages = menu ? Array.from(menu.querySelectorAll('[data-stage]')).map(el => el.getAttribute('data-stage')).filter(Boolean) : [];
    if (!stages.includes(newStage)) return;
    node?.classList?.add('opacity-50');
    try { await App.utils.fetchJSONUnified(`/api/todo/${id}/stage`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: newStage }) }); await this.fetchList(true); }
    catch(_) { /* ignore */ }
    finally { node?.classList?.remove('opacity-50'); }
  }

  async deleteTodo(id) {
    if (!confirm('Delete this item?')) return;
    try { await App.utils.fetchJSONUnified(`/api/todo/${id}`, { method: 'DELETE' }); window.flash?.('Deleted', 'info'); this.fetchList(true); }
    catch(_) { window.flash?.('Failed to delete item', 'danger'); }
  }

  bindStageMenu() {
    const stageViewMenu = document.getElementById('stageViewMenu');
    const stageViewLabel = document.getElementById('stageViewLabel');
    if (stageViewMenu && !stageViewMenu._todoWBound) {
      stageViewMenu.querySelectorAll('[data-stage]').forEach(el => {
        this.on(el, 'click', () => {
          const st = el.getAttribute('data-stage'); if (!st) return;
          this.state.viewStage = st; this.fetchList();
          if (stageViewLabel) stageViewLabel.textContent = st === 'all' ? 'All Stages' : st.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          stageViewMenu.querySelectorAll('.dropdown-item').forEach(it => it.classList.toggle('active', it === el));
        });
      });
      stageViewMenu._todoWBound = true;
    }
  }

  async mount(root) { await super.mount(root); this.bindStageMenu(); }
}
