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
    let group = el.getAttribute('data-viewer-group');
    if (group) {
      const nodes = [...document.querySelectorAll(`[data-viewer-group="${CSS.escape(group)}"]`)];
      if (nodes.length) return nodes.filter(n => n.tagName === 'IMG' || n.hasAttribute('data-viewer-src'));
    }
    // Fallback: siblings in same container
    const parent = el.closest('[data-markdown-container],[data-todo-comments],[data-diary-comments]') || el.parentElement;
    if (!parent) return [el];
    const imgs = [...parent.querySelectorAll('img[data-viewer-thumb]')];
    return imgs.length ? imgs : [el];
  }

  function buildBackdrop(){
    const wrap = document.createElement('div');
    wrap.className = 'fm-image-viewer-backdrop';
    wrap.innerHTML = `\n      <div class="fm-image-viewer-stage" role="dialog" aria-modal="true">\n        <button class="fm-image-viewer-close" type="button" aria-label="Close (Esc)">✕ Close</button>\n        <button class="fm-image-viewer-btn fm-image-viewer-prev fm-image-viewer-nav" type="button" aria-label="Previous image">‹</button>\n        <div class='fm-image-viewer-canvas'>\n          <img alt="" draggable="false"/>\n        </div>\n        <div class='fm-image-viewer-tools'>\n          <button type='button' class='fm-image-viewer-tool-btn' data-iv-zoom-out title='Zoom Out (-)'>−</button>\n          <button type='button' class='fm-image-viewer-tool-btn' data-iv-zoom-reset title='Reset (R)'>100%</button>\n            <button type='button' class='fm-image-viewer-tool-btn' data-iv-zoom-in title='Zoom In (+)'>+</button>\n        </div>\n        <button class="fm-image-viewer-btn fm-image-viewer-next fm-image-viewer-nav" type="button" aria-label="Next image">›</button>\n      </div>`;
    document.body.appendChild(wrap);
    return wrap;
  }

  const backdrop = buildBackdrop();
  const stageImg = backdrop.querySelector('img');
  const canvas = backdrop.querySelector('.fm-image-viewer-canvas');
  const btnClose = backdrop.querySelector('.fm-image-viewer-close');
  const btnPrev = backdrop.querySelector('.fm-image-viewer-prev');
  const btnNext = backdrop.querySelector('.fm-image-viewer-next');
  const btnZoomIn = backdrop.querySelector('[data-iv-zoom-in]');
  const btnZoomOut = backdrop.querySelector('[data-iv-zoom-out]');
  const btnZoomReset = backdrop.querySelector('[data-iv-zoom-reset]');
  let currentList = []; let currentIndex = -1; let lastActive = null;
  let scale = 1, tx = 0, ty = 0; const MIN_SCALE = 0.2, MAX_SCALE = 8;

  function applyTransform(){
    stageImg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    btnZoomReset && (btnZoomReset.textContent = Math.round(scale*100)+'%');
  }

  function resetTransform(){ scale = 1; tx = 0; ty = 0; applyTransform(); }

  function show(idx){
    if (!currentList.length) return close();
    if (idx < 0) idx = currentList.length - 1;
    if (idx >= currentList.length) idx = 0;
    currentIndex = idx;
    const node = currentList[currentIndex];
    const src = node.getAttribute('data-viewer-src') || node.getAttribute('src');
    if (!src){ close(); return; }
    stageImg.src = src;
    resetTransform();
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

  // Zoom controls
  function zoom(delta){
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * (delta > 0 ? 1.25 : 0.8)));
    scale = newScale; applyTransform();
  }
  btnZoomIn && btnZoomIn.addEventListener('click', () => zoom(1));
  btnZoomOut && btnZoomOut.addEventListener('click', () => zoom(-1));
  btnZoomReset && btnZoomReset.addEventListener('click', () => resetTransform());

  // Wheel zoom
  canvas && canvas.addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1 : -1); }, { passive:false });

  // Drag to pan
  let drag = false, lx=0, ly=0;
  canvas && canvas.addEventListener('mousedown', e => {
    if (e.button !== 0) return; drag = true; lx = e.clientX; ly = e.clientY; canvas.classList.add('dragging');
  });
  window.addEventListener('mousemove', e => { if(!drag) return; const dx=e.clientX-lx, dy=e.clientY-ly; lx=e.clientX; ly=e.clientY; tx+=dx; ty+=dy; applyTransform(); });
  window.addEventListener('mouseup', () => { if(drag){ drag=false; canvas.classList.remove('dragging'); } });

  // Double click toggle 1x / 2x
  canvas && canvas.addEventListener('dblclick', () => { scale = (scale>1.01)?1:2; tx=ty=0; applyTransform(); });

  document.addEventListener('keydown', e => {
    if (!backdrop.classList.contains('active')) return;
    if (KEY_CLOSE.includes(e.key)) { close(); return; }
  if (KEY_NEXT.includes(e.key)) { show(currentIndex + 1); e.preventDefault(); }
  else if (KEY_PREV.includes(e.key)) { show(currentIndex - 1); e.preventDefault(); }
  else if (e.key === '+' || e.key === '=' ) { zoom(1); e.preventDefault(); }
  else if (e.key === '-' || e.key === '_') { zoom(-1); e.preventDefault(); }
  else if (e.key.toLowerCase() === 'r') { resetTransform(); }
  });

  // Public helper (optional)
  window.ImageViewer = { openFrom };

  // Delegate clicks
  document.addEventListener('click', e => {
    const img = e.target.closest('img[data-viewer-thumb], [data-viewer-open]');
    if (!img) return; // silent ignore for all other clicks
    e.preventDefault();
    openFrom(img);
  });
})();
