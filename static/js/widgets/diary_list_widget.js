// widgets/diary_list_widget.js
// Diary list with smart refresh using BlogBaseListWidget

import { BlogBaseListWidget } from '/static/js/widgets/blog_base.js';

export default class DiaryListWidget extends BlogBaseListWidget {
  constructor(root, options) {
    super(root, Object.assign({
      listElId: 'diaryList',
      tmplId: 'diaryItemTemplate',
      sortMenuId: 'diarySortMenu',
      sortLabelId: 'diaryCurrentSortLabel',
      filterToggleId: 'btnDiaryFilterToggle',
      filterBoxId: 'diaryInlineFilters',
      applyBtnId: 'btnDiaryApplyFilters',
      clearBtnId: 'btnDiaryClearFilters',
      searchId: 'diarySearch',
      categoryId: 'diaryFilterCategory',
      activeFiltersBarId: 'diaryActiveFiltersBar',
      sortPrefName: 'diary',
      changedEvent: 'diary:changed'
    }, options));
  }

  date10(v) { return globalThis.SiteDate?.toDateString?.(v) || ''; }
  truncate(txt, lim=300) { return (!txt) ? '' : (txt.length>lim ? txt.slice(0, lim) + '…' : txt); }

  buildListUrl(forceFresh=false) {
    let url = `/api/diary?per_page=100` + (forceFresh ? `&__ts=${Date.now()}` : '');
    if (this.state.q) url += `&q=${encodeURIComponent(this.state.q)}`;
    if (this.state.category) url += `&category=${encodeURIComponent(this.state.category)}`;
    if (this.state.sortExplicit && this.state.sort) url += `&sort=${encodeURIComponent(this.state.sort)}`;
    return url;
  }

  equalItem(a, b) {
    return (
      (a?.title||'') === (b?.title||'') &&
      (Array.isArray(a?.category)?a.category.join(','):a?.category||'') === (Array.isArray(b?.category)?b.category.join(','):b?.category||'') &&
      !!a?.pinned === !!b?.pinned &&
      (a?.content||'') === (b?.content||'')
    );
  }

  hydrateItem(node, it) {
    node.dataset.id = it._id;
    // Ensure base class and pinned visual state
    if (!node.classList.contains('diary-item')) node.classList.add('diary-item');
    node.classList.toggle('pinned', !!it.pinned);
    const title = node.querySelector('.diary-title'); if (title) title.textContent = it.title || '(Untitled)';
    const cat = node.querySelector('.diary-category');
    if (cat) { try { window.BlogHelpers?.renderCategoryBadges?.(cat, it.category); } catch(_) {} if (cat.textContent) cat.classList.remove('d-none'); }
    const cEl = node.querySelector('.diary-content-trunc'); if (cEl) cEl.textContent = this.truncate(it.content || '');

    // Pin
    const pinBtn = node.querySelector('.btn-pin');
    if (pinBtn) {
      pinBtn.classList.toggle('btn-warning', !!it.pinned);
      pinBtn.classList.toggle('btn-outline-warning', !it.pinned);
      pinBtn.title = it.pinned ? 'Unpin' : 'Pin';
      const lbl = pinBtn.querySelector('.pin-label') || pinBtn.querySelector('span'); if (lbl) lbl.textContent = it.pinned ? 'Unpin' : 'Pin';
      this.on(pinBtn, 'click', async (e) => {
        e.stopPropagation();
        const before = !!it.pinned; it.pinned = !before;
        node.classList.toggle('pinned', !!it.pinned);
        pinBtn.classList.toggle('btn-warning', !!it.pinned);
        pinBtn.classList.toggle('btn-outline-warning', !it.pinned);
        pinBtn.title = it.pinned ? 'Unpin' : 'Pin'; if (lbl) lbl.textContent = it.pinned ? 'Unpin' : 'Pin';
        try { await App.utils.fetchJSONUnified(`/api/diary/${it._id}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: it.pinned }) }); await this.fetchList(true); }
        catch(_) { it.pinned = before; window.flash?.('Pin toggle failed', 'danger'); this.fetchList(true); }
      });
    }

    // Delete
    const delBtn = node.querySelector('.btn-delete'); if (delBtn) {
      this.on(delBtn, 'click', async (e) => { e.stopPropagation(); if (!confirm('Delete this entry?')) return; try { await App.utils.fetchJSONUnified(`/api/diary/${it._id}`, { method: 'DELETE' }); window.flash?.('Deleted', 'info'); App.utils.EventBus?.emit('diary:changed'); } catch(_) { window.flash?.('Delete failed', 'danger'); } });
    }

    // Open detail
    this.on(node, 'click', () => { try { App.utils.EventBus?.emit('diary:item:open', { id: it._id }); } catch(_) {} });
  }
}
