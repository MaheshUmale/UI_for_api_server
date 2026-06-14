// Globals: charts (provided by main.js)

/**
 * Initializes theme toggle button (dark/light mode).
 */
export function initTheme() {
    const btn = document.getElementById('themeToggleBtn');
    if (btn) {
        btn.addEventListener('click', () => {
            const isLight = document.body.classList.contains('light-theme');
            applyTheme(isLight ? 'dark' : 'light');
        });
    }
    applyTheme(localStorage.getItem('theme') || 'light');
}

/**
 * Applies theme (dark/light) to body and all charts.
 * @param {string} theme - 'dark' or 'light'
 */
export function applyTheme(theme) {
    localStorage.setItem('theme', theme);
    const isLight = theme === 'light';

    if (isLight) {
        document.body.classList.add('light-theme');
        document.getElementById('sunIcon')?.classList.add('hidden');
        document.getElementById('moonIcon')?.classList.remove('hidden');
    } else {
        document.body.classList.remove('light-theme');
        document.getElementById('sunIcon')?.classList.remove('hidden');
        document.getElementById('moonIcon')?.classList.add('hidden');
    }

    const chartBg = isLight ? '#f8fafc' : '#0a0e17';
    const chartText = isLight ? '#0f172a' : '#f1f5f9';
    const gridColor = isLight ? '#f0f3fa' : 'rgba(255,255,255,0.05)';

    charts.forEach(c => {
        if (c.chart) {
            c.chart.applyOptions({
                layout: { background: { color: chartBg }, textColor: chartText },
                grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
                rightPriceScale: { borderColor: gridColor },
                timeScale: { borderColor: gridColor }
            });
            if (c.showOiProfile) c.renderOiProfile();
        }
    });
}