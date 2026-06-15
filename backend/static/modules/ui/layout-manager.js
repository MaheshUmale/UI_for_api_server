// Globals: charts, activeChartIndex, currentLayout, setActiveChart (provided by main.js)
import { ChartInstance } from '../chart-instance.js';

/**
 * Updates chart wrapper labels with symbol and interval info.
 */
export function updateActiveChartLabel() {
    charts.forEach(c => {
        const wrapper = document.getElementById(c.containerId)?.parentElement;
        if (!wrapper) return;
        let label = wrapper.querySelector('.chart-label');
        if (!label) {
            label = document.createElement('div');
            label.className = 'chart-label';
            wrapper.appendChild(label);
        }
        label.innerText = `${c.symbol} (${c.interval}m)`;
    });
}

/**
 * Sets the chart layout grid (1, 2, or 4 charts).
 * @param {number} n - Number of chart panels (1, 2, or 4)
 * @param {string|null} overrideSymbol - Symbol to load for first chart
 * @param {string|null} overrideInterval - Interval for the override symbol
 */
export function setLayout(n, overrideSymbol = null, overrideInterval = null) {
    currentLayout = n;
    const container = document.getElementById('chartsContainer');
    if (!container) return;
    container.innerHTML = '';

    charts.forEach(c => c.destroy());
    charts = [];

    const rows = n === 4 ? 2 : 1;
    const cols = n === 1 ? 1 : 2;
    container.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

    for (let i = 0; i < n; i++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'chart-wrapper';
        const chartDiv = document.createElement('div');
        chartDiv.id = `chart-${i}`;
        chartDiv.className = 'chart-container';
        wrapper.appendChild(chartDiv);
        container.appendChild(wrapper);

        const chartInstance = new ChartInstance(`chart-${i}`, i);
        charts.push(chartInstance);

        if (i === 0 && overrideSymbol) {
            chartInstance.switchSymbol(overrideSymbol, overrideInterval || '1');
        } else {
            const saved = JSON.parse(localStorage.getItem(`chart_config_${i}`) || 'null');
            if (saved) {
                chartInstance.symbol = saved.symbol || 'NSE:NIFTY';
                chartInstance.interval = saved.interval || '1';
                chartInstance.showIndicators = saved.showIndicators !== undefined ? saved.showIndicators : true;
                chartInstance.hiddenPlots = new Set(saved.hiddenPlots || []);
                chartInstance.colorOverrides = saved.colorOverrides || {};
                chartInstance.switchSymbol(chartInstance.symbol, chartInstance.interval).then(() => {
                    if (saved.drawings) {
                        saved.drawings.forEach(d => {
                            if (d.type === 'hline') chartInstance.addHorizontalLine(d.price, d.color);
                        });
                    }
                });
            } else {
                chartInstance.switchSymbol('NSE:NIFTY', '1');
            }
        }
    }

    setActiveChart(charts[0]);
    document.querySelectorAll('.layout-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.layout) === n);
    });
    saveLayout();
}

/**
 * Initializes the layout selector buttons (1/2/4 chart grid).
 */
export function initLayoutSelector() {
    document.querySelectorAll('.layout-btn').forEach(btn => {
        btn.addEventListener('click', () => setLayout(parseInt(btn.dataset.layout)));
    });
}

/**
 * Saves current chart layout and configurations to localStorage.
 */
export function saveLayout() {
    localStorage.setItem('prodesk_layout', currentLayout);
    charts.forEach((c, i) => {
        const config = {
            symbol: c.symbol,
            interval: c.interval,
            showIndicators: c.showIndicators,
            hiddenPlots: Array.from(c.hiddenPlots),
            colorOverrides: c.colorOverrides,
            drawings: c.drawings.map(d => ({ type: d.type, price: d.price, color: d.color }))
        };
        localStorage.setItem(`chart_config_${i}`, JSON.stringify(config));
    });
}

/**
 * Loads saved layout from localStorage or URL params.
 */
export function loadLayout() {
    const params = new URLSearchParams(window.location.search);
    const urlSymbol = params.get('symbol');
    const urlInterval = params.get('interval');

    if (urlSymbol) {
        setLayout(1, urlSymbol.toUpperCase(), urlInterval);
    } else {
        const savedLayout = localStorage.getItem('prodesk_layout');
        setLayout(savedLayout ? parseInt(savedLayout) : 1);
    }
}