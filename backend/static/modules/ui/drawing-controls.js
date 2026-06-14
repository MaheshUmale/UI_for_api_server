// Globals: charts, activeChartIndex, updateHeaderUI, saveLayout (provided by main.js)

/**
 * Initializes drawing controls (HLINE toggle, clear, indicator show/hide).
 */
export function initDrawingControls() {
    const toggleIndBtn = document.getElementById('toggleIndicatorsBtn');
    const drawingToolBtn = document.getElementById('drawingToolBtn');
    const clearDrawingsBtn = document.getElementById('clearDrawingsBtn');

    toggleIndBtn?.addEventListener('click', () => {
        const chart = charts[activeChartIndex];
        if (!chart) return;
        chart.showIndicators = !chart.showIndicators;
        Object.values(chart.indicatorSeries).forEach(s => {
            const key = Object.keys(chart.indicatorSeries).find(k => chart.indicatorSeries[k] === s);
            s.applyOptions({ visible: chart.showIndicators && !chart.hiddenPlots.has(key) });
        });
        chart.candleSeries.setMarkers(chart.showIndicators && !chart.hiddenPlots.has('__markers__') ? chart.markers : []);
        updateHeaderUI();
        saveLayout();
    });

    drawingToolBtn?.addEventListener('click', () => {
        const btn = document.getElementById('drawingToolBtn');
        const isActive = btn.classList.toggle('bg-blue-600');
        btn.classList.toggle('text-white', isActive);
        btn.classList.toggle('bg-gray-800', !isActive);
        btn.classList.toggle('text-gray-300', !isActive);
    });

    clearDrawingsBtn?.addEventListener('click', () => {
        const chart = charts[activeChartIndex];
        if (chart) chart.clearDrawings();
    });
}