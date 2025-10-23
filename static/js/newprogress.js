/* new-progress Web Component
   Usage: <new-progress value="42" size="sm|md|lg" height="20" label="42%" show-label="true|false"></new-progress>
   - Always centers label over full bar; fill is color only.
   - Accessible with role=progressbar and aria-* attributes.
   - Uses Light DOM with existing goal-progress.css styles.
*/
(function(){
  if (window.customElements && !customElements.get('new-progress')) {
    class NewProgress extends HTMLElement {
      static get observedAttributes() { return ['value','size','height','label','show-label']; }
      constructor(){ super(); }
      connectedCallback(){ this.render(); }
      attributeChangedCallback(){ this.render(); }

      getValue(){
        const v = Number(this.getAttribute('value'));
        if (!Number.isFinite(v)) return 0;
        return Math.max(0, Math.min(100, v));
      }

      getSizeClass(){
        const size = (this.getAttribute('size') || '').toLowerCase();
        if (size === 'sm') return 'goal-progress--sm';
        if (size === 'lg') return 'goal-progress--lg';
        return '';
      }

      getHeight(){
        const hAttr = this.getAttribute('height');
        const h = Number(hAttr);
        return Number.isFinite(h) && h > 0 ? h : null;
      }

      wantsLabel(){
        const sl = this.getAttribute('show-label');
        if (sl == null) return true; // default true
        return String(sl).toLowerCase() !== 'false' && String(sl) !== '0';
      }

      computeLabelText(val){
        const custom = this.getAttribute('label');
        if (custom != null) return custom;
        // format value: keep up to 2 decimals, trim trailing zeros
        const s = (Math.round(val * 100) / 100).toFixed(2);
        return s.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1') + '%';
      }

      render(){
        try {
          const val = this.getValue();
          const sizeClass = this.getSizeClass();
          const height = this.getHeight();
          const showLabel = this.wantsLabel();

          // Clear previous content
          this.textContent = '';

          const container = document.createElement('div');
          container.className = 'new-progress' + (sizeClass ? (' ' + sizeClass) : '');
          container.setAttribute('aria-label', 'Progress');
          if (height) container.style.height = height + 'px';

          const fill = document.createElement('div');
          fill.className = 'new-progress__fill';
          fill.setAttribute('role', 'progressbar');
          fill.setAttribute('aria-valuemin', '0');
          fill.setAttribute('aria-valuemax', '100');
          fill.setAttribute('aria-valuenow', String(Math.round(val)));
          fill.style.width = val + '%';

          container.appendChild(fill);

          if (showLabel) {
            const label = document.createElement('div');
            label.className = 'new-progress__label';
            label.textContent = this.computeLabelText(val);
            container.appendChild(label);
          }

          this.appendChild(container);
        } catch (e) {
          // Fail silent to keep layout resilient
        }
      }
    }
    customElements.define('new-progress', NewProgress);
  }
})();
