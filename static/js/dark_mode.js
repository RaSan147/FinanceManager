// Improved readability with proper indentation and comments
class DarkMode {
    static init() {
        this.loadPreference();
        this.setupToggle();
        this.applySystemPreference();
    }

    static loadPreference() {
        const savedMode = localStorage.getItem('darkMode');
        if (savedMode === 'dark') {
            this.enableDarkMode();
        } else if (savedMode === 'light') {
            this.enableLightMode();
        }
    }

    static setupToggle() {
        const toggle = document.getElementById('darkModeSwitch');
        if (!toggle) return;

        toggle.addEventListener('change', (e) => {
            // Checked means LIGHT (ball moves to sun icon)
            if (e.target.checked) {
                this.enableLightMode();
            } else {
                this.enableDarkMode();
            }
        });

        // Initialize toggle state
        const currentTheme = document.documentElement.getAttribute('data-theme');
        toggle.checked = currentTheme !== 'dark';
    }

    static enableDarkMode() {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.body.classList.add('dark-mode');
        localStorage.setItem('darkMode', 'dark');
        const toggle = document.getElementById('darkModeSwitch');
        if (toggle) toggle.checked = false;
    }

    static enableLightMode() {
        document.documentElement.setAttribute('data-theme', 'light');
        document.body.classList.remove('dark-mode');
        localStorage.setItem('darkMode', 'light');
        const toggle = document.getElementById('darkModeSwitch');
        if (toggle) toggle.checked = true;
    }

    static applySystemPreference() {
        if (!localStorage.getItem('darkMode')) {
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            if (prefersDark) {
                this.enableDarkMode();
            } else {
                this.enableLightMode();
            }
        }
    }
}

document.addEventListener('DOMContentLoaded', () => DarkMode.init());