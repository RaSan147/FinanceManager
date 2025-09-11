// Unified client-side image handling (comments & inline markdown insertion)
// Lightweight module (no dependencies besides App.utils.fetchJSONUnified & optional window.flash)
// Exposes global: window.ImageUploader
(() => {
  if (window.ImageUploader) return; // singleton

	/**
	 * Generate ImageKit thumbnail URL
	 * - Uses official ML thumbnail if available
	 * - Otherwise applies resize fallback
	 */
	function thumbTransform(url, w = 280, h = 280, useOfficial = true) {
	try {
		if (!url) return url;
		if (/imagekit\.io\//.test(url) && !/\/tr:/.test(url)) {
		const parts = url.split('/');
		const idx = parts.findIndex(p => p.includes('imagekit.io'));
		if (idx !== -1) {
			const domain = parts.slice(0, idx + 1).join('/'); // https://ik.imagekit.io
			const imagekitId = parts[idx + 1];               // pagtrz1ia
			const filePath = parts.slice(idx + 2).join('/'); // upload_XXXXX
			const transform = useOfficial
			? 'tr:n-ik_ml_thumbnail'
			: `tr:w-${w},h-${h},fo-auto`;
			return `${domain}/${imagekitId}/${transform}/${filePath}`;
		}
		}
	} catch (_) {}
	return url;
	}


  // Generic uploader for a comment form with preview thumbnails.
  // opts: { formEl, uploadEndpoint, selectors:{ fileInput, triggerBtn, clearBtn, previewWrap }, pasteScopeEl }
  function attachCommentUploader(opts) {
    const { formEl, uploadEndpoint, selectors = {}, pasteScopeEl } = opts;
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
        previewWrap.innerHTML = '';
        clearBtn && clearBtn.classList.add('d-none');
        return;
      }
      previewWrap.innerHTML = pending.map((u, i) => `
        <div class="position-relative" style="width:90px;height:90px;overflow:hidden;border:1px solid var(--border-color,#ccc);border-radius:4px;">
          <img src="${thumbTransform(u)}" alt="img" style="object-fit:cover;width:100%;height:100%;"/>
          <button type="button" class="btn btn-sm btn-danger position-absolute top-0 end-0 py-0 px-1" data-remove-img="${i}" title="Remove"><i class="bi bi-x"></i></button>
        </div>`).join('');
      clearBtn && clearBtn.classList.remove('d-none');
      previewWrap.querySelectorAll('[data-remove-img]').forEach(btn => btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-remove-img'), 10);
        if (!isNaN(idx)) { pending.splice(idx, 1); render(); }
      }));
    }

    async function uploadDataUrl(dataUrl, origin) {
      try {
        const res = await App.utils.fetchJSONUnified(uploadEndpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl })
        });
        pending.push(res.url);
        render();
        window.flash && window.flash(origin + ' image ready', 'info');
      } catch (_) { window.flash && window.flash(origin + ' image failed', 'danger'); }
    }
    function handleFiles(fileList, origin) {
      Array.from(fileList || []).forEach(f => {
        if (!f.type.startsWith('image/')) return;
        if (f.size > 16 * 1024 * 1024) { window.flash && window.flash('Image too large (16MB max)', 'warning'); return; }
        const reader = new FileReader();
        reader.onload = () => uploadDataUrl(reader.result, origin);
        reader.readAsDataURL(f);
      });
    }
    triggerBtn && triggerBtn.addEventListener('click', e => { e.preventDefault(); fileInput && fileInput.click(); });
    clearBtn && clearBtn.addEventListener('click', e => { e.preventDefault(); pending = []; render(); });
    fileInput && fileInput.addEventListener('change', () => { handleFiles(fileInput.files, 'Selected'); fileInput.value = ''; });
    // Paste support inside modal scope
    const scope = pasteScopeEl || formEl.closest('.modal') || document;
    scope.addEventListener('paste', e => {
      if (scope.classList && !scope.classList.contains('show')) return; // only when modal visible
      const items = e.clipboardData?.items || [];
      const files = [];
      for (const it of items) if (it.type && it.type.startsWith('image/')) { const f = it.getAsFile(); f && files.push(f); }
      if (files.length) { handleFiles(files, 'Pasted'); e.preventDefault(); }
    });

    render();
    const api = {
      getImages: () => [...pending],
      setImages: (arr) => { pending = Array.from(arr || []); render(); },
      reset: () => { pending = []; render(); }
    };
    formEl._imageUploader = api;
    return api;
  }

  // Inline markdown image insertion for a textarea (diary content editing).
  // opts: { textarea, uploadEndpoint, buttonEl? }
  function attachInlineMarkdownUploader(opts) {
    const { textarea, uploadEndpoint, buttonEl } = opts;
    if (!textarea) return;
    // create hidden file input
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    textarea.parentElement.appendChild(fileInput);
    buttonEl && buttonEl.addEventListener('click', e => { e.preventDefault(); fileInput.click(); });

    function insertAtCursor(txt) {
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? textarea.value.length;
      const orig = textarea.value;
      textarea.value = orig.slice(0, start) + txt + orig.slice(end);
      const pos = start + txt.length;
      textarea.selectionStart = textarea.selectionEnd = pos;
    }

    async function uploadDataUrl(dataUrl) {
      const placeholder = '![uploading]()';
      insertAtCursor('\n' + placeholder + '\n');
      try {
        const res = await App.utils.fetchJSONUnified(uploadEndpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: dataUrl })
        });
        textarea.value = textarea.value.replace(placeholder, `![img](${res.url})`);
      } catch (_) {
        textarea.value = textarea.value.replace(placeholder, '(image upload failed)');
        window.flash && window.flash('Image upload failed', 'danger');
      }
    }

    function handleFiles(fileList) {
      Array.from(fileList || []).forEach(f => {
        if (!f.type.startsWith('image/')) return;
        if (f.size > 16 * 1024 * 1024) { window.flash && window.flash('Image too large (16MB max)', 'warning'); return; }
        const reader = new FileReader();
        reader.onload = () => uploadDataUrl(reader.result);
        reader.readAsDataURL(f);
      });
    }

    fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value=''; });
    textarea.addEventListener('paste', e => {
      const items = e.clipboardData?.items || [];
      const files = [];
      for (const it of items) if (it.type && it.type.startsWith('image/')) { const f = it.getAsFile(); f && files.push(f); }
      if (files.length) { handleFiles(files); e.preventDefault(); }
    });
  }

  // Expose helper so other modules (todos/diary) can reuse consistent logic
  window.ImageUploader = { thumbTransform, attachCommentUploader, attachInlineMarkdownUploader };
})();
