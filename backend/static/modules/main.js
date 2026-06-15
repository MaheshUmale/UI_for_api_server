/**
 * PRODESK Main Entrypoint
 * ES module entrypoint that initializes all UI controls, charts, and Socket.IO.
 */

import { ChartInstance } from './chart-instance.js';
import { initSocket, fetchIntraday, socket } from './socket-manager.js';

import { initLayoutSelector, setLayout, loadLayout, saveLayout, updateActiveChartLabel } from './ui/layout-manager.js';
import { initTimeframeUI } from './ui/timeframe-controls.js';
import { initSearch } from './ui/search-controls.js';
import { initZoomControls } from './ui/zoom-controls.js';
import { initDrawingControls } from './ui/drawing-controls.js';
import { initReplayControls, updateReplayUI } from './ui/replay-controls.js';
import { initAnalysisSidebar, updateAnalysisSidebar } from './ui/analysis-sidebar.js';
import { initIndicatorPanel, populateIndicatorList } from './ui/indicator-panel.js';
import { initTheme } from './ui/theme-manager.js';
import { initFullscreen } from './ui/fullscreen.js';

// --- Global State ---
// Expose on window for legacy interop until full module refactor
window.charts = [];
window.activeChartIndex = 0;
window.currentLayout = 1;
window.showAnalysisSidebar = false;

const charts = window.charts;
let activeChartIndex = 0;
let currentLayout = 1;
let showAnalysisSidebar = false;

// Re-export setActiveChart and updateHeaderUI for modules that reference them
window.saveLayout = saveLayout;
window.fetchIntraday = fetchIntraday;
window.updateActiveChartLabel = updateActiveChartLabel;
window.updateReplayUI = updateReplayUI;
window.populateIndicatorList = populateIndicatorList;

window.setActiveChart = function(chartInstance) {
    activeChartIndex = chartInstance.index;
    window.activeChartIndex = activeChartIndex;
    document.querySelectorAll('.chart-wrapper').forEach(w => w.classList.remove('active'));
    const activeWrapper = document.getElementById(chartInstance.containerId)?.parentElement;
    if (activeWrapper) activeWrapper.classList.add('active');
    updateHeaderUI();
    if (showAnalysisSidebar) updateAnalysisSidebar();
};

window.updateHeaderUI = function() {
    const chart = charts[activeChartIndex];
    if (!chart) return;

    // Timeframe buttons
    document.querySelectorAll('.tf-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.interval === chart.interval);
    });

    // Symbol search input
    const searchInput = document.getElementById('symbolSearch');
    if (searchInput) searchInput.value = chart.symbol;

    // Replay UI
    if (window.updateReplayUI) window.updateReplayUI(chart);
    updateActiveChartLabel();

    // Indicator toggle button
    const indBtn = document.getElementById('toggleIndicatorsBtn');
    if (indBtn) {
        indBtn.innerText = chart.showIndicators ? 'HIDE ALL' : 'SHOW ALL';
        indBtn.classList.toggle('bg-blue-600', chart.showIndicators);
        indBtn.classList.toggle('bg-gray-800', !chart.showIndicators);
    }
};

function init() {
    loadLayout();
    initLayoutSelector();
    initFullscreen();
    initIndicatorPanel();
    initDrawingControls();
    initTimeframeUI();
    initSearch();
    initZoomControls();
    initReplayControls();
    initAnalysisSidebar();
    initTheme();
    if (typeof io !== 'undefined') {
        initSocket();
        window.socket = socket;
    }

    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            charts.forEach(c => {
                const container = document.getElementById(c.containerId);
                if (container && c.chart) {
                    c.chart.resize(container.clientWidth, container.clientHeight);
                    c.syncOiCanvas();
                }
            });
        }, 150);
    });

    // Auto refresh sidebar every 60s
    setInterval(updateAnalysisSidebar, 60000);
}

// Expose init globally for inline onclick handlers or legacy code
window.init = init;

// Auto-start when DOM is ready
document.addEventListener('DOMContentLoaded', init);
