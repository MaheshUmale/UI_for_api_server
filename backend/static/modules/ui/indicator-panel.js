// Globals: charts, activeChartIndex, rgbaToHex, saveLayout, populateIndicatorList (provided by main.js)
// Note: rgbaToHex should be imported from utils or defined here

/**
 * Utility: converts RGBA color to hex.
 * @param {string} rgba - RGBA color string
 * @returns {string} Hex color string
 */
function rgbaToHex(rgba) {
    if (!rgba) return '#3b82f6';
    if (rgba.startsWith('#')) return rgba;
    const parts = rgba.match(/[\d.]+/g);
    if (!parts || parts.length < 3) return '#3b82f6';
    const r = parseInt(parts[0]);
    const g = parseInt(parts[1]);
    const b = parseInt(parts[2]);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/**
 * Initializes indicator panel toggle and close buttons.
 */
export function initIndicatorPanel() {
    const manageBtn = document.getElementById('manageIndicatorsBtn');
    const closeBtn = document.getElementById('closeIndicatorPanel');
    const panel = document.getElementById('indicatorPanel');

    manageBtn?.addEventListener('click', () => {
        panel?.classList.toggle('hidden');
        if (!panel?.classList.contains('hidden')) {
            populateIndicatorList();
        }
    });

    closeBtn?.addEventListener('click', () => {
        panel?.classList.add('hidden');
    });
}

/**
 * Populates indicator list with color pickers and visibility toggles.
 */
export function populateIndicatorList() {
    const chart = charts[activeChartIndex];
    if (!chart) return;
    const list = document.getElementById('indicatorList');
    if (!list) return;
    list.innerHTML = '';

    const plotsHeader = document.createElement('div');
    plotsHeader.className = 'text-[9px] font-black text-gray-500 mb-2 mt-2 uppercase tracking-tighter';
    plotsHeader.innerText = 'Plots & Indicators';
    list.appendChild(plotsHeader);

    if (chart.markers.length > 0) {
        const item = document.createElement('div');
        item.className = 'flex items-center justify-between bg-white/5 p-2 rounded-lg mb-2';
        const isHidden = chart.hiddenPlots.has('__markers__');
        item.innerHTML = `
            <span class="text-[10px] font-bold text-gray-300 truncate mr-2 italic">Global Markers Toggle</span>
            <button class="toggle-plot-btn text-[9px] font-black px-2 py-1 rounded ${isHidden ? 'bg-red-500/20 text-red-400' : 'bg-green-500/20 text-green-400'}" data-key="__markers__">
                ${isHidden ? 'HIDDEN' : 'VISIBLE'}
            </button>
        `;
        item.querySelector('.toggle-plot-btn').addEventListener('click', () => {
            if (chart.hiddenPlots.has('__markers__')) {
                chart.hiddenPlots.delete('__markers__');
            } else {
                chart.hiddenPlots.add('__markers__');
            }
            chart.candleSeries.setMarkers(chart.showIndicators && !chart.hiddenPlots.has('__markers__') ? chart.markers : []);
            populateIndicatorList();
            saveLayout();
        });
        list.appendChild(item);

        const uniqueLabels = [...new Set(chart.markers.map(m => m.text).filter(t => t))];
        uniqueLabels.forEach(label => {
            const mItem = document.createElement('div');
            mItem.className = 'flex items-center justify-between bg-white/5 p-2 rounded-lg mb-1 ml-2';
            const sampleMarker = chart.markers.find(m => m.text === label);
            const currentColor = sampleMarker ? sampleMarker.color : '#3b82f6';

            mItem.innerHTML = `
                <div class="flex items-center truncate mr-2">
                    <input type="color" class="indicator-color-picker w-4 h-4 rounded cursor-pointer mr-2 border-0 bg-transparent" value="${rgbaToHex(currentColor)}">
                    <span class="text-[9px] font-bold text-gray-400 truncate">${label}</span>
                </div>
            `;
            mItem.querySelector('.indicator-color-picker').addEventListener('input', (e) => {
                const newColor = e.target.value;
                chart.colorOverrides[label] = newColor;
                chart.markers = chart.markers.map(m => m.text === label ? { ...m, color: newColor } : m);
                chart.candleSeries.setMarkers(chart.showIndicators && !chart.hiddenPlots.has('__markers__') ? chart.markers : []);
                saveLayout();
            });
            list.appendChild(mItem);
        });
    }

    Object.entries(chart.indicatorSeries).forEach(([key, series]) => {
        const title = series._backendTitle || key;
        const item = document.createElement('div');
        item.className = 'flex items-center justify-between bg-white/5 p-2 rounded-lg';
        const isHidden = chart.hiddenPlots.has(key);
        const currentColor = series.options().color;
        item.innerHTML = `
            <div class="flex items-center truncate mr-2">
                <input type="color" class="indicator-color-picker w-4 h-4 rounded cursor-pointer mr-2 border-0 bg-transparent" value="${rgbaToHex(currentColor)}">
                <span class="text-[10px] font-bold text-gray-300 truncate">${title}</span>
            </div>
            <button class="toggle-plot-btn text-[9px] font-black px-2 py-1 rounded ${isHidden ? 'bg-red-500/20 text-red-400' : 'bg-green-500/20 text-green-400'}" data-key="${key}">
                ${isHidden ? 'HIDDEN' : 'VISIBLE'}
            </button>
        `;
        item.querySelector('.indicator-color-picker').addEventListener('input', (e) => {
            const newColor = e.target.value;
            chart.colorOverrides[title] = newColor;
            series.applyOptions({ color: newColor });
            saveLayout();
        });
        item.querySelector('.toggle-plot-btn').addEventListener('click', () => {
            if (chart.hiddenPlots.has(key)) {
                chart.hiddenPlots.delete(key);
                series.applyOptions({ visible: chart.showIndicators });
            } else {
                chart.hiddenPlots.add(key);
                series.applyOptions({ visible: false });
            }
            populateIndicatorList();
            saveLayout();
        });
        list.appendChild(item);
    });

    if (chart.priceLines) {
        Object.entries(chart.priceLines).forEach(([key, line]) => {
            const title = line.options().title || key;
            const item = document.createElement('div');
            item.className = 'flex items-center justify-between bg-white/5 p-2 rounded-lg mt-1';
            const currentColor = line.options().color;
            item.innerHTML = `
                <div class="flex items-center truncate mr-2">
                    <input type="color" class="indicator-color-picker w-4 h-4 rounded cursor-pointer mr-2 border-0 bg-transparent" value="${rgbaToHex(currentColor)}">
                    <span class="text-[10px] font-bold text-blue-300 truncate">${title}</span>
                </div>
                <span class="text-[8px] text-gray-500 uppercase font-black">Line</span>
            `;
            item.querySelector('.indicator-color-picker').addEventListener('input', (e) => {
                const newColor = e.target.value;
                chart.colorOverrides[title] = newColor;
                line.applyOptions({ color: newColor });
                saveLayout();
            });
            list.appendChild(item);
        });
    }

    if (Object.keys(chart.indicatorSeries).length === 0 && (!chart.priceLines || Object.keys(chart.priceLines).length === 0)) {
        const empty = document.createElement('div');
        empty.className = 'text-[10px] text-gray-500 italic mb-4';
        empty.innerText = 'No indicators loaded';
        list.appendChild(empty);
    }

    const drawingsHeader = document.createElement('div');
    drawingsHeader.className = 'text-[9px] font-black text-gray-500 mb-2 mt-4 uppercase tracking-tighter';
    drawingsHeader.innerText = 'Drawings';
    list.appendChild(drawingsHeader);

    chart.drawings.forEach((d, i) => {
        const item = document.createElement('div');
        item.className = 'flex items-center justify-between bg-white/5 p-2 rounded-lg mb-2';
        item.innerHTML = `
            <span class="text-[10px] font-bold text-blue-400 truncate mr-2">HLINE @ ${d.price.toFixed(2)}</span>
            <button class="remove-draw-btn text-[9px] font-black px-2 py-1 rounded bg-red-500/20 text-red-400">
                REMOVE
            </button>
        `;
        item.querySelector('.remove-draw-btn').addEventListener('click', () => {
            if (d.line) chart.candleSeries.removePriceLine(d.line);
            chart.drawings.splice(i, 1);
            populateIndicatorList();
            saveLayout();
        });
        list.appendChild(item);
    });

    if (chart.drawings.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'text-[10px] text-gray-500 italic';
        empty.innerText = 'No drawings';
        list.appendChild(empty);
    }
}