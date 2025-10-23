(function () {
	// Prevent re-initialization
	if (window.TagTypeahead) return;



	// --- Utility Functions (Stateless) ---

	/** Dedupes an array of strings. */
	function dedupe(arr) {
		const out = [];
		const seen = new Set();
		for (const s of (arr || [])) {
			const v = (s || '').toString().trim();
			if (!v) continue;
			if (seen.has(v)) continue;
			seen.add(v);
			out.push(v);
		}
		return out;
	}

	/** Clamps a string to a maximum length. */
	function clampLen(s, max) {
		if (!max) return s;
		return s.length > max ? s.slice(0, max) : s;
	}

	/** Normalizes the initial value (from array, JSON string, or CSV string) into a clean array. */
	function normalizeInitial(v, maxLen) {
		if (Array.isArray(v)) {
			return dedupe(v.map(s => clampLen((s || '').toString().trim(), maxLen)).filter(Boolean));
		}
		try {
			// Try parsing as JSON array
			const a = JSON.parse(v || '[]');
			if (Array.isArray(a)) return normalizeInitial(a, maxLen);
		} catch (_) { }
		if (typeof v === 'string' && v.trim()) {
			// Treat as comma-separated string
			return normalizeInitial(v.split(',').map(s => s.trim()).filter(Boolean), maxLen);
		}
		return [];
	}

	/** Renders the tag "chips" into their container. */
	function renderChips(container, items, applyBadge) {
		if (!container) return;
		container.innerHTML = '';
		for (const name of items) {
			const wrapper = document.createElement('span');
			wrapper.className = 'badge me-1 mb-1 d-inline-flex align-items-center py-1 px-2 tag-badge';
			wrapper.style.fontSize = '0.9em';

			try {
				if (applyBadge) applyBadge(wrapper, name);
			} catch (_) { }

			const text = document.createElement('span');
			text.textContent = name;
			text.style.whiteSpace = 'nowrap';

			const btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'btn chip-close btn-sm ms-2';
			btn.setAttribute('aria-label', 'Remove');
			btn.style.marginLeft = '0.4rem';
			btn.innerHTML = "<i class='fa-solid fa-xmark' aria-hidden='true'></i>";

			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				const idx = items.indexOf(name);
				if (idx !== -1) {
					items.splice(idx, 1);
					// Dispatch custom event for the widget to listen to
					container.dispatchEvent(new CustomEvent('tag-remove', {
						bubbles: false
					}));
				}
			});

			wrapper.appendChild(text);
			wrapper.appendChild(btn);
			container.appendChild(wrapper);
		}
	}

	/** Default filtering logic for the typeahead. */
	function defaultFilter(hints, q, max) {

		const ql = (q || '').trim().toLowerCase();
		if (!hints || !hints.length) return [];
		if (!ql) return hints.slice(0, max);

		const starts = [];
		const contains = [];
		for (const name of hints) {
			const nl = name.toLowerCase();
			if (nl.startsWith(ql)) {
				starts.push(name);
			} else if (nl.includes(ql)) {
				contains.push(name);
			}
			if (starts.length >= max) break;
		}

		const out = starts.concat(contains.filter(n => !starts.includes(n)));
		return out.slice(0, max);
	}


	// --- Widget Class ---

	/**
	 * Manages the state and behavior of a tag typeahead widget.
	 */
	class TagWidget {
		constructor(opts) {
			
			this.opts = opts;
			this.inputEl = opts.inputEl;
			this.chipsEl = opts.chipsEl;
			this.jsonInput = opts.jsonInput;
			this.addBtn = opts.addBtn;
			this.mode = opts.mode === 'suggest' ? 'suggest' : 'tags';

			// Mode-specific validation
			if (this.mode === 'tags') {
				if (!this.inputEl || !this.chipsEl || !this.jsonInput) {
					throw new Error('TagTypeahead: missing required elements for "tags" mode (inputEl, chipsEl, jsonInput)');
				}
			} else { // 'suggest' mode
				if (!this.inputEl) {
					throw new Error('TagTypeahead: inputEl required for "suggest" mode');
				}
			}

			// Config
			this.maxVisible = opts.maxVisible || 8;
			this.maxNameLen = opts.maxNameLength || 64;
			this.zIndex = (opts.zIndex || 1061) + '';

			// State
			this.list = this.mode === 'tags' ? normalizeInitial(opts.initial || [], this.maxNameLen) : [];
			this.activeIndex = -1;
			this.items = []; // Current dropdown items
			this._cancelNextAdd = false;
			this.destroyed = false;

			this._createMenu();
			this._bindEvents();
			this.sync();
		}

		/** Creates the dropdown menu element and appends it to the DOM. */
		_createMenu() {
			
			// If inside a Bootstrap modal, append to body to avoid clipping/overflow issues
			const inModal = !!(this.inputEl.closest && this.inputEl.closest('.modal'));
			const parent = inModal ? document.body : (this.inputEl.parentElement || document.body);
			this._menuParentIsBody = parent === document.body;
			if (!this._menuParentIsBody && !parent.classList.contains('position-relative')) {
				parent.classList.add('position-relative');
			}
			this.menu = document.createElement('div');
			this.menu.className = 'dropdown-menu show';
			this.menu.style.position = 'absolute';
			this.menu.style.minWidth = Math.max(this.inputEl.offsetWidth, 160) + 'px';
			this.menu.style.maxHeight = '240px';
			this.menu.style.overflowY = 'auto';
			this.menu.style.display = 'none';
			this.menu.style.zIndex = this.zIndex; // default 1061; above modal content
			parent.appendChild(this.menu);
		}

		/** Binds all necessary event listeners. */
		_bindEvents() {
			
			this.inputEl.addEventListener('keydown', this._onKeyDown);
			this.inputEl.addEventListener('input', this._onInput);
			this.inputEl.addEventListener('focus', this._onFocus);
			this.inputEl.addEventListener('click', this._onClick);
			this.inputEl.addEventListener('blur', this._onBlur);
			this.inputEl.addEventListener('focusout', this._onFocusOut);

			document.addEventListener('mousedown', this._onDocMouseDown);
			window.addEventListener('resize', this._onResizeScroll);
			window.addEventListener('scroll', this._onResizeScroll, true);

			// Mode-specific bindings
			if (this.mode === 'tags') {
				if (this.chipsEl) {
					this.chipsEl.addEventListener('tag-remove', this._onChipsRemove);
				}
				if (this.addBtn) {
					this.addBtn.addEventListener('click', this._onAddBtnClick);
				}
			}
		}

		// Helper to check whether the input is actually visible/laid out
		_isInputVisible() {
			try {
				if (!this.inputEl || !this.inputEl.isConnected) return false;
				const rects = this.inputEl.getClientRects();
				if (!rects || rects.length === 0) return false;
				const cs = window.getComputedStyle(this.inputEl);
				if (!cs) return true;
				if (cs.display === 'none' || cs.visibility === 'hidden') return false;
				return true;
			} catch (_) { return true; }
		}

		// --- Event Handlers (using arrow functions to bind `this`) ---

		_onKeyDown = (e) => {
			
			// Handle Enter key in dropdown
			if (this.menu.style.display !== 'none' && e.key === 'Enter') {
				if (this.activeIndex >= 0) {
					e.preventDefault();
					this.pick(this.activeIndex);
					return;
				}
			}

			// Handle navigation and escape
			if (this.menu.style.display !== 'none' && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Escape')) {
				e.preventDefault();
				const max = this.items.length - 1;
				if (e.key === 'ArrowDown') {
					this.setActive(Math.min(max, this.activeIndex + 1));
				} else if (e.key === 'ArrowUp') {
					this.setActive(Math.max(0, this.activeIndex - 1));
				} else if (e.key === 'Escape') {
					e.stopPropagation();
					this._cancelNextAdd = true;
					this.inputEl.value = '';
					this.hide();
				}
				return;
			}

			// Handle Escape key when dropdown is closed
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				this._cancelNextAdd = true;
				this.inputEl.value = '';
				this.hide();
				return;
			}

			// Handle adding tags (Enter) or suggestions (Enter or Comma)
			if (e.key === 'Enter' || (this.mode === 'tags' && e.key === ',')) {
				e.preventDefault();
				this.addFromInput();
			}
		};

		_onInput = () => {
			
			const hints = (this.opts.getHints && this.opts.getHints()) || [];
			const arr = defaultFilter(hints, this.inputEl.value || '', this.maxVisible);
			this.renderList(arr);
		};

		_onFocus = () => {
			
			this.ensureSuggestions();
		};

		_onClick = () => {
			
			this.ensureSuggestions();
		};

		_onBlur = () => {
			
			if (this._cancelNextAdd) {
				this._cancelNextAdd = false;
				return;
			}
			// In 'tags' mode, add pending text. In 'suggest' mode, addFromInput() just hides.
			if ((this.inputEl.value || '').trim()) {
				this.addFromInput();
			}
			// Use a short delay to allow click events on the dropdown to fire
			setTimeout(() => this.hide(), 120);
		};

		_onFocusOut = (e) => {
			
			// Handle focus moving into the dropdown menu
			const rel = e.relatedTarget;
			if (!rel || !this.menu.contains(rel)) {
				setTimeout(() => {
					if (document.activeElement !== this.inputEl && !this.menu.contains(document.activeElement)) {
						this.hide();
					}
				}, 0);
			}
		};

		_onDocMouseDown = (e) => {
			
			// Hide if clicking outside the input and the menu
			try {
				if (!this.menu.contains(e.target) && e.target !== this.inputEl) {
					this.hide();
				}
			} catch (_) { }
		};

		_onChipsRemove = () => {
			
			// This is only bound in 'tags' mode
			this.sync();
		};

		_onResizeScroll = () => {
			
			this.updateMenuPosition();
		};

		_onAddBtnClick = (e) => {
			
			// This is only bound in 'tags' mode
			e.preventDefault();
			this.addFromInput();
		};

		// --- Internal Logic Methods ---

		/** Updates the dropdown's position relative to the input. */
		updateMenuPosition() {
			if (this.destroyed) return;
			
			try {
				if (!this._isInputVisible()) return;
				const rect = this.inputEl.getBoundingClientRect();
				let top, left;
				if (this._menuParentIsBody) {
					top = rect.top + (window.scrollY || window.pageYOffset || 0) + this.inputEl.offsetHeight + 2;
					left = rect.left + (window.scrollX || window.pageXOffset || 0);
				} else {
					const parent = this.inputEl.parentElement || document.body;
					const parentRect = parent.getBoundingClientRect();
					top = rect.top - parentRect.top + this.inputEl.offsetHeight + 2 + (parent.scrollTop || 0);
					left = rect.left - parentRect.left + (parent.scrollLeft || 0);
				}

				this.menu.style.top = top + 'px';
				this.menu.style.left = left + 'px';
				this.menu.style.minWidth = Math.max(this.inputEl.offsetWidth, 160) + 'px';
			} catch (_) { }
		}

		/** Hides the dropdown. */
		hide() {
			
			this.menu.style.display = 'none';
			this.activeIndex = -1;
		}

		/** Shows the dropdown if it has items. */
		show() {
			
			if (this.items.length && document.activeElement === this.inputEl && this._isInputVisible()) {
				this.menu.style.display = '';
				
			}
		}

		/** Sets the new active (highlighted) item in the dropdown. */
		setActive(idx) {
			
			this.activeIndex = idx;
			const nodes = this.menu.querySelectorAll('.dropdown-item');
			nodes.forEach((n, i) => n.classList.toggle('active', i === this.activeIndex));
		}

		/** Selects an item from the dropdown. */
		pick(idx) {
			
			if (idx < 0 || idx >= this.items.length) return;
			const name = this.items[idx];

			if (this.mode === 'tags') {
				if (!this.list.includes(name)) {
					this.list.push(name);
				}
				this.inputEl.value = '';
				this.sync();
				this.hide();
				try {
					this.inputEl.focus();
				} catch (_) { }
			} else { // 'suggest' mode
				this.inputEl.value = name;
				this.hide();
				try {
					this.inputEl.focus();
				} catch (_) { }
			}
		}

		/** Renders the list of suggestion items into the dropdown. */
		renderList(arr) {
			// dbg('renderList', { count: (arr||[]).length });
			this.items = arr;
			if (!this.items.length) {
				this.hide();
				return;
			}
			this.menu.innerHTML = this.items.map((n, i) =>
				`<button type="button" class="dropdown-item" data-idx="${i}">${n}</button>`
			).join('');

			this.menu.querySelectorAll('.dropdown-item').forEach(btn => {
				btn.addEventListener('mousedown', (e) => {
					e.preventDefault(); // Prevent blur event from firing first
					const idx = parseInt(btn.getAttribute('data-idx') || '-1', 10);
					this.pick(idx);
				});
			});

			this.setActive(-1);
			this.updateMenuPosition();
			this.show();
		}

		/** Synchronizes the internal list to the JSON input and re-renders chips (tags mode only). */
		sync() {
			// dbg('sync', { listCount: this.list?.length || 0 });
			if (this.mode === 'tags') {
				if (this.jsonInput) this.jsonInput.value = JSON.stringify(this.list);
				if (this.chipsEl) renderChips(this.chipsEl, this.list, this.opts.applyBadge);
			}
		}

		/** Ensures suggestions are loaded (if async) and then renders them. */
		ensureSuggestions() {
			// dbg('ensureSuggestions');
			const getAndRender = () => {
				// dbg('ensureSuggestions.getAndRender');
				const hints = (this.opts.getHints && this.opts.getHints()) || [];
				const arr = defaultFilter(hints, this.inputEl.value || '', this.maxVisible);
				this.renderList(arr);
			};

			if (this.opts.ensureLoaded) {
				// Use Promise.resolve to handle both sync and async functions
				Promise.resolve(this.opts.ensureLoaded())
					.catch(err => console.error("TagTypeahead: ensureLoaded failed", err))
					.finally(getAndRender);
			} else {
				getAndRender();
			}
		}

		/** Adds tags from the input box (tags mode) or just hides (suggest mode). */
		addFromInput() {
			// dbg('addFromInput');
			if (this.mode === 'tags') {
				const raw = (this.inputEl.value || '').trim();
				if (!raw) return;
				const parts = raw.split(',').map(s => clampLen(s.trim(), this.maxNameLen)).filter(Boolean);
				for (const p of parts) {
					if (!this.list.includes(p)) {
						this.list.push(p);
					}
				}
				this.inputEl.value = '';
				this.sync();
				this.hide();
				try {
					this.inputEl.focus();
				} catch (_) { }
			} else { // 'suggest' mode
				// Pressing Enter just accepts the value and hides the dropdown
				this.hide();
			}
		}

		// --- Public API Methods ---

		/** Gets a copy of the current tag list. */
		getList() {
			return this.list.slice();
		}

		/** Sets the tag list to a new array (tags mode only). */
		setList(arr) {
			this.list = dedupe(normalizeInitial(arr, this.maxNameLen));
			this.sync(); // sync() is mode-aware
		}

		/** Focuses the input and shows suggestions. */
		focusToShow() {
			// dbg('focusToShow');
			try { this.inputEl.focus(); } catch(_) {}
			const tryShow = () => {
				// dbg('focusToShow.tryShow', { visible: this._isInputVisible(), active: document.activeElement === this.inputEl });
				if (this._isInputVisible()) { this.ensureSuggestions(); }
				else { requestAnimationFrame(tryShow); }
			};
			requestAnimationFrame(tryShow);
		}

		/** Destroys the widget and cleans up all event listeners. */
		destroy() {
			// dbg('destroy');
			if (this.destroyed) return;
			this.destroyed = true;

			try {
				this.inputEl.removeEventListener('keydown', this._onKeyDown);
				this.inputEl.removeEventListener('input', this._onInput);
				this.inputEl.removeEventListener('focus', this._onFocus);
				this.inputEl.removeEventListener('click', this._onClick);
				this.inputEl.removeEventListener('blur', this._onBlur);
				this.inputEl.removeEventListener('focusout', this._onFocusOut);

				document.removeEventListener('mousedown', this._onDocMouseDown);
				window.removeEventListener('resize', this._onResizeScroll);
				window.removeEventListener('scroll', this._onResizeScroll, true);

				if (this.mode === 'tags') {
					if (this.chipsEl) {
						this.chipsEl.removeEventListener('tag-remove', this._onChipsRemove);
					}
					if (this.addBtn) {
						this.addBtn.removeEventListener('click', this._onAddBtnClick);
					}
				}

				if (this.menu && this.menu.parentElement) {
					this.menu.parentElement.removeChild(this.menu);
				}
				this.menu = null;

			} catch (_) { }

			if (this.mode === 'tags' && this.jsonInput && this.jsonInput._tagWidgetInstance) {
				delete this.jsonInput._tagWidgetInstance;
			}
		}
	}


	// --- Public Factory ---

	/**
	 * Creates or updates a TagTypeahead widget.
	 * @param {object} opts - Configuration options.
	 * @param {string} [opts.mode='tags'] - 'tags' (chips) or 'suggest' (autocomplete).
	 * @param {HTMLInputElement} opts.inputEl - The text input element.
	 * @param {HTMLElement} [opts.chipsEl] - The container to render tag chips in (required for 'tags' mode).
	 * @param {HTMLInputElement} [opts.jsonInput] - The hidden input to store the JSON array (required for 'tags' mode).
	 * @param {HTMLButtonElement} [opts.addBtn] - Optional button to trigger adding from input (tags mode only).
	 * @param {function(): Promise<void>} [opts.ensureLoaded] - Async function to call before getting hints.
	 * @param {function(): string[]} [opts.getHints] - Function that returns an array of hint strings.
	 * @param {function(HTMLElement, string)} [opts.applyBadge] - Function to customize chip appearance (tags mode only).
	 * @param {string|string[]} [opts.initial] - Initial value (JSON string, CSV string, or array) (tags mode only).
	 * @param {number} [opts.maxVisible=8] - Max suggestions to show.
	 * @param {number} [opts.maxNameLength=64] - Max length of a single tag.
	 * @param {number} [opts.zIndex=1061] - z-index for the dropdown.
	 * @returns {TagWidget} The widget instance.
	 */
	function create(opts) {
		const {
			inputEl,
			chipsEl,
			jsonInput
		} = opts;
		const mode = opts.mode === 'suggest' ? 'suggest' : 'tags';

		// Mode-specific validation
		if (mode === 'tags') {
			if (!inputEl || !chipsEl || !jsonInput) {
				throw new Error('TagTypeahead: missing required elements for "tags" mode (inputEl, chipsEl, jsonInput)');
			}
		} else { // 'suggest' mode
			if (!inputEl) {
				throw new Error('TagTypeahead: inputEl required for "suggest" mode');
			}
		}

		// Check for existing instance (only in 'tags' mode)
		if (mode === 'tags' && jsonInput && jsonInput._tagWidgetInstance) {
			const inst = jsonInput._tagWidgetInstance;
			// If it exists, just update its list
			inst.setList(normalizeInitial(opts.initial || [], opts.maxNameLength || 64));
			return inst;
		}

		// Create a new instance
		const instance = new TagWidget(opts);
		if (mode === 'tags' && jsonInput) {
			jsonInput._tagWidgetInstance = instance;
		}
		return instance;
	}

	// Expose the create function to the window
	window.TagTypeahead = {
		create
	};

})();
