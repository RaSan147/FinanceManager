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
  let baseW = 0, baseH = 0; // displayed image size at scale=1

  function applyTransform(){
    // clamp translation so image cannot be dragged completely out of view
    if (baseW > 0 && baseH > 0 && canvas) {
      const scaledW = baseW * scale;
      const scaledH = baseH * scale;
      const maxTx = Math.max(0, (scaledW - canvas.clientWidth) / 2);
      const maxTy = Math.max(0, (scaledH - canvas.clientHeight) / 2);
      tx = Math.min(maxTx, Math.max(-maxTx, tx));
      ty = Math.min(maxTy, Math.max(-maxTy, ty));
    }
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
    // measure displayed image size after load to compute panning limits
    baseW = 0; baseH = 0;
    stageImg.onload = function(){
      baseW = stageImg.clientWidth || stageImg.naturalWidth || canvas.clientWidth;
      baseH = stageImg.clientHeight || stageImg.naturalHeight || canvas.clientHeight;
      resetTransform();
      applyTransform();
    };
    stageImg.src = src;
    backdrop.classList.add('active');
    document.body.style.overflow = 'hidden';
  }
  function close(){
    // Clear modal active state
    backdrop.classList.remove('active');
    document.body.style.overflow = '';

    // Reset interaction flags
    drag = false; touchDrag = false;
    if (canvas) canvas.classList.remove('dragging');

    // Reset transform and image state so nothing remains draggable/visible
    tx = 0; ty = 0; scale = 1; baseW = 0; baseH = 0;
    try {
      if (stageImg) {
        stageImg.style.transform = '';
        stageImg.removeAttribute('src');
        stageImg.onload = null;
      }
    } catch (e) { /* ignore */ }

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
  canvas.addEventListener('wheel', e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1 : -1); }, { passive:false });

  // Drag to pan
  let drag = false, lx=0, ly=0;
  canvas.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    // ignore drags that start on viewer controls (prev/next/close/tools)
    if (e.target && e.target.closest && e.target.closest('.fm-image-viewer-tool-btn, .fm-image-viewer-btn, .fm-image-viewer-close')) return;
    drag = true; lx = e.clientX; ly = e.clientY; canvas.classList.add('dragging');
  });
  window.addEventListener('mousemove', e => { if(!drag) return; const dx=e.clientX-lx, dy=e.clientY-ly; lx=e.clientX; ly=e.clientY; tx+=dx; ty+=dy; applyTransform(); });
  // Ensure mouseup and pointerup always clear drag state to avoid stuck drag
  window.addEventListener('mouseup', () => { drag = false; touchDrag = false; canvas.classList.remove('dragging'); });
  window.addEventListener('pointerup', () => { drag = false; touchDrag = false; canvas.classList.remove('dragging'); });

  // Touch support: drag / swipe / pinch / double-tap
  let touchDrag = false, touchLx = 0, touchLy = 0;
  let pinchStartDist = 0, pinchStartScale = 1, lastTouchCount = 0;
  let lastTap = 0;

  function touchDistance(t0, t1){
    const dx = t0.clientX - t1.clientX;
    const dy = t0.clientY - t1.clientY;
    return Math.sqrt(dx*dx + dy*dy);
  }

  canvas.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      // single touch -> potential drag or double-tap
      const t = e.touches[0];
      const now = Date.now();
      if (now - lastTap < 300) {
        // double-tap -> toggle zoom
        scale = (scale > 1.01) ? 1 : Math.min(MAX_SCALE, 2);
        tx = 0; ty = 0; applyTransform();
        e.preventDefault();
        lastTap = 0;
        return;
      }
      lastTap = now;
      touchDrag = true; touchLx = t.clientX; touchLy = t.clientY; canvas.classList.add('dragging');
    } else if (e.touches.length === 2) {
      // pinch start
      pinchStartDist = touchDistance(e.touches[0], e.touches[1]);
      pinchStartScale = scale;
      lastTouchCount = 2;
      e.preventDefault();
    }
  }, { passive:false });

  canvas.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && lastTouchCount === 2) {
      const dist = touchDistance(e.touches[0], e.touches[1]);
      const factor = dist / (pinchStartDist || dist);
      scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchStartScale * factor));
      applyTransform();
      e.preventDefault();
      return;
    }
    if (!touchDrag) return;
    const t = e.touches[0];
    const dx = t.clientX - touchLx, dy = t.clientY - touchLy;
    touchLx = t.clientX; touchLy = t.clientY;
    // if image is zoomed, pan. otherwise treat as swipe on end
    if (scale > 1.01) {
      tx += dx; ty += dy; applyTransform();
      e.preventDefault();
    }
  }, { passive:false });

  canvas.addEventListener('touchend', e => {
    canvas.classList.remove('dragging');
    if (lastTouchCount === 2 && (e.touches.length < 2)) {
      // pinch ended
      lastTouchCount = 0;
      pinchStartDist = 0;
      pinchStartScale = scale;
      return;
    }
    if (!touchDrag) return;
    // if quick horizontal swipe and image not zoomed -> navigate
    // find velocity using changedTouches if present
    const ct = e.changedTouches && e.changedTouches[0];
    if (ct && Math.abs(ct.clientX - touchLx) > 60 && scale <= 1.01) {
      const dx = ct.clientX - touchLx;
      if (dx < 0) show(currentIndex + 1); else show(currentIndex - 1);
    }
    touchDrag = false;
  });

  // Prevent native dragstart which interferes with our mouse handling
  stageImg.addEventListener('dragstart', e => e.preventDefault());

  // Double click toggle 1x / 2x
  canvas.addEventListener('dblclick', () => { scale = (scale>1.01)?1:2; tx=ty=0; applyTransform(); });

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
