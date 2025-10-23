/* Progress overlay helper
   Inserts a centered overlay element inside each .progress container showing the
   percentage from the inner .progress-bar's aria-valuenow. This avoids relying on
   pseudo-elements and preserves the original markup. Runs on DOMContentLoaded and
   exposes refreshProgressOverlays() for dynamic updates. */
(function(){
  if (window.__progressOverlayLoaded) return; window.__progressOverlayLoaded = true;

  function refreshProgressOverlays() {
    // Scope to new-progress components only to avoid interfering with other progress bars
    document.querySelectorAll('.new-progress').forEach(p => {
      const bar = p.querySelector('.new-progress__fill');
      if (!bar) return;

      // determine percentage: prefer aria-valuenow, fallback to style.width
      let pct = bar.getAttribute('aria-valuenow');
      if (pct === null || pct === undefined || pct === '') {
        const w = bar.style.width || '';
        pct = parseFloat(w.replace('%','')) || 0;
      } else {
        pct = Number(pct);
      }

      // ensure overlay exists
      let overlay = p.querySelector('.new-progress__label');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'new-progress__label';
        p.appendChild(overlay);
      }

      // set overlay text; keep one decimal for non-integers
      overlay.textContent = (isNaN(pct) ? '—' : (Math.round(pct*100)/100) + '%');

      // keep the inner progress-bar text empty to avoid duplication visually,
      // but preserve original text in data attribute for debugging/accessibility
  if (!bar.dataset.originalText) bar.dataset.originalText = bar.textContent || '';
  bar.textContent = '';

      // Ensure aria-label is present for screen readers
      bar.setAttribute('aria-label', overlay.textContent);
    });
  }

  // run on DOM ready
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refreshProgressOverlays); else refreshProgressOverlays();

  // expose globally for dynamic updates
  window.refreshProgressOverlays = refreshProgressOverlays;
})();
