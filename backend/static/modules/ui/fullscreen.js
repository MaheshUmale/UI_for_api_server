// Globals: charts, activeChartIndex (provided by main.js)

/**
 * Initializes fullscreen/maximize button to open active chart in new tab.
 */
export function initFullscreen() {
    const btn = document.getElementById('maximizeBtn');
    if (btn) {
        btn.addEventListener('click', () => {
            const chart = charts[activeChartIndex];
            if (chart) {
                const url = `${window.location.origin}${window.location.pathname}?symbol=${encodeURIComponent(chart.symbol)}&interval=${encodeURIComponent(chart.interval)}`;
                window.open(url, '_blank');
            }
        });
    }
}