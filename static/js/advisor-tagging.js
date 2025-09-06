class TagManager {
    static init() {
        this.tags = new Set();
        this.setupTagInput();
    }

    static setupTagInput() {
        const input = document.getElementById('tags');
        const tagList = document.getElementById('tag-list');

        // Add tag on Enter or comma key press
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const tag = input.value.trim();
                if (tag) this.addTag(tag);
                input.value = '';
            }
        });

        // Add tag on input blur
        input.addEventListener('blur', () => {
            const tag = input.value.trim();
            if (tag) this.addTag(tag);
            input.value = '';
        });
    }

    static addTag(tag) {
        if (this.tags.has(tag)) return;

        this.tags.add(tag);
        this.renderTags();
    }

    static removeTag(tag) {
        this.tags.delete(tag);
        this.renderTags();
    }

    static renderTags() {
        const tagList = document.getElementById('tag-list');
        tagList.innerHTML = '';

        // Render each tag as a badge with a remove button
        this.tags.forEach(tag => {
            const element = document.createElement('span');
            element.className = 'badge bg-primary me-1 mb-1 d-inline-flex align-items-center';
            element.appendChild(document.createTextNode(tag));

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-close btn-close-white ms-1';
            btn.setAttribute('aria-label', 'Remove');
            btn.addEventListener('click', () => this.removeTag(tag));

            element.appendChild(btn);
            tagList.appendChild(element);
        });
    }

    static getTags() {
        return Array.from(this.tags);
    }
}

// Expose for other modules (e.g., PurchaseAdvisor)
window.TagManager = TagManager;
document.addEventListener('DOMContentLoaded', () => TagManager.init());