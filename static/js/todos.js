(() => {
	if (window.__todosModuleLoaded) return;
	window.__todosModuleLoaded = true;
	const modalEl = document.getElementById('todoModal');
	if (!modalEl) return;
	const form = modalEl.querySelector('[data-todo-form]');
	const titleEl = modalEl.querySelector('[data-todo-modal-title]');
	const idInput = form.querySelector('[data-todo-id]');
	const submitBtn = form.querySelector('[data-todo-submit-btn]');
	const stageSelect = form.querySelector('[data-todo-stage-select]');
	const metaEl = form.querySelector('[data-todo-meta]');
	let bsModal = window.bootstrap ? bootstrap.Modal.getOrCreateInstance(modalEl) : null;

	const listEl = document.getElementById('todosFlatList');
	const tmpl = document.getElementById('todoItemTemplate');
	// Support multiple "new" buttons (header + toolbar)
	const btnNews = [document.getElementById('btnNewTodoTop')].filter(Boolean);
	const stageViewMenu = document.getElementById('stageViewMenu');
	const stageViewLabel = document.getElementById('stageViewLabel');
	const filterToggle = document.getElementById('btnFilterToggle');
	const categorySel = document.getElementById('filterCategory');
	const searchEl = document.getElementById('todoSearch');
	const btnApplyFilters = document.getElementById('btnApplyFilters');
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

// Use shared RichText helpers when available (centralized renderer)
const RichText = window.RichText || {
	renderInlineContent: (raw, id, markdownEnabled) => (raw ? (window.CommentFormatter ? window.CommentFormatter.formatText(raw) : (raw || '').replace(/\n/g, '<br/>')) : ''),
	escapeHtml: (s) => (s || '').replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]))
};

// --- Edit-state caching + navigation warnings (for inline detail edit) ---
const todoEditStateCache = {};
let hasUnsavedChanges = false;

function saveEditStateToCache(todoId, root) {
	const editForm = root.querySelector('[data-todo-detail-edit-form]');
	if (!editForm) return;
	const isEditing = !editForm.classList.contains('d-none');
	const title = editForm.querySelector('[data-todo-detail-edit-title]').value;
	const category = editForm.querySelector('[data-todo-detail-edit-category]').value;
	const stage = editForm.querySelector('[data-todo-detail-edit-stage]')?.value || '';
	const due = editForm.querySelector('[data-todo-detail-edit-due]').value;
	const description = editForm.querySelector('[data-todo-detail-edit-description]').value;
	const originalItem = state.items.find(item => item._id === todoId);
	const hasChanges = !originalItem || title !== (originalItem.title || '') || category !== (originalItem.category || '') || stage !== (originalItem.stage || '') || due !== (originalItem.due_date ? (originalItem.due_date.slice ? originalItem.due_date.slice(0,10) : originalItem.due_date) : '') || description !== (originalItem.description || '');
	if (hasChanges || isEditing) {
		todoEditStateCache[todoId] = { isEditing, title, category, stage, due, description, hasChanges };
	} else {
		delete todoEditStateCache[todoId];
	}
	updateUnsavedChangesFlag();
}

function clearEditStateFromCache(todoId) {
	delete todoEditStateCache[todoId];
	updateUnsavedChangesFlag();
}

function updateUnsavedChangesFlag() {
	hasUnsavedChanges = Object.values(todoEditStateCache).some(s => !!s.hasChanges);
	const originalTitle = document.title.replace(/^◌\s*/, '');
	document.title = hasUnsavedChanges ? `◌ ${originalTitle}` : originalTitle;
}

function hasAnyUnsavedChanges() { return hasUnsavedChanges; }

function setupNavigationWarnings() {
	window.addEventListener('beforeunload', (e) => {
		if (hasAnyUnsavedChanges()) {
			e.preventDefault();
			e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
			return e.returnValue;
		}
	});
}

setupNavigationWarnings();

	async function apiList(forceFresh = false) {
		// Add lightweight cache-buster when we know data changed (stage update/delete)
		let url = `/api/todos?per_page=100` + (forceFresh ? `&__ts=${Date.now()}` : '');
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
		}
		const due = node.querySelector('.todo-due');
		if (it.due_date) {
			const d = new Date(it.due_date);
			due.textContent = d.toISOString().slice(0, 10);
			due.classList.remove('d-none');
		}
		const desc = node.querySelector('.todo-desc');
		if (desc) desc.textContent = truncateDesc(it.description || '');
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
			await App.utils.fetchJSONUnified(`/api/todos/${id}/stage`, {
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
	const filterBtn = document.getElementById('btnFilterToggle');

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
		if (!payload.title) return;
		const url = id ? `/api/todos/${id}` : '/api/todos';
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
			await App.utils.fetchJSONUnified(`/api/todos/${id}`, {
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
			await App.utils.fetchJSONUnified(`/api/todos/${id}`, {
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

	function openEditModal(data) {
		form.reset();
		idInput.value = data._id;
		form.title.value = data.title || '';
		form.category.value = data.category || '';
		stageSelect.value = data.stage || 'wondering';
		form.due_date.value = data.due_date ? data.due_date.slice(0, 10) : '';
		form.description.value = data.description || '';
		titleEl.textContent = 'Edit To-Do';
		submitBtn.textContent = 'Update';
		metaEl.textContent = '';
		if (bsModal) bsModal.show();
		else modalEl.style.display = 'block';
		populateCategoryHints();
		detailModal?.hide();
	}
	btnNews.forEach(btn => btn.addEventListener('click', populateCategoryHints, {
		once: true
	}));

	// Detail modal logic
	const detailModalEl = document.getElementById('todoDetailModal');
	let detailModal = detailModalEl && window.bootstrap ? bootstrap.Modal.getOrCreateInstance(detailModalEl) : null;
	// Helpers for safe date formatting (handles Date, string, number)
	function extractDateVal(obj) {
		if (!obj) return null;
		if (obj instanceof Date) return obj;
		if (typeof obj === 'string') {
			const d = DateTime.parse(obj);
			return d;
		}
		if (typeof obj === 'number') {
			return new Date(obj > 1e12 ? obj : obj * 1000);
		}
		if (typeof obj === 'object') {
			const cand = obj.$date || obj.date || obj.iso || obj.datetime || obj.at || obj.value;
			if (cand) return extractDateVal(cand);
		}
		return null;
	}

	function fmtDate(v) {
		const d = extractDateVal(v);
		return d ? DateTime.formatDate(d) : '';
	}

	function fmtDateTime(v) {
		const d = extractDateVal(v);
		return d ? DateTime.formatDateTime(d) : '';
	}

	function date10(v) {
		const d = extractDateVal(v);
		if (!d) return '';
		return d.toISOString().slice(0, 10);
	} // keep legacy use
	function date16(v) {
		return fmtDateTime(v);
	}
	async function openDetailModal(id) {
		try {
			const data = await App.utils.fetchJSONUnified(`/api/todos/${id}/detail`, {
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
			} else {
				catEl.classList.add('d-none');
			}
		}
		const stageEl = detailModalEl.querySelector('[data-todo-detail-stage]');
		if (stageEl) stageEl.textContent = item.stage || '';
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
				descEl.innerHTML = (RichText && RichText.renderInlineContent)
					? RichText.renderInlineContent(item.description || '', item._id, !!markdownEnabled)
					: (window.CommentFormatter ? window.CommentFormatter.formatText(item.description || '') : (item.description || '').replace(/\n/g, '<br/>'));
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
					let formattedText;
					if (window.CommentFormatter && window.CommentFormatter.formatText) {
						formattedText = window.CommentFormatter.formatText(c.body || '');
					} else if (RichText && RichText.renderInlineContent) {
						formattedText = RichText.renderInlineContent(c.body || '', `todo-comment-${itemLocal._id}`, !!markdownEnabled);
					} else {
						formattedText = (RichText && RichText.escapeHtml) ? RichText.escapeHtml(c.body).replace(/\n/g, '<br/>') : (c.body || '').replace(/\n/g, '<br/>');
					}
					return `
				    <div class='todo-comment'>
				      <div class='body'>
				        <div class='content' data-markdown-container>${formattedText}</div>
				        ${images}
				        <div class='meta d-flex align-items-center'>
				          <div class='datetime text-muted'>${fmtDateTime(c.created_at)}</div>
				          <div class='ms-auto'>
				            <button class='btn btn-sm btn-outline-danger action-btn' data-comment-del='${c._id}' title='Delete'><i class='bi bi-trash'></i><span class='d-none d-sm-inline ms-1'>Delete</span></button>
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
			editForm.querySelector('[data-todo-detail-edit-title]').value = item.title || '';
			editForm.querySelector('[data-todo-detail-edit-category]').value = item.category || '';
			const stSel = editForm.querySelector('[data-todo-detail-edit-stage]');
			if (stSel) stSel.value = item.stage || 'wondering';
			editForm.querySelector('[data-todo-detail-edit-due]').value = item.due_date ? date10(item.due_date) : '';
			editForm.querySelector('[data-todo-detail-edit-description]').value = item.description || '';
			editForm.dataset.todoId = item._id || '';
		}

		// Bind inline image upload for detail edit form (insert placeholders and upload)
		if (editForm && !editForm._inlineImgBound) {
			editForm._inlineImgBound = true;
			const editContent = editForm.querySelector('[data-todo-detail-edit-description]') || editForm.querySelector('[data-todo-detail-edit-description]');
			const editFileInput = editForm.querySelector('[data-todo-edit-description-image]');
			const editTrigger = editForm.querySelector('[data-todo-edit-description-image-trigger]');
			editTrigger && editTrigger.addEventListener('click', () => editFileInput && editFileInput.click());

			function insertUploadingPlaceholder() {
				if (!editContent) return null;
				const id = 'up_' + Math.random().toString(36).slice(2,9);
				const placeholder = `\n![uploading-${id}]()`;
				const start = editContent.selectionStart || 0;
				const end = editContent.selectionEnd || 0;
				const orig = editContent.value;
				editContent.value = orig.slice(0, start) + placeholder + orig.slice(end);
				const cursor = start + placeholder.length;
				editContent.selectionStart = editContent.selectionEnd = cursor;
				return id;
			}

			async function uploadAndReplace(file, idTag) {
				if (!file) return;
				if (!file.type.startsWith('image/')) return;
				if (file.size > 16 * 1024 * 1024) { window.flash && window.flash('Image too large', 'warning'); return; }
				const reader = new FileReader();
				reader.onload = async () => {
					try {
						const res = await App.utils.fetchJSONUnified('/api/todo-images', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ image: reader.result })
						});
						editContent.value = editContent.value.replace(`![uploading-${idTag}]()`, `![img](${res.url})`);
					} catch (_) {
						editContent.value = editContent.value.replace(`![uploading-${idTag}]()`, '(image failed)');
					}
				};
				reader.readAsDataURL(file);
			}

			function handleFiles(files, label) {
				if (!files || !files.length) return;
				for (const f of files) {
					const id = insertUploadingPlaceholder();
					uploadAndReplace(f, id);
				}
			}

			editFileInput && editFileInput.addEventListener('change', () => { handleFiles(Array.from(editFileInput.files || []), 'selected'); editFileInput.value = ''; });

			editContent && editContent.addEventListener('paste', e => {
				const items = e.clipboardData?.items || [];
				const files = [];
				for (const it of items) {
					if (it.type?.startsWith('image/')) {
						const f = it.getAsFile(); if (f) files.push(f);
					}
				}
				if (files.length) { e.preventDefault(); handleFiles(files, 'pasted'); }
			});

			editContent && editContent.addEventListener('dragover', e => e.preventDefault());
			editContent && editContent.addEventListener('drop', e => {
				e.preventDefault();
				const files = Array.from(e.dataTransfer?.files || []);
				handleFiles(files, 'dropped');
			});
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
					await App.utils.fetchJSONUnified(`/api/todos/${todoId}/comments`, {
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
			if (patch.due_date === '') patch.due_date = null;
			if (patch.category === '') patch.category = null;
			try {
				await App.utils.fetchJSONUnified(`/api/todos/${todoId}`, {
					method: 'PATCH',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify(patch)
				});
				window.flash && window.flash('Updated', 'success');
				switchToView();
				openDetailModal(todoId);
				apiList();
			} catch (_) {
				window.flash && window.flash('Update failed', 'danger');
			}
		});
	}

// Inline image paste/drag/file upload for create modal (form.description)
if (form && form.description) {
	const descInput = form.description;
	const fileInput = modalEl.querySelector('[data-todo-description-image]');
	const trigger = modalEl.querySelector('[data-todo-description-image-trigger]');
	trigger && trigger.addEventListener('click', () => fileInput && fileInput.click());
	async function uploadDescriptionFiles(files, label) {
		for (const f of files) {
			if (!f.type.startsWith('image/')) continue;
			if (f.size > 16 * 1024 * 1024) { window.flash && window.flash('Image too large', 'warning'); continue; }
			const placeholder = '\n![uploading]()';
			const start = descInput.selectionStart, end = descInput.selectionEnd;
			const orig = descInput.value;
			descInput.value = orig.slice(0, start) + placeholder + orig.slice(end);
			descInput.selectionStart = descInput.selectionEnd = start + placeholder.length;
			const r = new FileReader();
			r.onload = async () => {
				try {
					const res = await App.utils.fetchJSONUnified('/api/todo-images', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ image: r.result })
					});
					descInput.value = descInput.value.replace('![uploading]()', `![img](${res.url})`);
				} catch (_) {
					descInput.value = descInput.value.replace('![uploading]()', '(image failed)');
				}
			};
			r.readAsDataURL(f);
		}
	}
	fileInput && fileInput.addEventListener('change', () => { uploadDescriptionFiles(Array.from(fileInput.files || []), 'Selected'); fileInput.value = ''; });
	descInput.addEventListener('paste', e => {
		const items = e.clipboardData?.items || [];
		const files = [];
		for (const it of items) {
			if (it.type?.startsWith('image/')) {
				const f = it.getAsFile(); if (f) files.push(f);
			}
		}
		if (files.length) { e.preventDefault(); uploadDescriptionFiles(files, 'Pasted'); }
	});
	descInput.addEventListener('dragover', e => e.preventDefault());
	descInput.addEventListener('drop', e => {
		e.preventDefault();
		const files = Array.from(e.dataTransfer?.files || []);
		if (files.length) uploadDescriptionFiles(files, 'Dropped');
	});
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
		const box = document.getElementById('inlineFilters');
		box.classList.toggle('d-none');
	});
	safeOn(btnApplyFilters, 'click', () => {
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