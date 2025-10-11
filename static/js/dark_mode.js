// Improved readability with proper indentation and comments
/*
 * dark_mode.js
 * Small, focused helper that manages the page theme (dark / light).
 * Responsibilities:
 *  - read and apply a saved preference from localStorage
 *  - wire the #darkModeSwitch toggle to change and persist the theme
 *  - if no saved preference, fall back to OS-level preference
 * Note: templates/includes/initial_dark_mode.html contains an early inline script
 * which applies the theme before CSS loads to avoid flash of wrong theme.
 */

class DarkMode {
    // Called once on DOMContentLoaded
    static init() {
        this.loadPreference();
        this.setupToggle();
        this.applySystemPreferenceIfUnset();
    }

    // Read persisted preference and apply immediately if present
    static loadPreference() {
        const saved = localStorage.getItem('darkMode');
        if (saved === 'dark') this.enableDark();
        else if (saved === 'light') this.enableLight();
    }

    // Hook up the UI toggle (if present) and keep it in sync with the document state
    static setupToggle() {
        const toggle = document.getElementById('darkModeSwitch');
        if (!toggle) return;

        // Toggle semantics: checked => light, unchecked => dark
        toggle.addEventListener('change', (e) => {
            if (e.target.checked) this.enableLight();
            else this.enableDark();
        });

        // Reflect current document theme in the toggle state
        const current = document.documentElement.getAttribute('data-theme');
        toggle.checked = current !== 'dark';
    }

    // Apply dark theme and persist choice
    static enableDark() {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.body.classList.add('dark-mode');
        localStorage.setItem('darkMode', 'dark');
        const toggle = document.getElementById('darkModeSwitch');
        if (toggle) toggle.checked = false;
    }

    // Apply light theme and persist choice
    static enableLight() {
        document.documentElement.setAttribute('data-theme', 'light');
        document.body.classList.remove('dark-mode');
        localStorage.setItem('darkMode', 'light');
        const toggle = document.getElementById('darkModeSwitch');
        if (toggle) toggle.checked = true;
    }

    // If user hasn't chosen, prefer OS-level setting. Avoid direct `window.` existence checks.
    static applySystemPreferenceIfUnset() {
        if (localStorage.getItem('darkMode')) return;
        const prefersDark = (typeof matchMedia === 'function') && matchMedia('(prefers-color-scheme: dark)').matches;
        if (prefersDark) this.enableDark();
        else this.enableLight();
    }
}

document.addEventListener('DOMContentLoaded', () => DarkMode.init());