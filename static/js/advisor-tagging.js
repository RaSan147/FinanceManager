/**
 * TagManager
 * Lightweight manager for a simple tag input + tag list UI.
 *
 * Usage:
 * - Input element with id="tags"
 * - Container element with id="tag-list"
 *
 * Public API (static methods):
 * - init()       : initialize DOM references and event handlers
 * - getTags()    : return current tags as an array of strings
 */
class TagManager {
    /**
     * Initialize internal state and cache important DOM nodes.
     * Safe to call multiple times; will noop if required elements are missing.
     */
    static init() {
        this.tags = new Set();
        this.input = document.getElementById('tags');
        this.tagList = document.getElementById('tag-list');

        if (!this.input || !this.tagList) {
            // Required elements not present on the page — nothing to do.
            return;
        }

        this.setupTagInput();
        this.renderTags();
    }

    /**
     * Wire up keyboard and paste/blur handlers for the input.
     * - Enter or comma adds the current value as a tag
     * - Backspace when input is empty removes the last tag (small UX nicety)
     * - Paste splits comma-separated values and adds them as tags
     */
    static setupTagInput() {
        const input = this.input;

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const tag = input.value.trim();
                if (tag) this.addTag(tag);
                input.value = '';
            } else if (e.key === 'Backspace' && input.value === '') {
                // Remove the most-recently-added tag when hitting backspace on empty input
                const last = Array.from(this.tags).pop();
                if (last) this.removeTag(last);
            }
        });

        input.addEventListener('blur', () => {
            const tag = input.value.trim();
            if (tag) this.addTag(tag);
            input.value = '';
        });

        input.addEventListener('paste', (e) => {
            const paste = (e.clipboardData || window.clipboardData).getData('text');
            if (!paste) return;
            // If user pastes comma-separated tags, split and add them all
            if (paste.includes(',')) {
                e.preventDefault();
                paste.split(',').map(t => t.trim()).filter(Boolean).forEach(t => this.addTag(t));
                input.value = '';
            }
        });
    }

    /**
     * Add a tag (no-ops for empty or duplicate values). Tags are trimmed and capped.
     * @param {string} tag
     */
    static addTag(tag) {
        tag = String(tag || '').trim();
        if (!tag) return;

        // Optional: enforce a reasonable maximum tag length
        const MAX_LEN = 50;
        if (tag.length > MAX_LEN) tag = tag.slice(0, MAX_LEN);

        if (this.tags.has(tag)) return; // avoid duplicates

        this.tags.add(tag);
        this.renderTags();
    }

    /** Remove a tag and refresh the UI. */
    static removeTag(tag) {
        this.tags.delete(tag);
        this.renderTags();
    }

    /**
     * Rebuild the tag-list DOM. Keeps markup simple and accessible.
     */
    static renderTags() {
    const tagList = this.tagList;
    App.utils.tools.del_child(tagList);

        this.tags.forEach(tag => {
            const el = document.createElement('span');
            el.className = 'badge bg-primary me-1 mb-1 d-inline-flex align-items-center';
            el.textContent = tag;

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn chip-close chip-close-light ms-1';
            btn.setAttribute('aria-label', `Remove ${tag}`);
            btn.innerHTML = "<i class='fa-solid fa-xmark' aria-hidden='true'></i>";
            btn.addEventListener('click', () => this.removeTag(tag));

            el.appendChild(btn);
            tagList.appendChild(el);
        });
    }

    /** Return the current tags as an array (stable order: insertion order). */
    static getTags() {
        return Array.from(this.tags);
    }
}

// Make available to other scripts and initialize on DOM ready.
window.TagManager = TagManager;
document.addEventListener('DOMContentLoaded', () => TagManager.init());