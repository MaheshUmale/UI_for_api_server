// Globals: charts, activeChartIndex, updateHeaderUI (provided by main.js)

/**
 * Initializes timeframe selector buttons (1M, 5M, 15M, 1H).
 */
export function initTimeframeUI() {
    document.querySelectorAll('.tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const chart = charts[activeChartIndex];
            if (chart && btn.dataset.interval !== chart.interval) {
                chart.switchSymbol(chart.symbol, btn.dataset.interval);
                updateHeaderUI();
            }
        });
    });
}