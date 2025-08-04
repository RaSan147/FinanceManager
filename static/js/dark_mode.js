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
            if (e.target.checked) {
                this.enableDarkMode();
            } else {
                this.enableLightMode();
            }
        });

        // Initialize toggle state
        toggle.checked = document.documentElement.getAttribute('data-theme') === 'dark';
    }

    static enableDarkMode() {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.body.classList.add('dark-mode');
        localStorage.setItem('darkMode', 'dark');
    }

    static enableLightMode() {
        document.documentElement.removeAttribute('data-theme');
        document.body.classList.remove('dark-mode');
        localStorage.setItem('darkMode', 'light');
    }

    static applySystemPreference() {
        if (!localStorage.getItem('darkMode')) {
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            if (prefersDark) {
                this.enableDarkMode();
                document.getElementById('darkModeSwitch').checked = true;
            }
        }
    }
}

document.addEventListener('DOMContentLoaded', () => DarkMode.init());