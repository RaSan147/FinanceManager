(() => {
	if (window.__todoModuleLoaded) return;
	window.__todoModuleLoaded = true;
	const TODO_DEBUG = true; // set true to enable debug logging for edit-state cache
	const modalEl = document.getElementById('todoModal');
	if (!modalEl) return;
	const form = modalEl.querySelector('[data-todo-form]');
	const titleEl = modalEl.querySelector('[data-todo-modal-title]');
	const idInput = form.querySelector('[data-todo-id]');
	const submitBtn = form.querySelector('[data-todo-submit-btn]');
	const stageSelect = form.querySelector('[data-todo-stage-select]');
	const metaEl = form.querySelector('[data-todo-meta]');
	let bsModal = window.bootstrap ? bootstrap.Modal.getOrCreateInstance(modalEl) : null;

	const listEl = document.getElementById('todoFlatList');
	const tmpl = document.getElementById('todoItemTemplate');
	// Support multiple "new" buttons (header + toolbar)
	const btnNews = [document.getElementById('btnNewTodoTop')].filter(Boolean);
	const stageViewMenu = document.getElementById('stageViewMenu');
	const stageViewLabel = document.getElementById('stageViewLabel');
	const filterToggle = document.getElementById('btnTodoFilterToggle');
	const categorySel = document.getElementById('todoFilterCategory');
	const searchEl = document.getElementById('todoSearch');
	const btnToDoApplyFilters = document.getElementById('btnToDoApplyFilters');
	const btnClearFilters = document.getElementById('btnClearFilters');
	const sortMenuEl = document.getElementById('sortMenu');
	const currentSortLabel = document.getElementById('currentSortLabel');
	const activeFiltersBar = document.getElementById('activeFiltersBar');
	if (!listEl || !tmpl) return;

	const stages = ['wondering', 'planning', 'in_progress', 'paused', 'gave_up', 'done'];
	const state = {
		// sort: current sort key. We deliberately avoid sending it to the API
		// until the user explicitly chooses a sort so that the server can
		// respond with the persisted per-user preference (current_user.todo_sort).
		sort: 'created_desc',
		// whether user explicitly changed sort this session (to decide if we send ?sort=)
		sortExplicit: false,
		viewStage: 'all',
		q: '',
		category: '',
		items: []
	};

	// Todo category hints & widget helpers
	let todoCategoryHints = [];
	async function loadTodoCategoryHints() {
		try {
			if (document.getElementById('todoCategoriesGlobal')?.dataset.loaded === '1') return;
			const data = await App.utils.fetchJSONUnified('/api/todo-categories', { dedupe: true });
			todoCategoryHints = (data.items || []).map(c => c.name).filter(Boolean).slice(0, 200);
			const dl = document.getElementById('todoCategoriesGlobal');
			if (dl) {
				dl.innerHTML = todoCategoryHints.map(n => `<option value="${n}"></option>`).join('');
				dl.dataset.loaded = '1';
			}
		} catch (_) {}
	}

	function renderCategoryChips(container, items) {
		container.innerHTML = '';
		for (const it of items) {
			const wrapper = document.createElement('span');
			wrapper.className = 'badge me-1 mb-1 d-inline-flex align-items-center py-1 px-2 tag-badge';
			try { window.BlogHelpers && window.BlogHelpers.applyCategoryBadge(wrapper, it); } catch (_) {}
			wrapper.style['font-size'] = '0.9em';
			const text = document.createElement('span');
			text.textContent = it;
			text.style['white-space'] = 'nowrap';
			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'btn chip-close btn-sm ms-2';
			btn.setAttribute('aria-label', 'Remove');
			btn.style['margin-left'] = '0.4rem';
			btn.innerHTML = "<i class='fa-solid fa-xmark' aria-hidden='true'></i>";
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				const idx = items.indexOf(it);
				if (idx !== -1) {
					items.splice(idx, 1);
					renderCategoryChips(container, items);
				}
			});
			wrapper.appendChild(text);
			wrapper.appendChild(btn);
			container.appendChild(wrapper);
		}
	}

	function setupCategoryWidget(rootEl, opts) {
		const chipsWrap = rootEl.querySelector(opts.chipsSelector);
		const inputEl = rootEl.querySelector(opts.inputSelector);
		const jsonInput = rootEl.querySelector(opts.jsonInputSelector);
		const list = opts.initial && Array.isArray(opts.initial) ? [...opts.initial] : [];
		function sync() {
			renderCategoryChips(chipsWrap, list);
			if (jsonInput) jsonInput.value = JSON.stringify(list);
		}
		function addFromInput() {
			const val = (inputEl.value || '').trim();
			if (!val) return;
			const parts = val.split(',').map(s => s.trim()).filter(Boolean);
			for (const p of parts) if (!list.includes(p)) list.push(p);
			inputEl.value = '';
			sync();
		}
		// support explicit add button
		const addBtn = rootEl.querySelector(opts.addBtnSelector || '[data-todo-create-add-btn]') || rootEl.querySelector('[data-todo-detail-add-btn]');
		if (addBtn) {
			addBtn.addEventListener('click', (e) => {
				e.preventDefault();
				addFromInput();
			});
		}
		inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addFromInput(); }
		});
		inputEl.addEventListener('blur', () => { if ((inputEl.value||'').trim()) addFromInput(); });
		inputEl.addEventListener('focus', () => loadTodoCategoryHints());
		sync();
		return { getList: () => list };
	}

// Intentionally call shared helper directly where needed (will throw if BlogHelpers missing).

// Use the global RichText implementation only (no fallbacks). Let it fail loudly if missing.
const RichText = window.RichText;
// --- Edit-state caching + navigation warnings (for inline detail edit) ---
const todoEditStateCache = {};
let hasUnsavedChanges = false;

function saveEditStateToCache(todoId, root) {
	const editForm = root.querySelector('[data-todo-detail-edit-form]');
	if (!editForm) return;
	const isEditing = !editForm.classList.contains('d-none');
	const title = editForm.querySelector('[data-todo-detail-edit-title]').value;
	let category = '';
	const jsonInp = editForm.querySelector('[data-todo-detail-categories-json]');
	if (jsonInp && jsonInp.value) {
		try {
			const arr = JSON.parse(jsonInp.value || '[]');
			if (Array.isArray(arr) && arr.length) category = arr.join(', ');
		} catch (_) { category = ''; }
	} else {
		category = '';
	}
	const stage = editForm.querySelector('[data-todo-detail-edit-stage]')?.value || '';
	const due = editForm.querySelector('[data-todo-detail-edit-due]').value;
	const description = editForm.querySelector('[data-todo-detail-edit-description]').value;
	const originalItem = state.items.find(item => item._id === todoId);
	const hasChanges = !originalItem || title !== (originalItem.title || '') || category !== (originalItem.category || '') || stage !== (originalItem.stage || '') || due !== (originalItem.due_date ? (originalItem.due_date.slice ? originalItem.due_date.slice(0,10) : originalItem.due_date) : '') || description !== (originalItem.description || '');
	if (hasChanges || isEditing) {
		todoEditStateCache[todoId] = { isEditing, title, category, stage, due, description, hasChanges };
		if (typeof TODO_DEBUG !== 'undefined' && TODO_DEBUG) console.debug('todo: saveEditStateToCache', todoId, todoEditStateCache[todoId]);
	} else {
		delete todoEditStateCache[todoId];
		if (typeof TODO_DEBUG !== 'undefined' && TODO_DEBUG) console.debug('todo: cleared cache for', todoId);
	}
	updateUnsavedChangesFlag();
}

function clearEditStateFromCache(todoId) {
	delete todoEditStateCache[todoId];
	if (typeof TODO_DEBUG !== 'undefined' && TODO_DEBUG) console.debug('todo: clearEditStateFromCache', todoId);
	updateUnsavedChangesFlag();
}

function updateUnsavedChangesFlag() {
	hasUnsavedChanges = Object.values(todoEditStateCache).some(s => !!s.hasChanges);
	const originalTitle = document.title.replace(/^◌\s*/, '');
	document.title = hasUnsavedChanges ? `◌ ${originalTitle}` : originalTitle;
}

function hasAnyUnsavedChanges() {
	return hasUnsavedChanges;
}
	async function apiList(forceFresh = false) {
		// Add lightweight cache-buster when we know data changed (stage update/delete)
		let url = `/api/todo?per_page=100` + (forceFresh ? `&__ts=${Date.now()}` : '');
		// Only include sort if user has explicitly picked one this session; otherwise
		// let backend supply stored preference.
		if (state.sortExplicit && state.sort) url += `&sort=${encodeURIComponent(state.sort)}`;
		if (state.viewStage !== 'all') url += `&stage=${encodeURIComponent(state.viewStage)}`;
		if (state.q) url += `&q=${encodeURIComponent(state.q)}`;
		if (state.category) url += `&category=${encodeURIComponent(state.category)}`;
		let data;
		try {
			// Intentionally omit dedupe so we always get fresh data after mutations.
			data = await App.utils.fetchJSONUnified(url);
		} catch (e) {
			console.warn('Todo list fetch failed', e);
			return;
		}
		// Apply server-provided sort (persisted user preference) if we have not explicitly overridden it.
		if (data.sort) {
			if (!state.sortExplicit || data.sort !== state.sort) {
				state.sort = data.sort;
				updateSortLabel();
				updateSortMenuActive();
			}
		}
		state.items = data.items || [];
		renderList();
	}

	function renderList() {
		listEl.innerHTML = '';
		let items = [...state.items];
		if (!items.length) {
			listEl.innerHTML = '<div class="text-muted small fst-italic">No items.</div>';
			updateActiveFilterChips();
			updateFilterBtnActive();
			return;
		}
		for (const it of items) {
			const node = tmpl.content.firstElementChild.cloneNode(true);
			hydrate(node, it);
			listEl.appendChild(node);
		}
		updateActiveFilterChips();
		updateFilterBtnActive();
	}

	function truncateDesc(txt) {
		if (!txt) return '';
		if (txt.length > 400) return txt.slice(0, 400) + '…';
		return txt;
	}

	function hydrate(node, it) {
		node.dataset.id = it._id;
		if (!node.classList.contains('todo-item')) node.classList.add('todo-item');
		node.classList.add(it.stage);
		if (it.stage === 'done') node.classList.add('done');
		node.querySelector('.todo-title').textContent = it.title;
		const cat = node.querySelector('.todo-category');
		if (it.category) {
			cat.textContent = it.category;
				cat.classList.remove('d-none');
				try { window.BlogHelpers && window.BlogHelpers.applyCategoryBadge(cat, it.category); } catch (_) {}
		}
		const due = node.querySelector('.todo-due');
		if (it.due_date) {
			const dStr = date10(it.due_date);
			if (dStr) {
				due.textContent = dStr;
					due.classList.remove('d-none');
			}
		}
		const desc = node.querySelector('.todo-desc');
		if (desc) desc.textContent = truncateDesc(it.description || '');
		// Stage badge in list
		const stageChip = node.querySelector('.todo-stage');
		if (stageChip) {
				const btn = document.querySelector(`#stageViewMenu [data-stage="${it.stage}"]`);
				stageChip.textContent = btn ? (btn.textContent || '').trim() : (String(it.stage || '').replace(/_/g, ' '));
			try { window.BlogHelpers && window.BlogHelpers.applyStageBadge(stageChip, it.stage); } catch (_) {}
			stageChip.classList.toggle('d-none', !it.stage);
		}
		const sel = node.querySelector('.todo-stage-select-inline');
		if (sel) {
			sel.value = it.stage;
			sel.addEventListener('change', () => quickStage(it._id, sel.value, node));
		}
		
		bindItemHandlers(node, it);
	}

	async function quickStage(id, newStage, node) {
		if (!stages.includes(newStage)) return;
		node.classList.add('opacity-50');
		try {
			await App.utils.fetchJSONUnified(`/api/todo/${id}/stage`, {
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					stage: newStage
				})
			});
			await apiList(true);
		} catch (e) {
			console.warn('Stage update failed', e);
		} finally {
			node.classList.remove('opacity-50');
		}
	}



	function updateActiveFilterChips() {
		const chips = []; // stage & sort omitted
		if (state.category) chips.push(`<span class="badge text-bg-info text-dark">Cat: ${state.category}</span>`);
		if (state.q) chips.push(`<span class="badge text-bg-dark">Q: ${state.q}</span>`);
		activeFiltersBar.innerHTML = chips.join(' ');
		activeFiltersBar.style.display = chips.length ? 'flex' : 'none';
	}

	function updateSortLabel() {
		if (!currentSortLabel) return;
		const map = {
			created_desc: 'Newest',
			created_asc: 'Oldest',
			updated_desc: 'Recently Updated',
			updated_asc: 'Least Updated',
			due_date: 'Due Date'
		};
		currentSortLabel.textContent = map[state.sort] || 'Sort';
	}

	function updateSortMenuActive() {
		if (!sortMenuEl) return;
		const opts = sortMenuEl.querySelectorAll('[data-sort]');
		opts.forEach(btn => {
			const s = btn.getAttribute('data-sort');
			btn.classList.toggle('active', s === state.sort);
		});
	}
	const filterBtn = document.getElementById('btnTodoFilterToggle');

	function updateFilterBtnActive() {
		const active = !!(state.q || state.category || state.viewStage !== 'all');
		if (filterBtn) {
			filterBtn.classList.toggle('btn-primary', active);
			filterBtn.classList.toggle('btn-outline-secondary', !active);
		}
	}

	function normalizePatchClears(obj) {
		['description', 'category', 'due_date'].forEach(f => {
			if (f in obj && obj[f] === '') obj[f] = null;
		});
	}
	async function persistTodo(fd) {
		const id = idInput.value.trim();
		const payload = Object.fromEntries(fd.entries());
			// convert categories JSON to category string
			if (payload.categories) {
				try {
					const arr = JSON.parse(payload.categories || '[]');
					if (Array.isArray(arr) && arr.length) payload.category = arr.join(', ');
				} catch (_) {}
				delete payload.categories;
			}
		if (!payload.title) return;
		const url = id ? `/api/todo/${id}` : '/api/todo';
		const method = id ? 'PATCH' : 'POST';
		if (id) {
			normalizePatchClears(payload);
		}
		try {
			await App.utils.fetchJSONUnified(url, {
				method,
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(payload)
			});
			window.flash && window.flash('To-Do saved', 'success');
		} catch (e) {
			console.error('Save failed', e);
			if (!e || !e.status) window.flash && window.flash('Failed to save to-do', 'danger');
			return;
		}
		await apiList();
	}
	async function updateTodo(id, patch) {
		try {
			await App.utils.fetchJSONUnified(`/api/todo/${id}`, {
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(patch)
			});
		} catch (e) {
			console.warn('Update failed', e);
		}
	}
	async function deleteTodo(id) {
		if (!confirm('Delete this item?')) return;
		try {
			await App.utils.fetchJSONUnified(`/api/todo/${id}`, {
				method: 'DELETE'
			});
			window.flash && window.flash('Deleted', 'info');
			apiList(true);
		} catch (e) {
			console.warn('Delete failed', e);
			window.flash && window.flash('Failed to delete item', 'danger');
		}
	}

	function bindItemHandlers(node, data) {
		const wf = (el, fn) => (window.App && App.utils && App.utils.withSingleFlight) ? App.utils.withSingleFlight(el, fn) : fn();
		const delBtn = node.querySelector('.btn-delete');
		if (delBtn) delBtn.addEventListener('click', () => wf(node, () => deleteTodo(data._id)));
		node.addEventListener('click', (e) => {
			if (e.target.closest('.btn-delete') || e.target.closest('select')) return;
			openDetailModal(data._id);
		});
	}

	function openCreateModal() {
		form.reset();
		idInput.value = '';
		titleEl.textContent = 'Add To-Do';
		submitBtn.textContent = 'Save';
		metaEl.textContent = '';
		if (bsModal) bsModal.show();
		else modalEl.style.display = 'block';
		setTimeout(() => {
			try {
				form.querySelector('[name="title"]').focus();
			} catch (_) {}
		}, 30);
		detailModal?.hide();

    // setup create modal category widget
    try {
      setupCategoryWidget(form, {
        chipsSelector: '[data-todo-create-categories]',
        inputSelector: '[data-todo-create-category-input]',
        jsonInputSelector: '[data-todo-create-categories-json]',
        initial: []
      });
      loadTodoCategoryHints();
    } catch (_) {}
	}
	async function populateCategoryHints() {
		try {
			const dl = document.getElementById('todoCategoriesGlobal');
			if (!dl) return;
			if (dl.dataset.loaded === '1') return; // load once
			const data = await App.utils.fetchJSONUnified('/api/todo-categories', {
				dedupe: true
			});
			const items = (data.items || []).map(c => c.name).filter(Boolean).slice(0, 200);
			dl.innerHTML = items.map(n => `<option value="${n}"></option>`).join('');
			dl.dataset.loaded = '1';
		} catch (_) {}
	}

	btnNews.forEach(btn => btn.addEventListener('click', populateCategoryHints, {
		once: true
	}));

	// Detail modal logic
	const detailModalEl = document.getElementById('todoDetailModal');
	// Ensure modals are direct children of body for consistent Bootstrap stacking (fix backdrop/z-index issues)
	[modalEl, detailModalEl].forEach(m => {
		if (m && m.parentElement !== document.body) {
			document.body.appendChild(m);
		}
	});
	let detailModal = detailModalEl && window.bootstrap ? bootstrap.Modal.getOrCreateInstance(detailModalEl) : null;
	// Use the site-wide SiteDate utilities (fail loudly if missing)
	function extractDateVal(obj) {
		if (!window.SiteDate) throw new Error('SiteDate is required');
		return window.SiteDate.parse(obj);
	}

	function fmtDate(v) {
		if (!window.SiteDate) throw new Error('SiteDate is required');
		return window.SiteDate.toDateString(v);
	}

	function fmtDateTime(v) {
		if (!window.SiteDate) throw new Error('SiteDate is required');
		return window.SiteDate.toDateTimeString(v);
	}

	function date10(v) {
		if (!window.SiteDate) throw new Error('SiteDate is required');
		return window.SiteDate.toDateString(v);
	} // keep legacy use
	function date16(v) {
		if (!window.SiteDate) throw new Error('SiteDate is required');
		return window.SiteDate.toDateTimeString(v);
	}
	async function openDetailModal(id) {
		try {
			const data = await App.utils.fetchJSONUnified(`/api/todo/${id}/detail`, {
				dedupe: true
			});
			try {
				renderDetail(data);
				detailModal && detailModal.show();
			} catch (inner) {
				console.error('Render detail failed', inner, data);
				window.flash && window.flash('Detail render error', 'danger');
			}
		} catch (e) {
			console.error('Detail fetch failed', e);
			window.flash && window.flash('Failed to load detail', 'danger');
		}
	}

	function renderDetail(data) {
		if (!detailModalEl) return;
		const item = data.item || {};
		const safeSetText = (sel, val, fallback) => {
			const el = detailModalEl.querySelector(sel);
			if (el) el.textContent = (val != null && val !== '' ? val : (fallback || ''));
			return el;
		};
		// Keep header title generic, set full title inside modal body card
		safeSetText('[data-todo-detail-title-body]', item.title || 'To-Do');
		const catEl = detailModalEl.querySelector('[data-todo-detail-category]');
		if (catEl) {
			if (item.category) {
				catEl.textContent = item.category;
					catEl.classList.remove('d-none');
					try { window.BlogHelpers && window.BlogHelpers.applyCategoryBadge(catEl, item.category); } catch (_) {}
			} else {
				catEl.classList.add('d-none');
			}
		}
					const stageEl = detailModalEl.querySelector('[data-todo-detail-stage]');
					if (stageEl) {
						const btn = document.querySelector(`#stageViewMenu [data-stage="${item.stage}"]`);
						stageEl.textContent = btn ? (btn.textContent || '').trim() : (String(item.stage || '').replace(/_/g, ' '));
						try { window.BlogHelpers && window.BlogHelpers.applyStageBadge(stageEl, item.stage); } catch (_) {}
					}
		const dueEl = detailModalEl.querySelector('[data-todo-detail-due]');
		if (dueEl) {
			const dStr = date10(item.due_date);
			if (dStr) {
				dueEl.textContent = dStr;
				dueEl.classList.remove('d-none');
			} else dueEl.classList.add('d-none');
		}
		const descEl = detailModalEl.querySelector('[data-todo-detail-description]');
		if (descEl) {
			// Markdown toggle and rendering (graceful if toggle not present)
			const markdownToggle = detailModalEl.querySelector('[data-todo-markdown-toggle]');

			function isMarkdownEnabled() {
				// If the toggle exists, use its current checked state. Only fall back to
				// stored preference when the toggle is not present in the DOM.
				if (markdownToggle) return !!markdownToggle.checked;
				return (localStorage.getItem('todo-markdown-enabled') === 'true');
			}

			function updateDescContent() {
				const markdownEnabled = isMarkdownEnabled();
				descEl.classList.toggle('markdown-content', markdownEnabled);
				descEl.innerHTML = RichText.renderInlineContent(item.description || '', item._id, !!markdownEnabled);
				// Persist preference
				localStorage.setItem('todo-markdown-enabled', markdownEnabled ? 'true' : 'false');
			}

			if (markdownToggle) {
				markdownToggle.checked = (localStorage.getItem('todo-markdown-enabled') === 'true');
				markdownToggle.addEventListener('change', () => {
					updateDescContent();
					// Also re-render comments to respect markdown toggle
					const commentsWrapInner = detailModalEl.querySelector('[data-todo-comments]');
					if (commentsWrapInner && commentsWrapInner._lastCommentsData) {
						// reuse last fetched comments to re-render with new markdown setting
						renderComments(item, commentsWrapInner._lastCommentsData);
					}
				});
			}
			updateDescContent();
		}
		const metaEl = detailModalEl.querySelector('[data-todo-detail-meta]');
		if (metaEl) {
			metaEl.textContent = '';
			metaEl.classList.add('d-none');
		}
		const histUl = detailModalEl.querySelector('[data-todo-stage-history]');
		if (histUl) histUl.innerHTML = (item.stage_events || []).map(ev => `<li>${ev.from || '—'} → ${ev.to} <span class='text-muted'>${fmtDateTime(ev.at)}</span></li>`).join('') || '<li class="text-muted">No history</li>';
		const commentsWrap = detailModalEl.querySelector('[data-todo-comments]');
		if (commentsWrap) {
			const comments = data.comments || [];
			// Store last comments data on wrapper for re-render when markdown toggle changes
			commentsWrap._lastCommentsData = comments;
			function renderComments(itemLocal, commentsList) {
				if (!commentsList || !commentsList.length) {
					commentsWrap.innerHTML = '<div class="text-muted">No comments</div>';
					return;
				}
				const ikThumb = (url) => (window.ImageUploader && ImageUploader.thumbTransform)
				? ImageUploader.thumbTransform(url, 280, 280, false)
				: url;
				const mt = detailModalEl.querySelector('[data-todo-markdown-toggle]');
				const markdownEnabled = mt ? !!mt.checked : (localStorage.getItem('todo-markdown-enabled') === 'true');
				commentsWrap.innerHTML = commentsList.map(c => {
					const images = (c.images || []).map((u,i) => { const t = ikThumb(u); return `<div class='mt-2'><img src='${t}' data-viewer-thumb data-viewer-group='todo-comment-${itemLocal._id}' data-viewer-src='${u}' alt='comment image ${i+1}' style='max-width:140px;max-height:140px;height:auto;border:1px solid var(--border-color);border-radius:4px;cursor:pointer;object-fit:cover;'/></div>`}).join('');
					const formattedText = RichText.renderInlineContent(c.body || '', `todo-comment-${itemLocal._id}`, !!markdownEnabled);
					return `
				    <div class='todo-comment'>
				      <div class='body'>
				        <div class='content' data-markdown-container>${formattedText}</div>
				        ${images}
										    <div class='meta d-flex align-items-center'>
										      <div class='datetime text-muted'>${fmtDateTime(c.created_at)}</div>
										      <div class='ms-auto'>
										        <button class='btn btn-sm btn-outline-danger action-btn' data-comment-del='${c._id}' title='Delete'><i class='fa-solid fa-trash' aria-hidden='true'></i><span class='d-none d-sm-inline ms-1'>Delete</span></button>
										      </div>
										    </div>
				      </div>
				    </div>
				  `;
				}).join('');
				// delegate delete clicks
				commentsWrap.querySelectorAll('[data-comment-del]').forEach(btn => btn.addEventListener('click', async (e) => {
					e.preventDefault();
					const cid = btn.getAttribute('data-comment-del');
					try {
						await App.utils.fetchJSONUnified(`/api/todo-comments/${cid}`, {
							method: 'DELETE'
						});
						openDetailModal(itemLocal._id);
					} catch (_) {
						window.flash && window.flash('Delete failed', 'danger');
					}
				}));
			}
			// Initial render
			renderComments(item, comments);
		}
		const limitEl = detailModalEl.querySelector('[data-todo-comment-limit]');
		if (limitEl) limitEl.textContent = `${(data.comment_max || 2000)} chars max`;
		const formC = detailModalEl.querySelector('[data-todo-comment-form]');
		if (formC) formC.dataset.todoId = item._id;
		// Populate edit form (kept hidden until user clicks Edit)
		const editForm = detailModalEl.querySelector('[data-todo-detail-edit-form]');
		if (editForm) {
			// If we have a cached unsaved edit state for this item, restore it.
			const cached = item._id && todoEditStateCache[item._id] ? todoEditStateCache[item._id] : null;
			if (cached) {
				if (typeof TODO_DEBUG !== 'undefined' && TODO_DEBUG) console.debug('todo: restoring cache for', item._id, cached);
				// Title
				editForm.querySelector('[data-todo-detail-edit-title]').value = cached.title || '';
				// Categories (cached may be comma-separated string)
				const cachedCats = (cached.category && typeof cached.category === 'string') ? cached.category.split(',').map(s => s.trim()).filter(Boolean) : [];
				try {
					setupCategoryWidget(editForm, {
						chipsSelector: '[data-todo-detail-categories]',
						inputSelector: '[data-todo-detail-category-input]',
						jsonInputSelector: '[data-todo-detail-categories-json]',
						initial: cachedCats
					});
					loadTodoCategoryHints();
				} catch (_) {}
				// Stage, due, description
				const stSel = editForm.querySelector('[data-todo-detail-edit-stage]');
				if (stSel) stSel.value = cached.stage || 'wondering';
				editForm.querySelector('[data-todo-detail-edit-due]').value = cached.due || '';
				editForm.querySelector('[data-todo-detail-edit-description]').value = cached.description || '';

				// If the cached state indicates the user was editing when the modal closed,
				// restore the UI to edit mode immediately so they can continue.
				if (cached.isEditing) {
					editForm.classList.remove('d-none');
					const descView = detailModalEl.querySelector('[data-todo-detail-description]');
					descView && descView.classList.add('d-none');
					const btnEdit = detailModalEl.querySelector('[data-todo-detail-edit-btn]');
					const btnSave = detailModalEl.querySelector('[data-todo-detail-save-btn]');
					const btnCancel = detailModalEl.querySelector('[data-todo-detail-cancel-btn]');
					btnEdit && btnEdit.classList.add('d-none');
					btnSave && btnSave.classList.remove('d-none');
					btnCancel && btnCancel.classList.remove('d-none');
				}
			} else {
				if (typeof TODO_DEBUG !== 'undefined' && TODO_DEBUG) console.debug('todo: no cache for', item._id, '— populating from server');
				// No cached state — populate from server-provided item
				editForm.querySelector('[data-todo-detail-edit-title]').value = item.title || '';
				const initialCats = [];
				if (Array.isArray(item.category)) initialCats.push(...item.category);
				else if (item.category) initialCats.push(item.category);
				try {
					setupCategoryWidget(editForm, {
						chipsSelector: '[data-todo-detail-categories]',
						inputSelector: '[data-todo-detail-category-input]',
						jsonInputSelector: '[data-todo-detail-categories-json]',
						initial: initialCats
					});
					loadTodoCategoryHints();
				} catch (_) {}
				const stSel = editForm.querySelector('[data-todo-detail-edit-stage]');
				if (stSel) stSel.value = item.stage || 'wondering';
				editForm.querySelector('[data-todo-detail-edit-due]').value = item.due_date ? date10(item.due_date) : '';
				editForm.querySelector('[data-todo-detail-edit-description]').value = item.description || '';
			}
			editForm.dataset.todoId = item._id || '';
		}

		// Bind inline image upload for detail edit form (insert placeholders and upload)
		if (editForm && !editForm._inlineImgBound) {
			editForm._inlineImgBound = true;
			const editContent = editForm.querySelector('[data-todo-detail-edit-description]') || editForm.querySelector('[data-todo-detail-edit-description]');
			const editFileInput = editForm.querySelector('[data-todo-edit-description-image]');
			const editTrigger = editForm.querySelector('[data-todo-edit-description-image-trigger]');
			// Use BlogHelpers for inline image uploads (fail loudly if missing)
			window.BlogHelpers.attachInlineImageUploader({ contentEl: editContent, fileInput: editFileInput, trigger: editTrigger, uploadEndpoint: '/api/todo-images' });
		}
		// Toggle buttons state back to view mode on re-render
		const btnEdit = detailModalEl.querySelector('[data-todo-detail-edit-btn]');
		const btnSave = detailModalEl.querySelector('[data-todo-detail-save-btn]');
		const btnCancel = detailModalEl.querySelector('[data-todo-detail-cancel-btn]');
		if (btnEdit && btnSave && btnCancel && editForm) {
			if (editForm.classList.contains('d-none')) {
				btnEdit.classList.remove('d-none');
				btnSave.classList.add('d-none');
				btnCancel.classList.add('d-none');
			}
		}

		// Delegate header clicks to avoid double-invocation and ensure controls work after re-render
		if (!detailModalEl._headerClickBound) {
			detailModalEl._headerClickBound = true;
			detailModalEl.addEventListener('click', async (e) => {
				if (e.target.closest('[data-todo-detail-edit-btn]')) {
					try { switchToEdit(); } catch (_) {}
				}
				if (e.target.closest('[data-todo-detail-cancel-btn]')) {
					const tid = detailModalEl.querySelector('[data-todo-detail-edit-form]')?.dataset.todoId;
					if (tid) clearEditStateFromCache(tid);
					try { switchToView(); } catch (_) {}
					if (tid) openDetailModal(tid);
				}
				if (e.target.closest('[data-todo-detail-save-btn]')) {
					const matched = e.target.closest('[data-todo-detail-save-btn]');
					const canonical = detailModalEl.querySelector('[data-todo-detail-save-btn]');
					if (matched && matched === canonical) return; // let canonical handler run
					try {
						const editFormInner = detailModalEl.querySelector('[data-todo-detail-edit-form]');
						if (editFormInner) {
							// perform save (reuse existing code path)
							const todoId = editFormInner.dataset.todoId;
							if (todoId) {
								const fd = new FormData(editFormInner);
								const patch = {};
								fd.forEach((v,k)=>{ patch[k]=v.toString(); });
								// convert categories JSON to category string if present
								if (patch.categories) {
									try {
										const arr = JSON.parse(patch.categories || '[]');
										if (Array.isArray(arr) && arr.length) patch.category = arr.join(', ');
									} catch (_) {}
									delete patch.categories;
								}
								if (patch.due_date === '') patch.due_date = null;
								if (patch.category === '') patch.category = null;
								await App.utils.fetchJSONUnified(`/api/todo/${todoId}`, {
									method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(patch)
								});
								window.flash && window.flash('Updated', 'success');
								// Clear any cached edit state now that the item is saved
								clearEditStateFromCache(todoId);
								switchToView();
								openDetailModal(todoId);
								apiList();
							}
						}
					} catch (_) { window.flash && window.flash('Update failed', 'danger'); }
				}
			});
		}

		// Save edit state when modal hides — bind once and locate the edit form robustly
		if (detailModalEl && !detailModalEl._hideBound) {
			detailModalEl._hideBound = true;
			detailModalEl.addEventListener('hide.bs.modal', () => {
				// Prefer a dedicated root if present, otherwise use the modal element
				const rootHide = detailModalEl.querySelector('[data-todo-detail-root]') || detailModalEl;
				const editFormEl = rootHide.querySelector('[data-todo-detail-edit-form]');
				const tid = editFormEl?.dataset.todoId;
				if (tid) saveEditStateToCache(tid, rootHide);
			});
		}

		// Auto-save edit state while editing (debounced). Bind once per form instance.
		if (editForm && !editForm._autoSaveBound) {
			editForm._autoSaveBound = true;
			const debouncedSaveState = window.BlogHelpers.debounce(() => {
				const rootAuto = detailModalEl.querySelector('[data-todo-detail-root]');
				const tid = rootAuto?.querySelector('[data-todo-detail-edit-form]')?.dataset.todoId;
				if (tid && !editForm.classList.contains('d-none')) saveEditStateToCache(tid, rootAuto);
			}, 500);
			editForm.addEventListener('input', debouncedSaveState);
		}
	}


	if (detailModalEl) {
		const formC = detailModalEl.querySelector('[data-todo-comment-form]');
		// Maintain per-item unsent draft so switching items doesn't leak comment text/images
		const todoDrafts = {};
		if (formC && window.ImageUploader) {
			ImageUploader.attachCommentUploader({
				formEl: formC,
				uploadEndpoint: '/api/todo-images',
				selectors: {
					fileInput: '[data-todo-comment-image]',
					triggerBtn: '[data-todo-comment-image-trigger]',
					clearBtn: '[data-todo-comment-images-clear]',
					previewWrap: '[data-todo-comment-images-preview]'
				},
				pasteScopeEl: detailModalEl
			});
			// Restore draft (if any) when modal opened for item
			detailModalEl.addEventListener('show.bs.modal', () => {
				const tid = formC.dataset.todoId;
				if (!tid) return;
				const d = todoDrafts[tid];
				if (d) {
					formC.querySelector('[name="body"]').value = d.body || '';
					if (d.images && formC._imageUploader && formC._imageUploader.setImages) {
						formC._imageUploader.setImages(d.images);
					}
				}
			});
			// Persist draft on input changes
			formC.addEventListener('input', () => {
				const tid = formC.dataset.todoId; if (!tid) return;
				todoDrafts[tid] = todoDrafts[tid] || {};
				todoDrafts[tid].body = formC.querySelector('[name="body"]').value;
				todoDrafts[tid].images = formC._imageUploader ? formC._imageUploader.getImages() : [];
			});
			// When switching items (dataset.todoId changes) save old draft first via MutationObserver
			const obs = new MutationObserver(() => {
				// dataset change triggers observer; ensure new draft loaded
				const tid = formC.dataset.todoId;
				if (!tid) return;
				const d = todoDrafts[tid];
				formC.querySelector('[name="body"]').value = d?.body || '';
				if (formC._imageUploader && formC._imageUploader.setImages) {
					formC._imageUploader.setImages(d?.images || []);
				}
			});
			obs.observe(formC, { attributes: true, attributeFilter: ['data-todo-id'], subtree: false });
			formC.addEventListener('submit', async e => {
				e.preventDefault();
				const todoId = formC.dataset.todoId;
				if (!todoId) return;
				const fd = new FormData(formC);
				const body = fd.get('body')?.toString().trim();
				const imgs = formC._imageUploader ? formC._imageUploader.getImages() : [];
				if (!body && !imgs.length) return;
				try {
					await App.utils.fetchJSONUnified(`/api/todo/${todoId}/comments`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ body, images: imgs })
					});
					formC.reset();
					formC._imageUploader && formC._imageUploader.reset();
					delete todoDrafts[todoId]; // clear draft on successful post
					openDetailModal(todoId);
				} catch (_) {}
			});
		}
		// Inline edit handlers
		const editBtn = detailModalEl.querySelector('[data-todo-detail-edit-btn]');
		const saveBtn = detailModalEl.querySelector('[data-todo-detail-save-btn]');
		const cancelBtn = detailModalEl.querySelector('[data-todo-detail-cancel-btn]');
		const editForm = detailModalEl.querySelector('[data-todo-detail-edit-form]');

		function switchToEdit() {
			if (!editForm) return;
			editForm.classList.remove('d-none');
			detailModalEl.querySelector('[data-todo-detail-description]')?.classList.add('d-none');
			editBtn.classList.add('d-none');
			saveBtn.classList.remove('d-none');
			cancelBtn.classList.remove('d-none');
			populateCategoryHints();
		}

		function switchToView() {
			if (!editForm) return;
			editForm.classList.add('d-none');
			detailModalEl.querySelector('[data-todo-detail-description]')?.classList.remove('d-none');
			editBtn.classList.remove('d-none');
			saveBtn.classList.add('d-none');
			cancelBtn.classList.add('d-none');
		}
		editBtn && editBtn.addEventListener('click', e => {
			e.preventDefault();
			switchToEdit();
		});
		cancelBtn && cancelBtn.addEventListener('click', e => {
			e.preventDefault();
			switchToView();
		});
		saveBtn && saveBtn.addEventListener('click', async e => {
			e.preventDefault();
			if (!editForm) return;
			const todoId = editForm.dataset.todoId;
			if (!todoId) return;
			const fd = new FormData(editForm);
			const patch = {};
			fd.forEach((v, k) => {
				patch[k] = v.toString();
			});
			if (patch.categories) {
				try {
					const arr = JSON.parse(patch.categories || '[]');
					if (Array.isArray(arr) && arr.length) patch.category = arr.join(', ');
				} catch (_) {}
				delete patch.categories;
			}
			if (patch.due_date === '') patch.due_date = null;
			if (patch.category === '') patch.category = null;
			try {
				await App.utils.fetchJSONUnified(`/api/todo/${todoId}`, {
					method: 'PATCH',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(patch)
				});
				window.flash && window.flash('Updated', 'success');
				// Clear any cached edit state now that the item is saved
				clearEditStateFromCache(todoId);
				switchToView();
				openDetailModal(todoId);
				apiList();
			} catch (_) {
				window.flash && window.flash('Update failed', 'danger');
			}
		});
	}

// Inline image paste/drag/file upload for create modal (form.description)
// Use BlogHelpers.attachInlineImageUploader exclusively. If BlogHelpers is missing,
// allow the error to surface so the missing abstraction is fixed at source.
if (form && form.description) {
	const descInput = form.description;
	const fileInput = modalEl.querySelector('[data-todo-description-image]');
	const trigger = modalEl.querySelector('[data-todo-description-image-trigger]');
	window.BlogHelpers.attachInlineImageUploader({ contentEl: descInput, fileInput, trigger, uploadEndpoint: '/api/todo-images' });
}

// Install navigation warnings while there are unsaved inline edits
if (window.BlogHelpers && window.BlogHelpers.setupNavigationWarnings) {
	window.BlogHelpers.setupNavigationWarnings(() => hasAnyUnsavedChanges());
}

	form.addEventListener('submit', e => {
		e.preventDefault();
		const runner = (window.App && App.utils && App.utils.withSingleFlight) ? App.utils.withSingleFlight : (_el, fn) => fn();
		runner(form, async () => {
			const fd = new FormData(form);
			await persistTodo(fd);
			if (bsModal) bsModal.hide();
		});
	});

	const safeOn = (el, ev, fn) => {
		if (el && el.addEventListener) el.addEventListener(ev, fn);
	};
	btnNews.forEach(btn => safeOn(btn, 'click', () => {
		openCreateModal();
		stageSelect.value = (state.viewStage !== 'all' ? state.viewStage : 'wondering');
	}));
	if (stageViewMenu) {
		stageViewMenu.querySelectorAll('[data-stage]').forEach(el => {
			el.addEventListener('click', () => {
				const st = el.getAttribute('data-stage');
				if (!st) return;
				state.viewStage = st;
				apiList();
				if (stageViewLabel) {
					stageViewLabel.textContent = st === 'all' ? 'All Stages' : st.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
				}
				stageViewMenu.querySelectorAll('.dropdown-item').forEach(it => it.classList.toggle('active', it === el));
			});
		});
	}
	safeOn(filterToggle, 'click', () => {
		const box = document.getElementById('todoInlineFilters');
		box.classList.toggle('d-none');
	});
	safeOn(btnToDoApplyFilters, 'click', () => {
		state.q = searchEl.value.trim();
		state.category = categorySel.value || '';
		apiList();
	});
	safeOn(btnClearFilters, 'click', () => {
		searchEl.value = '';
		categorySel.value = '';
		state.q = '';
		state.category = '';
		apiList();
	});
	async function saveSortPreference(s) {
		try {
			await App.utils.fetchJSONUnified('/api/sort-pref', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ name: 'todo', sort: s })
			});
		} catch (_) {}
	}
	if (sortMenuEl) {
		sortMenuEl.querySelectorAll('[data-sort]').forEach(el => el.addEventListener('click', () => {
			const s = el.getAttribute('data-sort');
			if (!s) return;
			state.sort = s;
			state.sortExplicit = true; // from now on we send the sort param
			updateSortLabel();
			updateSortMenuActive();
			apiList();
			saveSortPreference(s);
		}));
		// Initialize active state (may update after first apiList when preference arrives)
		updateSortMenuActive();
	}



	// Don't force label here beyond default; after first fetch user preference will set it.
	updateFilterBtnActive();
	
	// Set up modal cleanup
	window.CommentFormatter && window.CommentFormatter.setupModalCleanup(detailModalEl, ['[data-todo-comment-form]']);
	
	apiList();
})();