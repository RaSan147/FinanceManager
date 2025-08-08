class TagManager {
    static init() {
        this.tags = new Set();
        this.setupTagInput();
    }

    static setupTagInput() {
        const input = document.getElementById('tags');
        const tagList = document.getElementById('tag-list');

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const tag = input.value.trim();
                if (tag) this.addTag(tag);
                input.value = '';
            }
        });

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

        this.tags.forEach(tag => {
            const element = document.createElement('span');
            element.className = 'badge bg-primary me-1 mb-1';
            element.innerHTML = `
                ${tag}
                <button type="button" class="btn-close btn-close-white ms-1" 
                        aria-label="Remove"></button>
            `;
            
            element.querySelector('button').addEventListener('click', () => {
                this.removeTag(tag);
            });
            
            tagList.appendChild(element);
        });
    }

    static getTags() {
        return Array.from(this.tags);
    }
}

document.addEventListener('DOMContentLoaded', () => TagManager.init());