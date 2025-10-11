/**
 * Start AI generation UI state.
 * Prevents duplicate submissions and shows a spinner while the AI work runs.
 *
 * @param {HTMLFormElement} form - The form element that contains the button and spinner.
 * @returns {boolean} true to allow the form submission to proceed, false to block duplicates.
 */
window.startAiGeneration = (form) => {
  // If the form isn't provided or is not a form element, allow normal submission.
  if (!form || !(form instanceof HTMLFormElement)) return true;

  const button = form.querySelector('#aiGenBtn');
  const spinner = form.querySelector('#aiGenSpinner');

  // If required elements are missing, don't interfere with submission.
  if (!button || !spinner) return true;

  // If already loading, block further submissions.
  if (button.dataset.loading === '1') return false;

  // Mark as loading and update the UI.
  button.dataset.loading = '1';
  button.disabled = true;
  spinner.classList.remove('d-none'); // assumes 'd-none' hides the spinner (Bootstrap)

  // Update visible button text if present.
  const textElement = button.querySelector('.btn-text');
  if (textElement) textElement.textContent = 'Generating...';

  return true;
};
