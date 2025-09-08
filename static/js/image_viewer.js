/* Image Viewer Component
 * Lightweight gallery modal with keyboard navigation.
 * Usage: attach data-viewer-group="<groupId>" and data-viewer-src (optional if element is <img src>).
 * For todo comments we add the attribute data-viewer-thumb on <img> tags.
 */
(() => {
  if (window.__imageViewerLoaded) return; window.__imageViewerLoaded = true;

  const KEY_NEXT = ['ArrowRight','ArrowDown','PageDown',' '];
  const KEY_PREV = ['ArrowLeft','ArrowUp','PageUp'];
  const KEY_CLOSE = ['Escape'];

  function collectGroup(el){
    const group = el.getAttribute('data-viewer-group') || 'default';
    const nodes = [...document.querySelectorAll(`[data-viewer-group="${CSS.escape(group)}"]`)];
    return nodes.filter(n => n.tagName === 'IMG' || n.hasAttribute('data-viewer-src'));
  }

  function buildBackdrop(){
    const wrap = document.createElement('div');
    wrap.className = 'fm-image-viewer-backdrop';
    wrap.innerHTML = `\n      <div class="fm-image-viewer-stage" role="dialog" aria-modal="true">\n        <button class="fm-image-viewer-close" type="button" aria-label="Close (Esc)">✕ Close</button>\n        <button class="fm-image-viewer-btn fm-image-viewer-prev fm-image-viewer-nav" type="button" aria-label="Previous image">‹</button>\n        <img alt="" draggable="false"/>\n        <button class="fm-image-viewer-btn fm-image-viewer-next fm-image-viewer-nav" type="button" aria-label="Next image">›</button>\n      </div>`;
    document.body.appendChild(wrap);
    return wrap;
  }

  const backdrop = buildBackdrop();
  const stageImg = backdrop.querySelector('img');
  const btnClose = backdrop.querySelector('.fm-image-viewer-close');
  const btnPrev = backdrop.querySelector('.fm-image-viewer-prev');
  const btnNext = backdrop.querySelector('.fm-image-viewer-next');
  let currentList = []; let currentIndex = -1; let lastActive = null;

  function show(idx){
    if (!currentList.length) return close();
    if (idx < 0) idx = currentList.length - 1;
    if (idx >= currentList.length) idx = 0;
    currentIndex = idx;
    const node = currentList[currentIndex];
    const src = node.getAttribute('data-viewer-src') || node.getAttribute('src');
    if (!src){ close(); return; }
    stageImg.src = src;
    backdrop.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
  function close(){
    backdrop.classList.remove('active');
    document.body.style.overflow = '';
    currentList = []; currentIndex = -1;
    if (lastActive) { try { lastActive.focus(); } catch(_){} }
  }
  function openFrom(node){
    lastActive = document.activeElement;
    currentList = collectGroup(node);
    const idx = currentList.indexOf(node);
    show(idx < 0 ? 0 : idx);
  }
  btnClose.addEventListener('click', close);
  btnPrev.addEventListener('click', () => show(currentIndex - 1));
  btnNext.addEventListener('click', () => show(currentIndex + 1));
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });

  document.addEventListener('keydown', e => {
    if (!backdrop.classList.contains('active')) return;
    if (KEY_CLOSE.includes(e.key)) { close(); return; }
    if (KEY_NEXT.includes(e.key)) { show(currentIndex + 1); e.preventDefault(); }
    else if (KEY_PREV.includes(e.key)) { show(currentIndex - 1); e.preventDefault(); }
  });

  // Public helper (optional)
  window.ImageViewer = { openFrom };

  // Delegate clicks
  document.addEventListener('click', e => {
    const img = e.target.closest('img[data-viewer-thumb], [data-viewer-open]');
    if (!img) return;
    e.preventDefault();
    openFrom(img);
  });
})();
