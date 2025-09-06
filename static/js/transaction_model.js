// transaction_model.js - Shared Transaction modeling & rendering utilities
(function(){
  'use strict';

  function normalizeDateInput(val){
    if(!val) return null;
    if(val instanceof Date && !isNaN(val)) return val;
    if(typeof val === 'string') {
      // Try to detect YYYY-MM-DD first
      if(/^\d{4}-\d{2}-\d{2}$/.test(val)) return new Date(val + 'T00:00:00Z');
      // Try full ISO
      const iso = val.replace(/ /,'T');
      const d = new Date(iso);
      if(!isNaN(d)) return d;
    }
    if(typeof val === 'object') {
      // Mongo extended JSON shapes
      if(val.$date) return normalizeDateInput(val.$date);
      if(val.date) return normalizeDateInput(val.date);
      if(val._date) return normalizeDateInput(val._date);
    }
    return null;
  }

  function isoDate(val){
    const d = normalizeDateInput(val);
    return d ? d.toISOString().slice(0,10) : '';
  }

  class TransactionModel {
    constructor(data, helpers, currencySymbol){
      this.data = data || {};
      this.helpers = helpers || {};
      this.currencySymbol = currencySymbol || '';
    }
    id(){ return this.data._id; }
    dateISO(){ return isoDate(this.data.date); }
    amount(){ return Number(this.data.amount || 0); }
    isIncome(){ return (this.data.type === 'income'); }
    amountSign(){ return this.isIncome() ? '+' : '-'; }
    amountClass(){ return this.isIncome() ? 'text-success' : 'text-danger'; }
    description(){ return this.data.description || ''; }
    category(){ return this.data.category || ''; }
    type(){ return this.data.type || ''; }
    categoryLabel(){
      const type = this.type();
      const code = this.category();
      try {
        if (typeof window.getTxCategoryLabel === 'function') return window.getTxCategoryLabel(type, code);
        const lang = window.txCategoryLang || 'en';
        const labels = window.txCategoryLabels?.[type]?.[code];
        if (labels && (labels[lang] || labels.en)) return labels[lang] || labels.en;
      } catch(_){ /* ignore */ }
      return code;
    }

    toEditPayload(){
      return {
        _id: this.data._id,
        amount_original: this.data.amount_original || this.data.amount,
        currency: this.data.currency,
        type: this.data.type,
        category: this.data.category,
        description: this.data.description,
        date: this.dateISO(),
        related_person: this.data.related_person || ''
      };
    }

    buildRow(context='full'){
      const h = this.helpers;
      const createEl = h.createEl || ((tag, props, text)=>{ const el=document.createElement(tag); if(props){ for(const[k,v] of Object.entries(props)){ if(k==='class') el.className=v; else el.setAttribute(k,v);} } if(text!=null) el.textContent=text; return el; });
  const escapeHtml = h.escapeHtml || (s => (s||'').replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;' }[c])));
  const money = h.money || ((amt,sym)=> (sym||'') + Number(amt||0).toFixed(2));
      const row = createEl('tr');
      const dateDisp = (h.safeDateString ? h.safeDateString(this.data.date,{ month:'short', day:'2-digit', year: context==='recent'?'numeric':'numeric' }) : this.dateISO()) || '';
      row.appendChild(createEl('td', { 'data-label':'Date' }, dateDisp));
      row.appendChild(createEl('td', { 'data-label':'Description' }, escapeHtml(this.description())));
  row.appendChild(createEl('td', { 'data-label':'Category' }, escapeHtml(this.categoryLabel())));
      const amtMetaCls = this.amountClass();
      const amtTxt = this.amountSign() + money(this.amount(), this.currencySymbol);
      row.appendChild(createEl('td', { 'data-label':'Amount', class: amtMetaCls }, amtTxt));
      if(context==='full'){
        row.appendChild(createEl('td', { 'data-label':'Type' }, escapeHtml(this.type().replace(/^./,c=>c.toUpperCase()))));
        const actions = createEl('td', { 'data-label':'Actions', class:'d-flex gap-1' });
        const editBtn = createEl('button', { class:'btn btn-sm btn-outline-secondary', 'data-edit-id': this.id() });
        try { editBtn.setAttribute('data-edit-json', JSON.stringify(this.toEditPayload())); } catch(_){ }
        editBtn.appendChild(createEl('i', { class:'bi bi-pencil' }));
        const delBtn = createEl('button', { class:'btn btn-sm btn-danger', 'data-delete-id': this.id() });
        delBtn.appendChild(createEl('i', { class:'bi bi-trash' }));
        actions.appendChild(editBtn); actions.appendChild(delBtn);
        row.appendChild(actions);
      }
      return row;
    }
  }

  window.TransactionModel = TransactionModel;
  window.__normalizeTxDate = isoDate;
})();
