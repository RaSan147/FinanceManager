/*
 * static/js/todo.js
 *
 * To-Do UI module
 * - Responsible for listing, filtering, creating and editing to-dos via modals
 * - Uses App.utils.fetchJSONUnified for all API calls
 * - Integrates with BlogHelpers, RichText, ImageUploader when available
 *
 * Improvements in this refactor:
 * - Single global DEBUG flag for easy debug toggling
 * - JSDoc on main helpers to improve discoverability
 * - Defensive checks for optional dependencies (BlogHelpers, RichText, ImageUploader)
 *
 * Toggle debug logging by setting `window.TODO_DEBUG = true` in the console.
 */
'use strict';

// Global debug flag: set window.TODO_DEBUG = true in the console to enable verbose logs
/* eslint-disable no-unused-vars */
var TODO_DEBUG = window && window.TODO_DEBUG || false;
/* eslint-enable no-unused-vars */

(() => {
	// Ensure the module only initializes once
	if (window.__todoModuleLoaded) return;
	window.__todoModuleLoaded = true;
	try {
		/* removed noisy console.log */
	} catch (e) { console.error('todo.js: console.log failed at module load', e); throw e; }

	// Early, robust delegated click for the Filter toggle so it works even if init is delayed
	try {
		if (!document._todoFilterDelegatedEarly) {
			document.addEventListener('click', (e) => {
				const btn = e.target.closest('#btnTodoFilterToggle');
				if (btn) {
					const box = document.getElementById('todoInlineFilters');
					if (box) box.classList.toggle('d-none');
				}
			});
			document._todoFilterDelegatedEarly = true;
		}
	} catch (_) {}

	// Move the large module body into an initializer so we can defer startup
		let _initStarted = false;
		const _init = () => {
			if (_initStarted) {
			try {
					if (window && window.TODO_DEBUG) console.debug('todo.js: init already started');
			} catch (_) {}
			return;
		}
		_initStarted = true;
			try {
				if (window && window.TODO_DEBUG) { console.debug('todo.js: _init starting'); }
			} catch (e) { console.error('todo.js: debug logging failed in _init', e); throw e; }

		// Instrument event listener registration and invocation for extensive logging.
		// Apply ONLY when explicit debug flag is enabled to avoid noisy logs in normal use.
		if (window && window.TODO_DEBUG && !window.__todoListenerPatchApplied) {
			(function () {
				const ET = (typeof EventTarget !== 'undefined') ? EventTarget.prototype : null;
				if (!ET) return;
				const _add = ET.addEventListener;
				const _remove = ET.removeEventListener;
				ET.addEventListener = function (type, listener, options) {
					try { if (window && window.TODO_DEBUG) console.debug('todo.js: addEventListener called', { target: this, type, listenerName: listener && (listener.name || '<anon>') }); } catch (e) {}
					if (!listener) return _add.call(this, type, listener, options);
					// If already wrapped, reuse the wrapped function
					if (listener._todoWrapped) return _add.call(this, type, listener._todoWrapped, options);
					const orig = listener;
					const wrapped = function (...args) {
						try { if (window && window.TODO_DEBUG) console.debug('todo.js: listener invoked', { type, target: this, listenerName: orig.name || '<anon>', args }); } catch (e) {}
						try {
							return orig.apply(this, args);
						} catch (err) {
							console.error('todo.js: error in event listener', { type, listenerName: orig.name || '<anon>' }, err);
							throw err;
						}
					};
					// carry a back-reference so removeEventListener can work with the original function
					try { orig._todoWrapped = wrapped; } catch (e) {}
					return _add.call(this, type, wrapped, options);
				};

				ET.removeEventListener = function (type, listener, options) {
					const wrapped = listener && listener._todoWrapped ? listener._todoWrapped : listener;
					try { if (window && window.TODO_DEBUG) console.debug('todo.js: removeEventListener called', { target: this, type, listenerName: listener && (listener.name || '<anon>') }); } catch (e) {}
					return _remove.call(this, type, wrapped, options);
				};
			})();
			window.__todoListenerPatchApplied = true;
		}
		const modalEl = document.getElementById('todoModal');
		// The modal may be absent on some pages (list-only views). Make modal-related refs optional
		let form = null,
			titleEl = null,
			idInput = null,
			submitBtn = null,
			stageSelect = null,
			metaEl = null;
		let bsModal = null;
		if (modalEl) {
			try {
				form = modalEl.querySelector('[data-todo-form]');
				titleEl = modalEl.querySelector('[data-todo-modal-title]');
				idInput = form ? form.querySelector('[data-todo-id]') : null;
				submitBtn = form ? form.querySelector('[data-todo-submit-btn]') : null;
				// Top save button mirrors footer Save and triggers submit
				const saveTop = modalEl.querySelector('[data-todo-save-top]');
				if (saveTop && submitBtn) saveTop.addEventListener('click', () => submitBtn.click());
				stageSelect = form ? form.querySelector('[data-todo-stage-select]') : null;
				metaEl = form ? form.querySelector('[data-todo-meta]') : null;
				bsModal = window.bootstrap ? bootstrap.Modal.getOrCreateInstance(modalEl) : null;
			} catch (_) {
				// defensive: if modal DOM shape unexpected, leave modal-related refs null
			}
		}


		let listEl = document.getElementById('todoFlatList');
		let tmpl = document.getElementById('todoItemTemplate');
		// Support multiple "new" buttons (header + toolbar)
		const btnNews = [document.getElementById('btnNewTodoTop')].filter(Boolean);
		const stageViewMenu = document.getElementById('stageViewMenu');
		const stageViewLabel = document.getElementById('stageViewLabel');
		const filterToggle = document.getElementById('btnTodoFilterToggle');
		const categorySel = document.getElementById('todoFilterCategory');
		const searchEl = document.getElementById('todoSearch');
		const btnToDoApplyFilters = document.getElementById('btnToDoApplyFilters');
		const btnClearFilters = document.getElementById('btnClearFilters');
		const sortMenuEl = document.getElementById('todoSortMenu');
		const currentSortLabel = document.getElementById('todoCurrentSortLabel');
		const activeFiltersBar = document.getElementById('activeFiltersBar');

		// Module state and derived constants
		const state = { q: '', category: '', sort: null, sortExplicit: false, items: [], viewStage: 'all' };
		const stages = (() => {
			try {
				const root = stageViewMenu || document.getElementById('stageViewMenu');
				if (!root) return [];
				return Array.from(root.querySelectorAll('[data-stage]'))
					.map(el => el.getAttribute('data-stage'))
					.filter(Boolean);
			} catch (_) { return []; }
		})();

		// Hints cache for category typeahead (shared by filter and widget)
		let todoCategoryHints = [];

		/**
		 * Load and cache category hints used by the filter typeahead and category widgets.
		 * Populates the `todoCategoryHints` array and the `<datalist id="todoCategoriesGlobal">` when present.
		 * Uses App.utils.fetchJSONUnified('/api/todo-categories') to retrieve items.
		 * @returns {Promise<void>}
		 */
		async function loadTodoCategoryHints() {
			try {
				const dl = document.getElementById('todoCategoriesGlobal');
				if (dl && dl.dataset.loaded === '1') {
					// If already loaded, ensure cache populated from existing options if empty
					if (!todoCategoryHints || todoCategoryHints.length === 0) {
						try { todoCategoryHints = Array.from(dl.querySelectorAll('option')).map(o => o.value).filter(Boolean).slice(0, 200); } catch (_) {}
					}
					return;
				}
				const data = await App.utils.fetchJSONUnified('/api/todo-categories', { dedupe: true });
				todoCategoryHints = (data.items || []).map(c => c.name).filter(Boolean).slice(0, 200);
				if (dl) {
					dl.innerHTML = todoCategoryHints.map(n => `<option value="${n}"></option>`).join('');
					dl.dataset.loaded = '1';
				}
			} catch (err) {
				console.warn('loadTodoCategoryHints failed', err);
				try {
					const dl = document.getElementById('todoCategoriesGlobal');
					if (dl) todoCategoryHints = Array.from(dl.querySelectorAll('option')).map(o => o.value).filter(Boolean).slice(0, 200);
				} catch (_) {}
			}
		}

		// Category badges now rendered via shared BlogHelpers.renderCategoryBadges

		// --- UI helpers for sort and filter toggle ---
		function updateSortLabel() {
			if (!currentSortLabel) return;
			let label = 'Sort';
			if (state.sort) {
				const btn = sortMenuEl ? sortMenuEl.querySelector(`[data-sort="${state.sort}"]`) : null;
				label = btn ? (btn.textContent || 'Sort') : (String(state.sort).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
			}
			currentSortLabel.textContent = label;
		}

		function updateSortMenuActive() {
			if (!sortMenuEl) return;
			sortMenuEl.querySelectorAll('[data-sort]').forEach(el => {
				const s = el.getAttribute('data-sort');
				el.classList.toggle('active', !!state.sort && s === state.sort);
			});
		}

		function updateFilterBtnActive() {
			const active = !!(state.q || state.category);
			if (filterToggle) {
				filterToggle.classList.toggle('btn-primary', active);
				filterToggle.classList.toggle('btn-outline-secondary', !active);
			}
		}


		// Filter typeahead now provided by shared BlogHelpers.setupFilterTypeahead


		/**
		 * Initialize the TagTypeahead category widget inside a root element.
		 * This wires the chips container, input and hidden JSON input for category editing.
		 * @param {HTMLElement} rootEl - Root DOM element containing widget sub-elements
		 * @param {Object} opts - Selectors and initial values
		 */
		// Category widget now provided by shared BlogHelpers.setupCategoryWidget

		// Use the global RichText implementation only (no fallbacks). Let it fail loudly if missing.
		const RichText = window.RichText;

		// No BlogModule: rely directly on BlogHelpers and SiteDate. This avoids referencing a now-removed BlogModule file.
		// No wrapper helpers — use BlogHelpers and SiteDate directly where needed.
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
					const arr = JSON.parse(jsonInp.value);
					if (Array.isArray(arr) && arr.length) category = arr.join(', ');
				} catch (_) {
					category = '';
				}
			} else {
				category = '';
			}
			const stage = editForm.querySelector('[data-todo-detail-edit-stage]').value || '';
			const due = editForm.querySelector('[data-todo-detail-edit-due]').value;
			const description = editForm.querySelector('[data-todo-detail-edit-description]').value;
			// Prefer canonical/original values captured at render time to avoid
			// false positives when the list no longer contains this item (filters/refresh)
			const originalItem = state.items.find(item => item._id === todoId);
			const origTitle = (editForm.dataset.origTitle != null) ? editForm.dataset.origTitle : ((originalItem && (originalItem.title || '')) || '');
			const origCategory = (editForm.dataset.origCategory != null)
				? editForm.dataset.origCategory
				: (originalItem
					? (Array.isArray(originalItem.category)
						? (originalItem.category.join(', ') || '')
						: (originalItem.category || ''))
					: '');
			const origStage = (editForm.dataset.origStage != null) ? editForm.dataset.origStage : ((originalItem && (originalItem.stage || '')) || '');
			const origDue = (editForm.dataset.origDue != null)
				? editForm.dataset.origDue
				: (originalItem
					? (originalItem.due_date
						? (originalItem.due_date.slice ? originalItem.due_date.slice(0, 10) : originalItem.due_date)
						: '')
					: '');
			const origDescription = (editForm.dataset.origDescription != null) ? editForm.dataset.origDescription : ((originalItem && (originalItem.description || '')) || '');

			const hasChanges = (title !== origTitle)
				|| (category !== origCategory)
				|| (stage !== origStage)
				|| (due !== origDue)
				|| (description !== origDescription);
				if (hasChanges || isEditing) {
				todoEditStateCache[todoId] = {
					isEditing,
					title,
					category,
					stage,
					due,
					description,
					hasChanges
				};
					if (window && window.TODO_DEBUG) console.debug('todo: saveEditStateToCache', todoId, todoEditStateCache[todoId]);
				} else {
					delete todoEditStateCache[todoId];
					if (window && window.TODO_DEBUG) console.debug('todo: cleared cache for', todoId);
				}
			updateUnsavedChangesFlag();
		}

		function clearEditStateFromCache(todoId) {
			delete todoEditStateCache[todoId];
			if (window && window.TODO_DEBUG) console.debug('todo: clearEditStateFromCache', todoId);
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

		/**
		 * Fetch the to-do list from the server according to `state` (filters, sort, viewStage).
		 * Updates `state.items` and triggers a re-render via `renderList()`.
		 * @param {boolean} [forceFresh=false] - When true, adds a cache-buster to the request
		 */
		async function apiList(forceFresh = false) {
			// Add lightweight cache-buster when we know data changed (stage update/delete)
			let url = `/api/todo?per_page=100` + (forceFresh ? `&__ts=${Date.now()}` : '');
			// Only include sort if user has explicitly picked one this session; otherwise
			// let backend supply stored preference.
			if (state.sortExplicit && state.sort) url += `&sort=${encodeURIComponent(state.sort)}`;
			if (state.viewStage !== 'all') url += `&stage=${encodeURIComponent(state.viewStage)}`;
			if (state.q) url += `&q=${encodeURIComponent(state.q)}`;
			if (state.category) url += `&category=${encodeURIComponent(state.category)}`;
			// Show loader while fetching
			try { if (listEl && App?.utils?.ui?.showLoader) App.utils.ui.showLoader(listEl); } catch(_) {}
			let data;
			try {
				// Intentionally omit dedupe so we always get fresh data after mutations.
				try { console.debug('todo.js: apiList fetching', { url, forceFresh }); } catch (_) {}
				data = await App.utils.fetchJSONUnified(url);
				try { console.debug('todo.js: apiList returned', { items: (data && data.items) ? (data.items.length) : 0, sort: data && data.sort }); } catch (_) {}
			} catch (e) {
				console.error('Todo list fetch failed', e);
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


		/**
		 * Render the flat list of to-dos into `#todoFlatList` using `#todoItemTemplate`.
		 * Respects `state.items` and binds handlers for each rendered item.
		 */
		function renderList() {
			if (!listEl) {
				try {
					console.warn('todo.js: renderList called but #todoFlatList (listEl) is missing');
					// include a stack trace to help identify the caller and timing
					console.trace && console.trace();
				} catch (_) {}
				return;
			}
			if (listEl) {
				App.utils.tools.del_child(listEl);
			}
			let items = [...state.items];
			if (!items.length) {
				if (listEl) {
					App.utils.tools.del_child(listEl);
					listEl.innerHTML = '<div class="text-muted small fst-italic">No items.</div>';
				}
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
				// Pin visual
				node.classList.toggle('pinned', !!it.pinned);
				node.querySelector('.todo-title').textContent = it.title;
				const cat = node.querySelector('.todo-category');
				if (cat) {
					try { window.BlogHelpers && window.BlogHelpers.renderCategoryBadges(cat, it.category); } catch (e) { console.error('todo.js: renderCategoryBadges failed', e); }
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
				const ikThumb = (url) => (window.ImageUploader && window.ImageUploader.thumbTransform) ? window.ImageUploader.thumbTransform(url, 280, 280, false) : url;
				if (desc) desc.textContent = truncateDesc(it.description || '');
				// Stage badge in list
				const stageChip = node.querySelector('.todo-stage');
				if (stageChip) {
					const btn = document.querySelector(`#stageViewMenu [data-stage="${it.stage}"]`);
					stageChip.textContent = btn ? (btn.textContent || '').trim() : (String(it.stage || '').replace(/_/g, ' '));
					try { if (window.BlogHelpers && window.BlogHelpers.applyStageBadge) window.BlogHelpers.applyStageBadge(stageChip, it.stage); } catch (e) { console.error('todo.js: applyStageBadge failed in hydrate', e); throw e; }
					stageChip.classList.toggle('d-none', !it.stage);
				}
				const sel = node.querySelector('.todo-stage-select-inline');
				if (sel) {
					sel.value = it.stage;
					sel.addEventListener('change', () => quickStage(it._id, sel.value, node));
				}

				// Pin toggle
				const pinBtn = node.querySelector('.btn-pin');
				if (pinBtn) {
						// Initialize visual state
						pinBtn.classList.toggle('btn-warning', !!it.pinned);
						pinBtn.classList.toggle('btn-outline-warning', !it.pinned);
						pinBtn.title = it.pinned ? 'Unpin' : 'Pin';
						// update label text inside the dropdown item
						const lbl = pinBtn.querySelector('.pin-label') || pinBtn.querySelector('.pinLabel') || pinBtn.querySelector('span');
						if (lbl) lbl.textContent = it.pinned ? 'Unpin' : 'Pin';
					pinBtn.addEventListener('click', async (e) => {
						e.stopPropagation();
						const currentlyPinned = !!it.pinned;
						// Toggle local state and visuals (no client-side reordering)
						it.pinned = !currentlyPinned;
						try { node.classList.toggle('pinned', !!it.pinned); } catch (_) {}
						pinBtn.classList.toggle('btn-warning', !!it.pinned);
						pinBtn.classList.toggle('btn-outline-warning', !it.pinned);
						pinBtn.title = it.pinned ? 'Unpin' : 'Pin';
						if (lbl) lbl.textContent = it.pinned ? 'Unpin' : 'Pin';
						// Close dropdown that contains the action if any
						const dd = pinBtn.closest('.dropdown'); if (dd) { const inst = bootstrap && bootstrap.Dropdown ? bootstrap.Dropdown.getOrCreateInstance(dd.querySelector('[data-bs-toggle]')) : null; try { inst && inst.hide && inst.hide(); } catch (_) {} }
						try {
							await App.utils.fetchJSONUnified(`/api/todo/${it._id}/pin`, {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								body: JSON.stringify({ pinned: it.pinned })
							});
							// refresh list to get server canonical ordering
							await apiList(true);
						} catch (err) {
							// revert local change on failure
							it.pinned = currentlyPinned;
							try { node.classList.toggle('pinned', !!it.pinned); } catch (_) {}
							pinBtn.classList.toggle('btn-warning', !!it.pinned);
							pinBtn.classList.toggle('btn-outline-warning', !it.pinned);
							pinBtn.title = it.pinned ? 'Unpin' : 'Pin';
							if (lbl) lbl.textContent = it.pinned ? 'Unpin' : 'Pin';
							window.flash && window.flash('Pin toggle failed', 'danger');
							// ensure canonical list
							apiList(true);
						}
					});
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
				if (!activeFiltersBar) {
					console.debug('todo.js: activeFiltersBar missing; skipping updateActiveFilterChips');
					return;
				}
				activeFiltersBar.innerHTML = chips.join(' ');
				activeFiltersBar.style.display = chips.length ? 'flex' : 'none';
			}


		} // end renderList

			function normalizePatchClears(obj) {
				['description', 'category', 'due_date'].forEach(f => {
					if (f in obj && obj[f] === '') obj[f] = null;
				});
			}
			async function persistTodo(fd) {
				const id = idInput.value.trim();
				const payload = Object.fromEntries(fd.entries());
				// convert categories JSON to category array
				if (payload.categories) {
					try {
						const arr = JSON.parse(payload.categories || '[]');
						if (Array.isArray(arr)) payload.category = arr;
					} catch (e) { console.error('todo.js: parsing payload.categories failed in persistTodo', e); throw e; }
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
					window.flash('To-Do saved', 'success');
				} catch (e) {
					console.error('todo.js: Save failed', e);
					if (!e || !e.status) window.flash('Failed to save to-do', 'danger');
					throw e;
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
					console.error('todo.js: Update failed', e);
					throw e;
				}
			}
			async function deleteTodo(id) {
				if (!confirm('Delete this item?')) return;
				try {
					await App.utils.fetchJSONUnified(`/api/todo/${id}`, {
						method: 'DELETE'
					});
					window.flash('Deleted', 'info');
					apiList(true);
				} catch (e) {
					console.error('todo.js: Delete failed', e);
					window.flash('Failed to delete item', 'danger');
					throw e;
				}
			}

			function bindItemHandlers(node, data) {
				const wf = (el, fn) => (App && App.utils && App.utils.withSingleFlight) ? App.utils.withSingleFlight(el, fn) : fn();
				try {
					console.debug('todo.js: bindItemHandlers - binding handlers for item', { id: data._id, node });
				} catch (_) {}
				const delBtn = node.querySelector('.btn-delete');
				if (delBtn) {
					delBtn.addEventListener('click', (e) => {
						e.stopPropagation();
						console.debug('todo.js: item delete clicked', { id: data._id });
						wf(node, () => deleteTodo(data._id));
					});
				}
				node.addEventListener('click', (e) => {
					try {
						// Ignore clicks that begin inside interactive controls like dropdowns or selects
						if (e.target.closest('.btn-delete') || e.target.closest('select') || e.target.closest('.dropdown')) return;
						console.debug('todo.js: item node clicked - opening detail', { id: data._id });
						openDetailModal(data._id);
					} catch (err) {
						console.error('todo.js: error in item click handler', err, { id: data._id });
						throw err;
					}
				});
				try {
					console.debug('todo.js: bindItemHandlers completed for', data._id);
				} catch (_) {}
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
				if (detailModal) detailModal.hide();

				// setup create modal category widget
				try {
					window.BlogHelpers.setupCategoryWidget(form, {
						chipsSelector: '[data-todo-create-categories]',
						inputSelector: '[data-todo-create-category-input]',
						jsonInputSelector: '[data-todo-create-categories-json]',
						addBtnSelector: '[data-todo-create-add-btn]',
						initial: [],
						ensureLoaded: () => loadTodoCategoryHints(),
						getHints: () => todoCategoryHints
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
				return globalThis.SiteDate.parse(obj);
			}

			function fmtDate(v) {
				return globalThis.SiteDate.toDateString(v);
			}

			function fmtDateTime(v) {
				return globalThis.SiteDate.toDateTimeString(v);
			}

			function date10(v) {
				return globalThis.SiteDate.toDateString(v);
			}

			function date16(v) {
				return globalThis.SiteDate.toDateTimeString(v);
			}

			// Safe comment renderer: prefer BlogHelpers.renderComments when available,
			// otherwise fall back to a minimal renderer that uses RichText and ImageUploader.
			function safeRenderComments(wrapper, commentsList, opts = {}) {
				try {
					if (window.BlogHelpers && window.BlogHelpers.renderComments) {
						window.BlogHelpers.renderComments(wrapper, commentsList, opts);
						return;
					}
				} catch (_) {}
				// Fallback minimal renderer
				if (!commentsList || !commentsList.length) {
					wrapper.innerHTML = '<div class="text-muted">No comments</div>';
					return;
				}
				const ikThumb = (url) => (window.ImageUploader && window.ImageUploader.thumbTransform) ? window.ImageUploader.thumbTransform(url, 280, 280, false) : url;
				const markdownToggleSelector = opts.markdownToggleSelector;
				const markdownEnabled = markdownToggleSelector ? !!document.querySelector(markdownToggleSelector)?.checked : (localStorage.getItem('todo-markdown-enabled') === 'true');
				wrapper.innerHTML = commentsList.map(c => {
					const images = (c.images || []).map((u,i) => `<div class='mt-2'><img src='${ikThumb(u)}' data-viewer-thumb data-viewer-group='todo-comment-${opts.item?opts.item._id:''}' data-viewer-src='${u}' alt='comment image ${i+1}' style='max-width:140px;max-height:140px;height:auto;border:1px solid var(--border-color);border-radius:4px;cursor:pointer;object-fit:cover;'/></div>`).join('');
					const formattedText = RichText.renderInlineContent(c.body || '', `todo-comment-${opts.item?opts.item._id:''}`, !!markdownEnabled);
					return `
					<div class='todo-comment'>
					  <div class='body'>
					    <div class='content' data-markdown-container>${formattedText}</div>
					    ${images}
					    <div class='meta d-flex align-items-center'>
					      <div class='datetime text-muted'>${fmtDateTime(c.created_at)}</div>
					      <div class='ms-auto'>
					        ${opts.deleteEndpointPrefix ? `<button class='btn btn-sm btn-outline-danger action-btn' data-comment-del='${c._id}' title='Delete'><i class='fa-solid fa-trash' aria-hidden='true'></i><span class='d-none d-sm-inline ms-1'>Delete</span></button>` : ''}
					      </div>
					    </div>
					  </div>
					</div>`;
				}).join('');
				// delegate delete clicks
				wrapper.querySelectorAll('[data-comment-del]').forEach(btn => btn.addEventListener('click', async (e) => {
					e.preventDefault();
					const cid = btn.getAttribute('data-comment-del');
					try {
						await App.utils.fetchJSONUnified(`${opts.deleteEndpointPrefix || '/api/comments/'}${cid}`, { method: 'DELETE' });
						if (opts.onDeleted) opts.onDeleted(opts.item?opts.item._id:undefined);
					} catch (e) { console.error('todo.js: comment delete failed in safeRenderComments', e); if (window.flash) window.flash('Delete failed', 'danger'); throw e; }
				}));
			}

			/**
			 * Open the detail modal for a given to-do id. Fetches detail and comments then renders.
			 * @param {string} id - To-do id
			 */
			async function openDetailModal(id) {
				try {
					const data = await App.utils.fetchJSONUnified(`/api/todo/${id}/detail`, {
						dedupe: true
					});
					try {
						renderDetail(data);
						detailModal && detailModal.show();
					} catch (inner) {
						console.error('todo.js: Render detail failed', inner, data);
						window.flash('Detail render error', 'danger');
						throw inner;
					}
				} catch (e) {
					console.error('todo.js: Detail fetch failed', e);
					window.flash('Failed to load detail', 'danger');
					throw e;
				}
			}


			/**
			 * Render detail modal content from server-provided data object.
			 * Populates view and edit forms, comments and history.
			 * @param {Object} data - Server response with `item` and `comments` properties
			 */
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
						catEl.textContent = Array.isArray(item.category) ? item.category.join(', ') : item.category;
						catEl.classList.remove('d-none');
						const firstCat = Array.isArray(item.category) ? item.category[0] : item.category;
						window.BlogHelpers.applyCategoryBadge(catEl, firstCat);
					} else {
						catEl.classList.add('d-none');
					}
				}
				const stageEl = detailModalEl.querySelector('[data-todo-detail-stage]');
				if (stageEl) {
					const btn = document.querySelector(`#stageViewMenu [data-stage="${item.stage}"]`);
					stageEl.textContent = btn ? (btn.textContent || '').trim() : (String(item.stage || '').replace(/_/g, ' '));
					window.BlogHelpers.applyStageBadge(stageEl, item.stage);
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
										safeRenderComments(commentsWrapInner, commentsWrapInner._lastCommentsData, {
											item,
											deleteEndpointPrefix: '/api/todo-comments/',
											markdownToggleSelector: '[data-todo-markdown-toggle]',
											onDeleted: (id) => openDetailModal(id)
										});
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
						// Store last comments data on wrapper for re-render when markdown toggle changes
						const comments = data.comments || [];
						commentsWrap._lastCommentsData = comments;
						safeRenderComments(commentsWrap, comments, {
							item,
							deleteEndpointPrefix: '/api/todo-comments/',
							markdownToggleSelector: '[data-todo-markdown-toggle]',
							onDeleted: (id) => openDetailModal(id)
						});
						// When markdown toggle changes, re-render comments with the cached data
						const mt = detailModalEl.querySelector('[data-todo-markdown-toggle]');
						if (mt) {
							mt.addEventListener('change', () => {
								safeRenderComments(commentsWrap, commentsWrap._lastCommentsData, {
									item,
									deleteEndpointPrefix: '/api/todo-comments/',
									markdownToggleSelector: '[data-todo-markdown-toggle]',
									onDeleted: (id) => openDetailModal(id)
								});
							});
						}
					}
				const limitEl = detailModalEl.querySelector('[data-todo-comment-limit]');
				if (limitEl) limitEl.textContent = `${(data.comment_max || 2000)} chars max`;
				const formC = detailModalEl.querySelector('[data-todo-comment-form]');
				if (formC) formC.dataset.todoId = item._id;
				// Populate edit form (kept hidden until user clicks Edit)
				const editForm = detailModalEl.querySelector('[data-todo-detail-edit-form]');
				if (editForm) {
					// Capture canonical/original values from server item for reliable change detection
					const origTitle = item.title || '';
					const origCatsArr = Array.isArray(item.category)
						? item.category.slice()
						: ((typeof item.category === 'string' && item.category.trim()) ? item.category.split(',').map(s => s.trim()).filter(Boolean) : []);
					const origCategory = (origCatsArr || []).join(', ');
					const origStage = item.stage || 'wondering';
					const origDue = item.due_date ? date10(item.due_date) : '';
					const origDescription = item.description || '';
					editForm.dataset.origTitle = origTitle;
					editForm.dataset.origCategory = origCategory;
					editForm.dataset.origStage = origStage;
					editForm.dataset.origDue = origDue;
					editForm.dataset.origDescription = origDescription;
					// If we have a cached unsaved edit state for this item, restore it.
					const cached = item._id && todoEditStateCache[item._id] ? todoEditStateCache[item._id] : null;
					if (cached) {
						if (window && window.TODO_DEBUG) console.debug('todo: restoring cache for', item._id, cached);
						// Title
						editForm.querySelector('[data-todo-detail-edit-title]').value = cached.title || '';
						// Categories (cached may be comma-separated string)
						const cachedCats = (cached.category && typeof cached.category === 'string') ? cached.category.split(',').map(s => s.trim()).filter(Boolean) : [];
						try {
							window.BlogHelpers.setupCategoryWidget(editForm, {
								chipsSelector: '[data-todo-detail-categories]',
								inputSelector: '[data-todo-detail-category-input]',
								jsonInputSelector: '[data-todo-detail-categories-json]',
								initial: cachedCats,
								ensureLoaded: () => loadTodoCategoryHints(),
								getHints: () => todoCategoryHints
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
						if (window && window.TODO_DEBUG) console.debug('todo: no cache for', item._id, '— populating from server');
						// No cached state — populate from server-provided item
						editForm.querySelector('[data-todo-detail-edit-title]').value = item.title || '';
						const initialCats = [];
						if (Array.isArray(item.category)) initialCats.push(...item.category);
						else if (item.category) initialCats.push(item.category);
						try {
							window.BlogHelpers.setupCategoryWidget(editForm, {
								chipsSelector: '[data-todo-detail-categories]',
								inputSelector: '[data-todo-detail-category-input]',
								jsonInputSelector: '[data-todo-detail-categories-json]',
								initial: initialCats,
								ensureLoaded: () => loadTodoCategoryHints(),
								getHints: () => todoCategoryHints
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
					// Use BlogHelpers for inline image uploads
					window.BlogHelpers.attachInlineImageUploader({
						contentEl: editContent,
						fileInput: editFileInput,
						trigger: editTrigger,
						uploadEndpoint: '/api/todo-images'
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

				// Delegate header clicks to avoid double-invocation and ensure controls work after re-render
				if (!detailModalEl._headerClickBound) {
					detailModalEl._headerClickBound = true;
					detailModalEl.addEventListener('click', async (e) => {
						if (e.target.closest('[data-todo-detail-edit-btn]')) {
							try {
								switchToEdit();
							} catch (_) {}
						}
						if (e.target.closest('[data-todo-detail-cancel-btn]')) {
							const _ef = detailModalEl.querySelector('[data-todo-detail-edit-form]');
							const tid = _ef && _ef.dataset ? _ef.dataset.todoId : undefined;
							if (tid) clearEditStateFromCache(tid);
							try {
								switchToView();
							} catch (_) {}
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
										fd.forEach((v, k) => {
											patch[k] = v.toString();
										});
										// convert categories JSON to category string if present
										if (patch.categories) {
											try {
												const arr = JSON.parse(patch.categories || '[]');
												if (Array.isArray(arr)) patch.category = arr;
											} catch (_) {}
											delete patch.categories;
										}
										if (patch.due_date === '') patch.due_date = null;
										if (Array.isArray(patch.category) && patch.category.length === 0) patch.category = null;
										await App.utils.fetchJSONUnified(`/api/todo/${todoId}`, {
											method: 'PATCH',
											headers: {
												'Content-Type': 'application/json'
											},
											body: JSON.stringify(patch)
										});
										window.flash('Updated', 'success');
										// Clear any cached edit state now that the item is saved
										clearEditStateFromCache(todoId);
										switchToView();
										openDetailModal(todoId);
										apiList();
									}
								}
							} catch (_) {
								window.flash('Update failed', 'danger');
							}
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
						const tid = editFormEl && editFormEl.dataset ? editFormEl.dataset.todoId : undefined;
						if (tid) saveEditStateToCache(tid, rootHide);
					});
				}

				// Auto-save edit state while editing (debounced). Bind once per form instance.
				if (editForm && !editForm._autoSaveBound) {
					editForm._autoSaveBound = true;
					const debouncedSaveState = window.BlogHelpers.debounce(() => {
						const rootAuto = detailModalEl.querySelector('[data-todo-detail-root]');
						const _ef2 = rootAuto.querySelector('[data-todo-detail-edit-form]');
						const tid = _ef2 && _ef2.dataset ? _ef2.dataset.todoId : undefined;
						if (tid && !editForm.classList.contains('d-none')) saveEditStateToCache(tid, rootAuto);
					}, 500);
					editForm.addEventListener('input', debouncedSaveState);
				}
			}


			if (detailModalEl) {
				const formC = detailModalEl.querySelector('[data-todo-comment-form]');
				// Maintain per-item unsent draft so switching items doesn't leak comment text/images
				const todoDrafts = {};
				if (formC) {
					// attachCommentUploader if ImageUploader is available; use optional chaining so
					// we don't need a separate existence check.
					window.ImageUploader.attachCommentUploader({
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
							if (formC._imageUploader && formC._imageUploader.setImages) {
								formC._imageUploader.setImages(d.images || []);
							}
						}
					});
					// Persist draft on input changes
					formC.addEventListener('input', () => {
						const tid = formC.dataset.todoId;
						if (!tid) return;
						todoDrafts[tid] = todoDrafts[tid] || {};
						todoDrafts[tid].body = formC.querySelector('[name="body"]').value;
						todoDrafts[tid].images = formC._imageUploader && formC._imageUploader.getImages ? formC._imageUploader.getImages() : [];
					});
					// When switching items (dataset.todoId changes) save old draft first via MutationObserver
					const obs = new MutationObserver(() => {
						// dataset change triggers observer; ensure new draft loaded
						const tid = formC.dataset.todoId;
						if (!tid) return;
						const d = todoDrafts[tid];
						formC.querySelector('[name="body"]').value = (d && d.body) || '';
						if (formC._imageUploader && formC._imageUploader.setImages) {
							formC._imageUploader.setImages((d && d.images) || []);
						}
					});
					obs.observe(formC, {
						attributes: true,
						attributeFilter: ['data-todo-id'],
						subtree: false
					});
					formC.addEventListener('submit', async e => {
						e.preventDefault();
						const todoId = formC.dataset.todoId;
						if (!todoId) return;
						const fd = new FormData(formC);
						const body = (fd.get('body') || '').toString().trim();
						const imgs = formC._imageUploader && formC._imageUploader.getImages ? formC._imageUploader.getImages() : [];
						if (!body && !imgs.length) return;
						try {
							await App.utils.fetchJSONUnified(`/api/todo/${todoId}/comments`, {
								method: 'POST',
								headers: {
									'Content-Type': 'application/json'
								},
								body: JSON.stringify({
									body,
									images: imgs
								})
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
					const _desc = detailModalEl.querySelector('[data-todo-detail-description]');
					if (_desc) _desc.classList.add('d-none');
					editBtn.classList.add('d-none');
					saveBtn.classList.remove('d-none');
					cancelBtn.classList.remove('d-none');
					populateCategoryHints();
				}

				function switchToView() {
					if (!editForm) return;
					editForm.classList.add('d-none');
					const _desc2 = detailModalEl.querySelector('[data-todo-detail-description]');
					if (_desc2) _desc2.classList.remove('d-none');
					editBtn.classList.remove('d-none');
					saveBtn.classList.add('d-none');
					cancelBtn.classList.add('d-none');
				}
				editBtn.addEventListener('click', e => {
					e.preventDefault();
					switchToEdit();
				});
				cancelBtn.addEventListener('click', e => {
					e.preventDefault();
					switchToView();
				});
				saveBtn.addEventListener('click', async e => {
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
							if (Array.isArray(arr)) patch.category = arr;
						} catch (_) {}
						delete patch.categories;
					}
					if (patch.due_date === '') patch.due_date = null;
					if (Array.isArray(patch.category) && patch.category.length === 0) patch.category = null;
					try {
						await App.utils.fetchJSONUnified(`/api/todo/${todoId}`, {
							method: 'PATCH',
							headers: {
								'Content-Type': 'application/json'
							},
							body: JSON.stringify(patch)
						});
						window.flash('Updated', 'success');
						// Clear any cached edit state now that the item is saved
						clearEditStateFromCache(todoId);
						switchToView();
						openDetailModal(todoId);
						apiList();
					} catch (_) {
						window.flash('Update failed', 'danger');
					}
				});
			}

			// Inline image paste/drag/file upload for create modal (form.description)
			// Attach inline uploader for create modal (safe wrapper)
			if (form && form.description) {
				const descInput = form.description;
				const fileInput = modalEl.querySelector('[data-todo-description-image]');
				const trigger = modalEl.querySelector('[data-todo-description-image-trigger]');
				try {
					window.BlogHelpers.attachInlineImageUploader({
						contentEl: descInput,
						fileInput,
						trigger,
						uploadEndpoint: '/api/todo-images'
					});
				} catch (_) {}
			}

			// Install navigation warnings while there are unsaved inline edits
			window.BlogHelpers.setupNavigationWarnings(() => hasAnyUnsavedChanges());

			if (form) {
				form.addEventListener('submit', e => {
					e.preventDefault();
					const runner = App.utils.withSingleFlight;
					runner(form, async () => {
						const fd = new FormData(form);
						try {
							await persistTodo(fd);
							if (bsModal) bsModal.hide();
						} catch (e) {
							console.error('todo.js: persistTodo failed from submit handler', e);
							throw e;
						}
					});
				});
			}

			// Safe attach: ignore missing optional elements instead of throwing
			/**
			 * Safely attach an event handler if the element exists.
			 * Useful for optional controls that may be absent on some pages.
			 * @param {HTMLElement|null} el - Element to attach to (may be null)
			 * @param {string} ev - Event name
			 * @param {Function} fn - Handler
			 */
			const safeOn = (el, ev, fn) => {
				try {
					if (!el) {
						console.debug(`todo.js: safeOn - element missing for event ${ev}`);
						return;
					}
					console.debug('todo.js: safeOn - attaching', { event: ev, element: el });
					el.addEventListener(ev, function wrappedSafeOn(e) {
						try {
							console.debug('todo.js: handler invoked (safeOn)', { event: ev, target: e.target });
							return fn.call(this, e);
						} catch (err) {
							console.error('todo.js: error in safeOn handler', err);
							throw err;
						}
					});
				} catch (err) {
					console.error('todo.js: safeOn attach failed', err);
					throw err;
				}
			};
			btnNews.forEach(btn => {
				try {
					console.debug('todo.js: binding btnNew click', { btn });
					btn.addEventListener('click', (e) => {
						console.debug('todo.js: btnNew click handler invoked', { btn, eventTarget: e.target });
						openCreateModal();
						if (stageSelect) stageSelect.value = (state.viewStage !== 'all' ? state.viewStage : 'wondering');
					});
				} catch (err) {
					console.error('todo.js: failed to bind btnNew click', err, btn);
					throw err;
				}
			});
			// Removed direct binding for filterToggle; using a single delegated handler instead to avoid double toggles
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
			/**
			 * Persist a user sort preference for todos on the server.
			 * Best-effort: failures are intentionally ignored.
			 * @param {string} s - Sort key
			 * @returns {Promise<void>}
			 */
			async function saveSortPreference(s) {
				try {
					await App.utils.fetchJSONUnified('/api/sort-pref', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({
							name: 'todo',
							sort: s
						})
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

			// Add delegated click as a robust fallback for Filter toggle
			// Removed secondary delegated handler to prevent duplicate toggles; the early global handler defined at load time is sufficient

			// Set up modal cleanup
			window.CommentFormatter && window.CommentFormatter.setupModalCleanup(detailModalEl, ['[data-todo-comment-form]']);

			// Attach global UI handlers idempotently. This helps if some DOM anchors
			// weren't present at initial script run — we can re-bind after the list
			// is rendered or whenever needed.
			let _globalHandlersAttached = false;

			// Start initial fetch: wait for anchors if necessary (avoid race where
			// apiList runs before DOM anchors are present). We use a short
			// MutationObserver window (5s) and fall back to proceed anyway.
			/**
			 * Locate required anchors (list/template) then perform the initial fetch.
			 * Uses a short MutationObserver window (5s) if anchors are not yet present.
			 */
			function startInitialFetch() {
				const startFetch = () => {
					try { if (window && window.TODO_DEBUG) { console.debug('todo.js: calling apiList()'); } } catch (_) {}
					// perform the list fetch (safe even if anchors absent)
					apiList();
					// attach handlers defensively
					try { attachGlobalHandlers(); } catch (_){ }
				};

				if (listEl && tmpl) {
					startFetch();
					return;
				}

				console.debug('todo.js: waiting for anchors before initial fetch');
				const obsTarget = document.body || document.documentElement;
				let timedOut = false;
				const obs = new MutationObserver((mutations, o) => {
					const l = document.getElementById('todoFlatList');
					const t = document.getElementById('todoItemTemplate');
					if (l && t) {
						listEl = l; tmpl = t;
						o.disconnect();
						clearTimeout(timeoutId);
						startFetch();
					}
				});
				obs.observe(obsTarget, { childList: true, subtree: true });
				const timeoutId = setTimeout(() => {
					timedOut = true;
					obs.disconnect();
					console.warn('todo.js: anchors not found within wait window; proceeding anyway');
					startFetch();
				}, 5000);
			}

			startInitialFetch();

			/**
			 * Attach handlers for global UI controls. Idempotent: each anchor uses
			 * an internal flag to avoid double-binding when this function is called
			 * multiple times.
			 */
			function attachGlobalHandlers() {
				try {
					// Stage view menu
					const stageViewMenuEl = document.getElementById('stageViewMenu');
					if (stageViewMenuEl && !stageViewMenuEl._todoBound) {
						stageViewMenuEl.querySelectorAll('[data-stage]').forEach(el => {
							if (el._todoBound) return;
							el.addEventListener('click', () => {
								const st = el.getAttribute('data-stage');
								if (!st) return;
								state.viewStage = st;
								apiList();
								const stageViewLabelLocal = document.getElementById('stageViewLabel');
								if (stageViewLabelLocal) {
									stageViewLabelLocal.textContent = st === 'all' ? 'All Stages' : st.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
								}
								stageViewMenuEl.querySelectorAll('.dropdown-item').forEach(it => it.classList.toggle('active', it === el));
							});
							el._todoBound = true;
						});
						stageViewMenuEl._todoBound = true;
					}

					// Filters and search: filter toggle handled by single delegated listener defined at load time

					const btnApply = document.getElementById('btnToDoApplyFilters');
					if (btnApply && !btnApply._todoBound) {
						btnApply.addEventListener('click', () => {
							const searchElLocal = document.getElementById('todoSearch');
							const categorySelLocal = document.getElementById('todoFilterCategory');
							state.q = (searchElLocal && searchElLocal.value || '').trim();
							state.category = categorySelLocal ? categorySelLocal.value || '' : '';
							apiList();
						});
						btnApply._todoBound = true;
					}

					const btnClear = document.getElementById('btnClearFilters');
					if (btnClear && !btnClear._todoBound) {
						btnClear.addEventListener('click', () => {
							const searchElLocal = document.getElementById('todoSearch');
							const categorySelLocal = document.getElementById('todoFilterCategory');
							if (searchElLocal) searchElLocal.value = '';
							if (categorySelLocal) categorySelLocal.value = '';
							state.q = '';
							state.category = '';
							apiList();
						});
						btnClear._todoBound = true;
					}

					// Bind typeahead on focus and when filters are shown
					const catInput = document.getElementById('todoFilterCategory');
					if (catInput && !catInput._typeaheadInitBound) {
						catInput._typeaheadInitBound = true;
						catInput.addEventListener('focus', () => { try { window.BlogHelpers.setupFilterTypeahead(catInput, { getHints: () => todoCategoryHints, ensureLoaded: () => loadTodoCategoryHints(), limit: 8 }); loadTodoCategoryHints(); } catch (_) {} });
					}

					// Sort menu
					const sortMenuLocal = document.getElementById('todoSortMenu');
					if (sortMenuLocal) {
						sortMenuLocal.querySelectorAll('[data-sort]').forEach(el => {
							if (el._todoBound) return;
							el.addEventListener('click', () => {
								const s = el.getAttribute('data-sort');
								if (!s) return;
								state.sort = s;
								state.sortExplicit = true;
								updateSortLabel();
								updateSortMenuActive();
								apiList();
								saveSortPreference(s);
							});
							el._todoBound = true;
						});
						updateSortMenuActive();
					}

					// New todo buttons
					const newBtns = [document.getElementById('btnNewTodoTop')].filter(Boolean);
					newBtns.forEach(btn => {
						if (btn._todoBound) return;
						btn.addEventListener('click', () => {
							openCreateModal();
							const stageSelectLocal = document.getElementById('todoStageSelect') || document.querySelector('[data-todo-stage-select]');
							if (stageSelectLocal) stageSelectLocal.value = (state.viewStage !== 'all' ? state.viewStage : 'wondering');
						});
						btn._todoBound = true;
					});

					// Ensure navigation warnings are installed (defensive)
					try { window.BlogHelpers && window.BlogHelpers.setupNavigationWarnings && window.BlogHelpers.setupNavigationWarnings(() => hasAnyUnsavedChanges()); } catch (_) {}

					_globalHandlersAttached = true;
				} catch (e) {
					console.warn('attachGlobalHandlers error', e);
				}
			}


	}; // end _init

	// Always wait for DOMContentLoaded then poll a short while for App to appear.
	const onDom = () => {
		if (window.App && App.utils) {
			try {
				_init();
			} catch (e) {
				console.error('todo.js init error', e);
			}
			return;
		}
		const start = Date.now();
		const iv = setInterval(() => {
			if (window && window.TODO_DEBUG) {
				try { console.debug('todo.js: polling for App.utils...'); } catch (_) {}
			}
			if (window.App && App.utils) {
				clearInterval(iv);
				try {
					_init();
				} catch (e) {
					console.error('todo.js init error', e);
				}
				return;
			}
			if (Date.now() - start > 3000) {
				clearInterval(iv);
				console.error('todo.js: App.utils not found after waiting; ensure app_core.js is included before todo.js or that it executes correctly.');
			}
		}, 120);
	};

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', onDom, {
			once: true
		});
	} else {
		// yield one animation frame to reduce races with other scripts that
		// run immediately after parsing. This is better than calling onDom()
		// synchronously which can trigger init before anchors are inserted.
		try {
			if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(onDom);
			else setTimeout(onDom, 0);
		} catch (_) {
			try { setTimeout(onDom, 0); } catch (_) { onDom(); }
		}
	}

	// Also attempt immediate init in the common case where DOM is ready and App is available
	try {
		if (document.readyState !== 'loading' && window.App && App.utils) {
			try {
				if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => { try { _init(); } catch (e) { console.error('todo.js init error', e); } });
				else setTimeout(() => { try { _init(); } catch (e) { console.error('todo.js init error', e); } }, 0);
			} catch (e) {
				console.error('todo.js init error', e);
			}
		}
	} catch (e) {
		console.error('todo.js immediate init failed', e);
	}

	// Expose a minimal public API for page-level refresh without leaking internals
	// This lets the new OOP page entry call a safe refresh without rebinding events.
	try {
		if (!window.TodoModule) {
			window.TodoModule = {};
		}
		// Refresh the list; prefer a fresh pull to reflect server state after mutations
		window.TodoModule.refresh = function () {
			try {
				if (typeof apiList === 'function') return apiList(true);
			} catch (_) {}
		};
	} catch (_) {}
})();