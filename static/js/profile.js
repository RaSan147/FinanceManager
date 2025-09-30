// profile.js - refactored to App module
class ProfileModule {
  static init() {
    const form = document.querySelector('[data-profile-form]');
    if (!form) return;
    form.addEventListener('submit', e => this.onSubmit(e, form));
  }
  static async onSubmit(e, form) {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {};
    fd.forEach((v, k) => {
      if (v !== '' && v != null) payload[k] = v;
    });
    const btn = form.querySelector('button[type="submit"]');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      window.flash && window.flash('Profile updated', 'success');
    } catch (err) {
      window.flash && window.flash(err.message || 'Update failed', 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }
}
App.register(ProfileModule);