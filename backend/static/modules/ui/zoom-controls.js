// Globals: charts, activeChartIndex (provided by main.js)

/**
 * Initializes zoom controls (in/out/reset buttons).
 */
export function initZoomControls() {
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const resetZoomBtn = document.getElementById('resetZoomBtn');
    const chart = charts[activeChartIndex];

    zoomInBtn?.addEventListener('click', () => {
        const c = charts[activeChartIndex];
        if (!c || !c.chart) return;
        const ts = c.chart.timeScale();
        ts.applyOptions({ barSpacing: Math.min(50, ts.options().barSpacing * 1.2) });
    });

    zoomOutBtn?.addEventListener('click', () => {
        const c = charts[activeChartIndex];
        if (!c || !c.chart) return;
        const ts = c.chart.timeScale();
        ts.applyOptions({ barSpacing: Math.max(0.1, ts.options().barSpacing / 1.2) });
    });

    resetZoomBtn?.addEventListener('click', () => {
        const c = charts[activeChartIndex];
        if (!c || !c.chart) return;
        const lastIdx = c.fullHistory.candles.size - 1;
        if (lastIdx >= 0) c.chart.timeScale().setVisibleLogicalRange({ from: lastIdx - 100, to: lastIdx + 10 });
    });
}