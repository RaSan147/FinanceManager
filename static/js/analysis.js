// Analysis page specific behaviors
// Prevent duplicate submissions and show spinner state on AI generation.
window.startAiGeneration = function(form){
  const btn = form.querySelector('#aiGenBtn');
  const spinner = form.querySelector('#aiGenSpinner');
  if(!btn || !spinner) return true;
  if(btn.dataset.loading === '1') return false;
  btn.dataset.loading = '1';
  btn.disabled = true;
  spinner.classList.remove('d-none');
  const textEl = btn.querySelector('.btn-text');
  if(textEl) textEl.textContent = 'Generating...';
  return true;
};
