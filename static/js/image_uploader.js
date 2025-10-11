/*
 * Lightweight image helper used for two tasks:
 *  - comment form uploads with thumbnail previews
 *  - inline markdown image insertion for textareas
 *
 * Depends on: App.utils.fetchJSONUnified (returns an object with `url`).
 * Optional: window.flash(message, level) for user notifications.
 */
(function () {
  if (window.ImageUploader) return; // already installed

  // Small safe wrapper for optional flash notifications.
  function safeFlash(message, level) {
    if (typeof window.flash === 'function') window.flash(message, level);
  }

  /**
   * Convert an ImageKit-hosted image URL into a thumbnail URL.
   * If the URL already contains a transform segment (/tr:) it is returned unchanged.
   * @param {string} url
   * @param {number} w width fallback
   * @param {number} h height fallback
   * @param {boolean} useOfficial prefer the official ML thumbnail transform
   * @returns {string}
   */
  function thumbTransform(url, w = 280, h = 280, useOfficial = true) {
    try {
      if (!url) return url;
      if (!/imagekit\.io\//.test(url) || /\/tr:/.test(url)) return url;
      const parts = url.split('/');
      const idx = parts.findIndex(p => p.includes('imagekit.io'));
      if (idx === -1 || parts.length <= idx + 2) return url;
      const domain = parts.slice(0, idx + 1).join('/'); // e.g. https://ik.imagekit.io
      const imagekitId = parts[idx + 1];
      const filePath = parts.slice(idx + 2).join('/');
      const transform = useOfficial ? 'tr:n-ik_ml_thumbnail' : `tr:w-${w},h-${h},fo-auto`;
      return `${domain}/${imagekitId}/${transform}/${filePath}`;
    } catch (err) {
      return url;
    }
  }

  /**
   * Comment uploader with thumbnail preview area.
   * opts: { formEl, uploadEndpoint, selectors: { fileInput, triggerBtn, clearBtn, previewWrap }, pasteScopeEl }
   * Returns an API object: { getImages(), setImages(arr), reset() }
   */
  function attachCommentUploader(opts) {
    const { formEl, uploadEndpoint, selectors = {}, pasteScopeEl } = opts || {};
    if (!formEl || !uploadEndpoint) return null;

    const fileInput = formEl.querySelector(selectors.fileInput || '[data-comment-image]');
    const triggerBtn = formEl.querySelector(selectors.triggerBtn || '[data-comment-image-trigger]');
    const clearBtn = formEl.querySelector(selectors.clearBtn || '[data-comment-images-clear]');
    const previewWrap = formEl.querySelector(selectors.previewWrap || '[data-comment-images-preview]');

    if (fileInput) fileInput.style.display = 'none';

    let pending = [];

    function render() {
      if (!previewWrap) return;
      if (!pending.length) {
        App.utils.tools.del_child(previewWrap);
        if (clearBtn) clearBtn.classList.add('d-none');
        return;
      }
      previewWrap.innerHTML = pending
        .map((u, i) => `
        <div class="position-relative" style="width:90px;height:90px;overflow:hidden;border:1px solid var(--border-color,#ccc);border-radius:4px;">
          <img src="${thumbTransform(u)}" alt="img" style="object-fit:cover;width:100%;height:100%;"/>
          <button type="button" class="btn btn-sm btn-danger position-absolute top-0 end-0 py-0 px-1" data-remove-img="${i}" title="Remove"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </div>`)
        .join('');

      if (clearBtn) clearBtn.classList.remove('d-none');

      previewWrap.querySelectorAll('[data-remove-img]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.getAttribute('data-remove-img'), 10);
          if (!Number.isNaN(idx)) { pending.splice(idx, 1); render(); }
        });
      });
    }

    async function uploadDataUrl(dataUrl, origin) {
      try {
        const res = await App.utils.fetchJSONUnified(uploadEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl })
        });
        pending.push(res.url);
        render();
        safeFlash(origin + ' image ready', 'info');
      } catch (err) {
        safeFlash(origin + ' image failed', 'danger');
      }
    }

    function handleFiles(fileList, origin) {
      Array.from(fileList || []).forEach(f => {
        if (!f || !f.type || !f.type.startsWith('image/')) return;
        if (f.size > 16 * 1024 * 1024) { safeFlash('Image too large (16MB max)', 'warning'); return; }
        const reader = new FileReader();
        reader.onload = () => uploadDataUrl(reader.result, origin);
        reader.readAsDataURL(f);
      });
    }

  triggerBtn.addEventListener('click', e => { e.preventDefault(); fileInput.click(); });
  clearBtn.addEventListener('click', e => { e.preventDefault(); pending = []; render(); });
  fileInput.addEventListener('change', () => { handleFiles(fileInput.files, 'Selected'); fileInput.value = ''; });

    // Paste support: prefer a provided scope (modal) or document
    const scope = pasteScopeEl || formEl.closest('.modal') || document;
    scope.addEventListener('paste', e => {
      // If scope is a modal element, only act when it appears visible
      if (scope.classList && !scope.classList.contains('show')) return;
      const items = e.clipboardData && e.clipboardData.items ? e.clipboardData.items : [];
      const files = [];
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) {
          const f = it.getAsFile(); if (f) files.push(f);
        }
      }
      if (files.length) { handleFiles(files, 'Pasted'); e.preventDefault(); }
    });

    render();

    const api = {
      getImages: () => pending.slice(),
      setImages: (arr) => { pending = Array.from(arr || []); render(); },
      reset: () => { pending = []; render(); }
    };

    formEl._imageUploader = api;
    return api;
  }

  /**
   * Attach an inline markdown image uploader to a textarea.
   * opts: { textarea, uploadEndpoint, buttonEl }
   */
  function attachInlineMarkdownUploader(opts) {
    const { textarea, uploadEndpoint, buttonEl } = opts || {};
    if (!textarea || !uploadEndpoint) return;

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    textarea.parentElement && textarea.parentElement.appendChild(fileInput);
    if (buttonEl) buttonEl.addEventListener('click', e => { e.preventDefault(); fileInput.click(); });

    function insertAtCursor(txt) {
      const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
      const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : textarea.value.length;
      const orig = textarea.value || '';
      textarea.value = orig.slice(0, start) + txt + orig.slice(end);
      const pos = start + txt.length;
      try { textarea.selectionStart = textarea.selectionEnd = pos; } catch (_) {}
    }

    async function uploadDataUrl(dataUrl, placeholder) {
      try {
        const res = await App.utils.fetchJSONUnified(uploadEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl })
        });
        textarea.value = textarea.value.replace(placeholder, `![img](${res.url || ''})`);
      } catch (err) {
        textarea.value = textarea.value.replace(placeholder, '(image upload failed)');
        safeFlash('Image upload failed', 'danger');
      }
    }

    function handleFiles(files) {
      Array.from(files || []).forEach(f => {
        if (!f || !f.type || !f.type.startsWith('image/')) return;
        if (f.size > 16 * 1024 * 1024) { safeFlash('Image too large (16MB max)', 'warning'); return; }
        const reader = new FileReader();
        const placeholder = '\n![uploading]()\n';
        insertAtCursor(placeholder);
        reader.onload = () => uploadDataUrl(reader.result, '![' + 'uploading' + ']()');
        reader.readAsDataURL(f);
      });
    }

    fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });
    textarea.addEventListener('paste', e => {
      const items = e.clipboardData && e.clipboardData.items ? e.clipboardData.items : [];
      const files = [];
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) {
          const f = it.getAsFile(); if (f) files.push(f);
        }
      }
      if (files.length) { e.preventDefault(); handleFiles(files); }
    });
  }

  // Public API
  window.ImageUploader = { thumbTransform, attachCommentUploader, attachInlineMarkdownUploader };
}());
