/**
 * ChartInstance - Extracted from app.js
 *
 * EXTERNAL DEPENDENCIES (provided by main app via window globals):
 *   socket          - Socket.IO client instance
 *   charts          - Array of ChartInstance objects
 *   activeChartIndex - Currently active chart index
 *   currentLayout   - Current layout number
 *   showAnalysisSidebar - Boolean flag for sidebar visibility
 *
 * EXTERNAL FUNCTIONS (called directly, must be in scope of main app):
 *   setActiveChart(chartInstance)
 *   updateActiveChartLabel()
 *   saveLayout()
 *   updateReplayUI(chart)
 *   fetchIntraday(symbol, interval)
 *   populateIndicatorList()
 *
 * EXTERNAL UTILITIES (imported below):
 *   formatIST, applyRvolColoring, tvColorToRGBA
 *
 * EXTERNAL LIBRARY (global):
 *   LightweightCharts
 */

// ES Module imports for utility functions used in this class
import { formatIST, applyRvolColoring, tvColorToRGBA, setLoading } from './utils/formatters.js';
import { socket } from './socket-manager.js';

// The class is accessed as window globals — documented above, not modified here
/* global charts, activeChartIndex, currentLayout, showAnalysisSidebar */
/* global setActiveChart, updateActiveChartLabel, saveLayout, updateReplayUI, fetchIntraday, populateIndicatorList */
/* global LightweightCharts */


export class ChartInstance {
    constructor(containerId, index) {
        this.containerId = containerId;
        this.index = index;
        this.symbol = 'NSE:NIFTY';
        this.interval = '1';
        this.hrn = '';
        this.chart = null;
        this.candleSeries = null;
        this.volumeSeries = null;
        this.indicatorSeries = {};
        this.lastCandle = null;
        this.fullHistory = {
            candles: new Map(), // Use Map for efficient merging by timestamp
            volume: new Map(),
            indicators: {}
        };
        this.drawings = [];
        this.markers = [];
        this.showIndicators = true;
        this.hiddenPlots = new Set();
        this.colorOverrides = {}; // Keyed by indicator title or marker text
        this.oiData = null;
        this.showOiProfile = document.getElementById('oiProfileToggle')?.checked || false;

        // Render caching — avoid redundant O(n log n) sorts
        this._displayCandlesCache = null;
        this._displayVolumeCache = null;
        this._sortedCandlesDirty = true;

        // Replay State
        this.isReplayMode = false;
        this.replayIndex = -1;
        this.replayHistory = {
            pcr: [],
            snapshots: new Map(), // timestamp -> strike data
            signals: []
        };
        this.isPlaying = false;
        this.replayRafId = null;

        this.initChart();
    }

    initChart() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        // Ensure container has relative positioning for the absolute canvas
        container.style.position = 'relative';

        this.chart = LightweightCharts.createChart(container, {
            layout: { background: { type: 'solid', color: '#ffffff' }, textColor: '#191919' },
            grid: { vertLines: { color: '#f0f3fa' }, horzLines: { color: '#f0f3fa' } },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
            localization: {
                locale: 'en-IN',
                timeFormatter: (ts) => {
                    return new Intl.DateTimeFormat('en-IN', {
                        timeZone: 'Asia/Kolkata',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false
                    }).format(new Date(ts * 1000));
                }
            },
            rightPriceScale: { borderColor: '#f0f3fa', autoScale: true, scaleMargins: { top: 0.2, bottom: 0.2 } },
            timeScale: {
                borderColor: '#f0f3fa',
                timeVisible: true,
                secondsVisible: false,
                rightOffset: 10,
                tickMarkFormatter: (time, tickMarkType, locale) => {
                    const date = new Date(time * 1000);
                    const options = { timeZone: 'Asia/Kolkata', hour12: false };
                    if (tickMarkType >= 3) {
                        options.hour = '2-digit';
                        options.minute = '2-digit';
                    } else if (tickMarkType === 2) {
                        options.day = '2-digit';
                        options.month = 'short';
                    } else if (tickMarkType === 1) {
                        options.month = 'short';
                    } else {
                        options.year = 'numeric';
                    }
                    return new Intl.DateTimeFormat('en-IN', options).format(date);
                }
            }
        });

        this.candleSeries = this.chart.addCandlestickSeries({
            upColor: '#22c55e', downColor: '#ef4444', borderVisible: true, wickUpColor: '#22c55e', wickDownColor: '#ef4444',
            lastValueVisible: false,
            priceLineVisible: false
        });

        this.volumeSeries = this.chart.addHistogramSeries({
            color: '#3b82f6', priceFormat: { type: 'volume' }, priceScaleId: 'volume',
            lastValueVisible: false,
            priceLineVisible: false
        });

        this.chart.priceScale('volume').applyOptions({
            scaleMargins: { top: 0.8, bottom: 0 }, visible: false
        });

        // OI Profile Canvas
        this.oiCanvas = document.createElement('canvas');
        this.oiCanvas.className = 'oi-profile-canvas';
        this.oiCanvas.style.position = 'absolute';
        this.oiCanvas.style.top = '0';
        this.oiCanvas.style.right = '0';
        this.oiCanvas.style.pointerEvents = 'none';
        this.oiCanvas.style.zIndex = '5';
        container.appendChild(this.oiCanvas);
        this.syncOiCanvas();

        this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
            if (this.showOiProfile) this.renderOiProfile();
        });

        this.chart.subscribeCrosshairMove((param) => {
            if (!this.showOiProfile || !this.oiData || this.oiData.length === 0 || !param.point) {
                if (this.tooltip) this.tooltip.style.display = 'none';
                return;
            }

            const price = this.candleSeries.coordinateToPrice(param.point.y);
            if (!price) return;

            const closest = this.oiData.reduce((prev, curr) => {
                return (Math.abs(curr.strike - price) < Math.abs(prev.strike - price) ? curr : prev);
            });

            if (closest && Math.abs(closest.strike - price) / closest.strike < 0.01) {
                if (!this.tooltip) {
                    this.tooltip = document.createElement('div');
                    this.tooltip.style.position = 'absolute';
                    this.tooltip.style.display = 'none';
                    this.tooltip.style.padding = '8px';
                    this.tooltip.style.boxSizing = 'border-box';
                    this.tooltip.style.fontSize = '10px';
                    this.tooltip.style.zIndex = '1000';
                    this.tooltip.style.top = '12px';
                    this.tooltip.style.left = '12px';
                    this.tooltip.style.pointerEvents = 'none';
                    this.tooltip.style.borderRadius = '4px';
                    this.tooltip.style.border = '1px solid rgba(255, 255, 255, 0.1)';
                    this.tooltip.style.background = 'rgba(15, 23, 42, 0.9)';
                    this.tooltip.style.backdropFilter = 'blur(4px)';
                    this.tooltip.style.color = '#f8fafc';
                    this.tooltip.style.boxShadow = '0 10px 15px -3px rgba(0, 0, 0, 0.1)';
                    container.parentElement.appendChild(this.tooltip);
                }

                // Only show if mouse is on the right side (where the profile is)
                if (param.point.x > container.clientWidth * 0.7) {
                    this.tooltip.style.display = 'block';
                    this.tooltip.innerHTML = `
                        <div style="font-weight: 800; color: #3b82f6; margin-bottom: 4px;">STRIKE: ${closest.strike}</div>
                        <div style="display: flex; justify-content: space-between; gap: 12px;">
                            <span style="color: #ef4444; font-weight: 600;">CALL OI:</span>
                            <span>${closest.call_oi.toLocaleString()}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; gap: 12px;">
                            <span style="color: #22c55e; font-weight: 600;">PUT OI:</span>
                            <span>${closest.put_oi.toLocaleString()}</span>
                        </div>
                    `;
                    this.tooltip.style.left = (param.point.x - 140) + 'px';
                    this.tooltip.style.top = (param.point.y - 60) + 'px';
                } else {
                    this.tooltip.style.display = 'none';
                }
            } else {
                if (this.tooltip) this.tooltip.style.display = 'none';
            }
        });

        this.chart.subscribeClick((param) => {
            if (this.isReplayMode && param.time && this.replayIndex === -1) {
                 // Convert Map keys to an Array and find the index of the timestamp
                const keys = Array.from(this.fullHistory.candles.keys());
                const idx = keys.indexOf(param.time);

                if (idx !== -1) {
                    console.log("Found at index:", idx);
                }
                if (idx !== -1) {
                    this.replayIndex = idx;
                    this.stepReplay(0);
                    updateReplayUI(this);
                }
            } else {
                const price = param.point ? this.candleSeries.coordinateToPrice(param.point.y) : null;
                if (price) {
                    const hlineBtn = document.getElementById('drawingToolBtn');
                    const isHlineActive = hlineBtn && hlineBtn.classList.contains('bg-blue-600');
                    const isShiftKey = param.sourceEvent && param.sourceEvent.shiftKey;
                    if (isHlineActive || isShiftKey) {
                        this.addHorizontalLine(price);
                    }
                }
            }
        });

        // Handle focus
        container.parentElement.addEventListener('mousedown', () => {
            setActiveChart(this);
        });
    }

    syncOiCanvas() {
        if (!this.oiCanvas) return;
        const container = document.getElementById(this.containerId);
        if (!container) return;
        this.oiCanvas.width = container.clientWidth;
        this.oiCanvas.height = container.clientHeight;
        if (this.showOiProfile) this.renderOiProfile();
    }

    async fetchOiProfile() {
        if (!this.showOiProfile) return;
        try {
            const res = await fetch(`/api/options/oi-analysis/${encodeURIComponent(this.symbol)}`);
            const data = await res.json();
            this.oiData = data.data || [];
            this.renderOiProfile();
        } catch (e) { console.error("Fetch OI failed:", e); }
    }

    renderOiProfile() {
        const ctx = this.oiCanvas.getContext('2d');
        ctx.clearRect(0, 0, this.oiCanvas.width, this.oiCanvas.height);
        if (!this.showOiProfile || !this.oiData || this.oiData.length === 0) return;

        const width = this.oiCanvas.width;
        const height = this.oiCanvas.height;

        // Find visible price range to optimize rendering and labels
        const timeScale = this.chart.timeScale();
        const visibleRange = timeScale.getVisibleLogicalRange();
        if (!visibleRange) return;

        const profileWidth = width * 0.25;
        const sortedData = [...this.oiData].sort((a,b) => a.strike - b.strike);
        const maxOI = Math.max(...sortedData.map(d => Math.max(d.call_oi, d.put_oi)));
        if (maxOI === 0) return;

        // Draw only if strike is within the current visible price range on chart
        sortedData.forEach(d => {
            const y = this.candleSeries.priceToCoordinate(d.strike);
            // Increased vertical tolerance for labels and bars
            if (y === null || y < -20 || y > height + 20) return;

            const callW = (d.call_oi / maxOI) * profileWidth;
            const putW = (d.put_oi / maxOI) * profileWidth;

            // Adjust y to be centered on the strike line
            const barHeight = 4;
            const gap = 1;

            // Call OI (Red) - Top bar
            ctx.fillStyle = 'rgba(239, 68, 68, 0.6)';
            ctx.fillRect(width - callW, y - barHeight - gap, callW, barHeight);

            // Put OI (Green) - Bottom bar
            ctx.fillStyle = 'rgba(34, 197, 94, 0.6)';
            ctx.fillRect(width - putW, y + gap, putW, barHeight);

            // Strike Label
            if (callW > 10 || putW > 10) {
                ctx.fillStyle = document.body.classList.contains('light-theme') ? '#1e293b' : '#94a3b8';
                ctx.font = 'bold 9px "Plus Jakarta Sans"';
                ctx.textAlign = 'right';
                ctx.fillText(d.strike, width - Math.max(callW, putW) - 5, y + 3);
            }
        });
    }

    async switchSymbol(symbol, interval = null) {
        const oldSymbol = this.symbol;
        const oldInterval = this.interval;

        if (symbol) this.symbol = symbol.toUpperCase();
        if (interval) this.interval = interval;

        // Unsubscribe from old symbol/interval if changed
        if (oldSymbol !== this.symbol || oldInterval !== this.interval) {
            if (socket) socket.emit('unsubscribe', { instrumentKeys: [oldSymbol], interval: oldInterval });
        }

        this.lastCandle = null;
        this.hrn = '';
        this.fullHistory = {
            candles: new Map(),
            volume: new Map(),
            indicators: {}
        };

        this.candleSeries.setData([]);
        this.volumeSeries.setData([]);
        this.candleSeries.setMarkers([]);
        Object.values(this.indicatorSeries).forEach(s => this.chart.removeSeries(s));
        this.indicatorSeries = {};

        if (this.priceLines) {
            Object.values(this.priceLines).forEach(l => this.candleSeries.removePriceLine(l));
            this.priceLines = {};
        }

        setLoading(true);
        try {
            const resData = await fetchIntraday(this.symbol, this.interval);
            if (resData.hrn) this.hrn = resData.hrn;
            let candles = resData.candles || [];

            // Filter market hours for NSE
            if (candles.length > 0 && this.symbol.startsWith('NSE:') && !['D', 'W'].includes(this.interval)) {
                const todayIST = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date());
                candles = candles.filter(c => {
                    const ts = typeof c.timestamp === 'number' ? c.timestamp : Math.floor(new Date(c.timestamp).getTime() / 1000);
                    const date = new Date(ts * 1000);
                    const dateIST = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric', day: 'numeric' }).format(date);
                    if (dateIST !== todayIST) return true;
                    const istTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).format(date);
                    const [h, m] = istTime.split(':').map(Number);
                    const mins = h * 60 + m;
                    return mins >= 555 && mins <= 930;
                });
            }

            if (candles.length > 0) {
                const chartData = candles.map(c => ({
                    time: typeof c.timestamp === 'number' ? c.timestamp : Math.floor(new Date(c.timestamp).getTime() / 1000),
                    open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume)
                })).filter(c => !isNaN(c.open) && c.open > 0).sort((a, b) => a.time - b.time);

                chartData.forEach(c => this.fullHistory.candles.set(c.time, c));
                this.lastCandle = chartData[chartData.length - 1];

                candles.forEach(c => {
                    const ts = typeof c.timestamp === 'number' ? c.timestamp : Math.floor(new Date(c.timestamp).getTime() / 1000);
                    this.fullHistory.volume.set(ts, {
                        time: ts,
                        value: Number(c.volume),
                        color: Number(c.close) >= Number(c.open) ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'
                    });
                });

                this.renderData();

                const lastIdx = chartData.length - 1;
                if (!isNaN(lastIdx) && lastIdx >= 0) {
                    this.chart.timeScale().setVisibleLogicalRange({ from: lastIdx - 100, to: lastIdx + 10 });
                }
            }

            if (resData.indicators) {
                this.handleChartUpdate({ indicators: resData.indicators });
                Object.entries(this.indicatorSeries).forEach(([key, s]) => {
                    s.applyOptions({
                        visible: this.showIndicators && !this.hiddenPlots.has(key),
                        lastValueVisible: false,
                        priceLineVisible: false
                    });
                });
                this.candleSeries.setMarkers(this.showIndicators && !this.hiddenPlots.has('__markers__') ? this.markers : []);
            }

            if (this.showOiProfile) this.fetchOiProfile();

            if (socket) socket.emit('subscribe', { instrumentKeys: [this.symbol], interval: this.interval });
            updateActiveChartLabel();
        } catch (e) {
            console.error("Switch symbol failed:", e);
        } finally {
            setLoading(false);
            saveLayout();
        }
    }

    renderData() {
        if (this.fullHistory.candles.size === 0) return;
        if (!this._displayCandlesCache || this._sortedCandlesDirty) {
            this._displayCandlesCache = Array.from(this.fullHistory.candles.values()).sort((a, b) => a.time - b.time);
            if (!this._displayCandlesCache.some(c => c.hasExplicitColor)) {
                this._displayCandlesCache = applyRvolColoring(this._displayCandlesCache);
            }
            this._sortedCandlesDirty = false;
        }
        if (!this._displayVolumeCache || this._sortedCandlesDirty) {
            this._displayVolumeCache = Array.from(this.fullHistory.volume.values()).sort((a, b) => a.time - b.time);
        }
        this.candleSeries.setData(this._displayCandlesCache);
        this.volumeSeries.setData(this._displayVolumeCache);

        // Restore indicators
        Object.entries(this.fullHistory.indicators).forEach(([id, data]) => {
            if (this.indicatorSeries[id]) {
                this.indicatorSeries[id].setData(data);
                this.indicatorSeries[id].applyOptions({ lastValueVisible: false, priceLineVisible: false });
            }
        });

        // Restore markers
        this.candleSeries.setMarkers(this.showIndicators && !this.hiddenPlots.has('__markers__') ? this.markers : []);
    }

    updateRealtimeCandle(quote) {
        if (!this.candleSeries || this.isReplayMode) return;
        const intervalMap = { '1': 60, '5': 300, '15': 900, '30': 1800, '60': 3600, 'D': 86400 };
        const duration = intervalMap[this.interval] || 60;
        const tickTime = Math.floor(quote.ts_ms / 1000);
        const candleTime = tickTime - (tickTime % duration);
        const price = Number(quote.last_price);
        if (isNaN(price) || price <= 0) return;
        const ltq = Number(quote.ltq || 0);

        if (!this.lastCandle || candleTime > this.lastCandle.time) {
            if (this.lastCandle) {
                this.fullHistory.candles.set(this.lastCandle.time, { ...this.lastCandle });
                this.fullHistory.volume.set(this.lastCandle.time, {
                    time: this.lastCandle.time, value: this.lastCandle.volume,
                    color: this.lastCandle.close >= this.lastCandle.open ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'
                });
            }
            this.lastCandle = { time: candleTime, open: price, high: price, low: price, close: price, volume: ltq };
            this.candleSeries.update(this.lastCandle);
            this.volumeSeries.update({ time: candleTime, value: ltq, color: 'rgba(59, 130, 246, 0.5)' });
        } else if (candleTime === this.lastCandle.time) {
            this.lastCandle.close = price;
            this.lastCandle.high = Math.max(this.lastCandle.high, price);
            this.lastCandle.low = Math.min(this.lastCandle.low, price);
            this.lastCandle.volume += ltq;
            this.candleSeries.update(this.lastCandle);
            this.volumeSeries.update({
                time: this.lastCandle.time, value: this.lastCandle.volume,
                color: this.lastCandle.close >= this.lastCandle.open ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'
            });
        }
    }

    handleChartUpdate(data) {
        if (data.ohlcv && data.ohlcv.length > 0) {
            const isTimestamp = data.ohlcv[0][0] > 1e9;
            if (isTimestamp) {
                const candles = data.ohlcv.map(v => ({
                    time: Math.floor(v[0]), open: Number(v[1]), high: Number(v[2]), low: Number(v[3]), close: Number(v[4])
                })).filter(c => !isNaN(c.open) && c.open > 0);
                const vol = data.ohlcv.map(v => ({
                    time: Math.floor(v[0]), value: Number(v[5]),
                    color: Number(v[4]) >= Number(v[1]) ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'
                }));

                candles.forEach((c, idx) => {
                    this.fullHistory.candles.set(c.time, c);
                    this.fullHistory.volume.set(vol[idx].time, vol[idx]);
                });
                this._sortedCandlesDirty = true;

                // Maintain history limit
                if (this.fullHistory.candles.size > 2000) {
                    const keys = Array.from(this.fullHistory.candles.keys()).sort((a,b) => a-b);
                    const toDelete = keys.slice(0, keys.length - 2000);
                    toDelete.forEach(k => {
                        this.fullHistory.candles.delete(k);
                        this.fullHistory.volume.delete(k);
                    });
                    this._sortedCandlesDirty = true;
                }

                if (candles.length > 0) {
                    this.lastCandle = { ...candles[candles.length - 1], volume: vol[vol.length - 1].value };
                    if (!this.isReplayMode) {
                        if (candles.length > 10) this.renderData();
                        else {
                            candles.forEach((c, idx) => {
                                this.candleSeries.update(c);
                                this.volumeSeries.update(vol[idx]);
                            });
                        }
                    }
                }
            }
        }

        if (data.bar_colors) {
            this.applyBarColors(data.bar_colors);
        }

        if (data.indicators) {
            this.applyIndicators(data.indicators);
        }
    }

    applyBarColors(barColors) {
        barColors.forEach(bc => {
            const time = Math.floor(bc.time);
            const candle = this.fullHistory.candles.get(time);
            if (candle) {
                const color = tvColorToRGBA(bc.color);
                candle.color = color; candle.wickColor = color; candle.borderColor = color; candle.hasExplicitColor = true;
            }
        });
        this._sortedCandlesDirty = true;
        this.renderData();
    }

    applyIndicators(indicators) {
        let newlyAdded = false;
        const allMarkers = [];

        indicators.forEach(ind => {
            const { id, type, title, style, data } = ind;

            if (type === 'markers') {
                data.forEach(m => {
                    const mText = m.text || '';
                    allMarkers.push({
                        time: m.time,
                        position: m.position || 'aboveBar',
                        color: this.colorOverrides[mText] || tvColorToRGBA(m.color) || '#3b82f6',
                        shape: m.shape || 'circle',
                        size: m.size || 1,
                        text: mText
                    });
                });
                return;
            }

            if (type === 'price_line') {
                this.addPriceLine(id, data);
                return;
            }

            if (type === 'trade') {
                this.addTradePlot(id, data);
                return;
            }

            // Standard Series: line, area, histogram
            if (!this.indicatorSeries[id]) {
                const options = {
                    title: '', // Hide title on scale
                    color: this.colorOverrides[title] || tvColorToRGBA(style?.color) || '#3b82f6',
                    lineWidth: style?.lineWidth || 1,
                    lineStyle: this._mapLineStyle(style?.lineStyle),
                    visible: this.showIndicators && !this.hiddenPlots.has(id),
                    lastValueVisible: false,
                    priceLineVisible: false,
                    priceScaleId: 'right',
                    priceFormat: { type: 'custom', formatter: val => '' },
                    autoscaleInfoProvider: () => null
                };

                if (type === 'area') {
                    this.indicatorSeries[id] = this.chart.addAreaSeries(options);
                } else if (type === 'histogram') {
                    this.indicatorSeries[id] = this.chart.addHistogramSeries(options);
                } else {
                    this.indicatorSeries[id] = this.chart.addLineSeries(options);
                }
                this.indicatorSeries[id]._backendTitle = title;
                newlyAdded = true;
            }

            if (data && data.length > 0) {
                const formattedData = data.map(d => ({
                    time: d.time,
                    value: d.value,
                    color: d.color ? tvColorToRGBA(d.color) : undefined
                })).sort((a, b) => a.time - b.time);

                this.fullHistory.indicators[id] = formattedData;

                if (!this.isReplayMode) {
                    this.indicatorSeries[id].setData(formattedData);
                    // Force hide labels on every update and ensure visibility matches state
                    this.indicatorSeries[id].applyOptions({
                        visible: this.showIndicators && !this.hiddenPlots.has(id),
                        lastValueVisible: false,
                        priceLineVisible: false,
                        color: this.colorOverrides[title] || tvColorToRGBA(style?.color) || '#3b82f6'
                    });
                }
            }
        });

        // Handle merged markers
        if (allMarkers.length > 0 || (Array.isArray(indicators) && indicators.some(i => i.type === 'markers'))) {
            // Deduplicate markers by time and text
            const uniqueMarkers = [];
            const seen = new Set();
            allMarkers.sort((a, b) => a.time - b.time).forEach(m => {
                const key = `${m.time}_${m.text}`;
                if (!seen.has(key)) {
                    uniqueMarkers.push(m);
                    seen.add(key);
                }
            });

            this.markers = uniqueMarkers;
            if (!this.isReplayMode) {
                this.candleSeries.setMarkers(this.showIndicators && !this.hiddenPlots.has('__markers__') ? this.markers : []);
            }
        }

        if (newlyAdded && this.index === activeChartIndex) {
            if (!document.getElementById('indicatorPanel').classList.contains('hidden')) {
                populateIndicatorList();
            }
        }
    }

    _mapLineStyle(style) {
        if (style === 1) return LightweightCharts.LineStyle.Dashed;
        if (style === 2) return LightweightCharts.LineStyle.Dotted;
        if (style === 3) return LightweightCharts.LineStyle.LargeDashed;
        if (style === 4) return LightweightCharts.LineStyle.SparseDotted;
        return LightweightCharts.LineStyle.Solid;
    }

    addPriceLine(id, data) {
        if (!this.priceLines) this.priceLines = {};
        if (this.priceLines[id]) {
            this.candleSeries.removePriceLine(this.priceLines[id]);
        }
        const title = data.title || id;
        this.priceLines[id] = this.candleSeries.createPriceLine({
            price: data.price,
            color: this.colorOverrides[title] || tvColorToRGBA(data.color) || '#3b82f6',
            lineWidth: data.lineWidth || 2,
            lineStyle: this._mapLineStyle(data.lineStyle || 2),
            axisLabelVisible: false,
            title: title
        });
    }

    addTradePlot(id, data) {
        const { entry, sl, target, entryColor, slColor, targetColor } = data;
        if (entry) this.addPriceLine(`${id}_entry`, { price: entry, color: entryColor || '#fff', title: 'ENTRY', lineStyle: 0 });
        if (sl) this.addPriceLine(`${id}_sl`, { price: sl, color: slColor || '#ef4444', title: 'SL', lineStyle: 2 });
        if (target) this.addPriceLine(`${id}_target`, { price: target, color: targetColor || '#22c55e', title: 'TARGET', lineStyle: 2 });
    }

    async loadReplayHistory() {
        if (!this.symbol) return;
        try {
            const [optRes, signalsRes] = await Promise.all([
                fetch(`/api/options/full-history/${encodeURIComponent(this.symbol)}`),
                fetch(`/api/db/query`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sql: `SELECT * FROM brain_signal_events WHERE underlying = '${this.symbol}' ORDER BY timestamp ASC`
                    })
                })
            ]);

            const data = await optRes.json();
            const signalData = await signalsRes.json();

            this.replayHistory.pcr = data.pcr_history || [];
            this.replayHistory.snapshots = new Map();
            this.replayHistory.signals = signalData.results || [];

            if (data.snapshots) {
                data.snapshots.forEach(s => {
                    const ts = Math.floor(new Date(s.timestamp).getTime() / 1000);
                    if (!this.replayHistory.snapshots.has(ts)) {
                        this.replayHistory.snapshots.set(ts, []);
                    }
                    this.replayHistory.snapshots.get(ts).push(s);
                });
            }
        } catch (e) { console.error("Replay history load failed:", e); }
    }

    stepReplay(delta) {
        const newIdx = this.replayIndex + delta;
        const allCandles = Array.from(this.fullHistory.candles.values()).sort((a,b) => a.time - b.time);
        const allVolume = Array.from(this.fullHistory.volume.values()).sort((a,b) => a.time - b.time);

        if (newIdx >= 0 && newIdx < allCandles.length) {
            this.replayIndex = newIdx;
            const vC = allCandles.slice(0, this.replayIndex + 1);
            const vV = allVolume.slice(0, this.replayIndex + 1);
            const currentTime = vC[vC.length - 1].time;

            this.candleSeries.setData(vC);
            this.volumeSeries.setData(vV);

            // Subset indicators
            Object.entries(this.fullHistory.indicators).forEach(([id, data]) => {
                const series = this.indicatorSeries[id];
                if (series) {
                    const subset = data.filter(d => d.time <= currentTime);
                    series.setData(subset);
                }
            });

            // Subset markers
            const visibleMarkers = this.markers.filter(m => m.time <= currentTime);
            this.candleSeries.setMarkers(this.showIndicators && !this.hiddenPlots.has('__markers__') ? visibleMarkers : []);

            this.lastCandle = { ...vC[vC.length - 1] };

            // Synchronize Options Data
            this.syncReplayOptions(currentTime);
        }
    }

    syncReplayOptions(currentTime) {
        // Find nearest PCR data
        const pcrList = this.replayHistory.pcr;
        let activePCR = null;
        if (pcrList.length > 0) {
            // PCR timestamps are in ISO or UTC. Map to unix.
            const pcrUnix = pcrList.map(p => ({ ...p, unix: Math.floor(new Date(p.timestamp).getTime() / 1000) }));
            const relevant = pcrUnix.filter(p => p.unix <= currentTime);
            if (relevant.length > 0) activePCR = relevant[relevant.length - 1];
        }

        // Find nearest Snapshot
        const snapshotTimestamps = Array.from(this.replayHistory.snapshots.keys()).sort((a, b) => a - b);
        const relevantSnapTs = snapshotTimestamps.filter(ts => ts <= currentTime);
        if (relevantSnapTs.length > 0) {
            const nearestTs = relevantSnapTs[relevantSnapTs.length - 1];
            this.oiData = this.replayHistory.snapshots.get(nearestTs);
            if (this.showOiProfile) this.renderOiProfile();
        }

        // Handle Brain/Scalper Signals for Replay
        if (this.replayHistory.signals && this.replayHistory.signals.length > 0) {
            const currentSignals = this.replayHistory.signals.filter(s => {
                const ts = Math.floor(new Date(s.timestamp).getTime() / 1000);
                // Within 1 minute window or exactly at bar
                return ts <= currentTime && ts > currentTime - (parseInt(this.interval) * 60);
            });

            currentSignals.forEach(s => {
                // Emit to sidebar logs if active
                if (showAnalysisSidebar && activeChartIndex === this.index) {
                    this.logReplaySignal(s);
                }
            });
        }

        // Update Sidebar if active
        if (showAnalysisSidebar && activeChartIndex === this.index) {
            this.renderReplaySidebar(activePCR);
        }
    }

    logReplaySignal(data) {
        const logList = document.getElementById('sideLogsList');
        if (!logList) return;

        const timeStr = formatIST(data.timestamp);
        const signalKey = `[REPLAY-BRAIN] ${timeStr} | ${data.type} @ ${data.price}`;

        // Check if already logged to avoid duplicates in replay loop
        if (logList.firstChild && logList.firstChild.textContent.includes(signalKey)) return;

        const p = document.createElement('p');
        p.className = 'border-b border-black/5 last:border-0 py-1 text-purple-600 font-black bg-purple-500/5';
        p.textContent = signalKey + ` (${data.reason || ''})`;
        logList.prepend(p);
        if (logList.children.length > 50) logList.lastElementChild.remove();
    }

    renderReplaySidebar(pcrData) {
        if (!pcrData) return;

        const pcrEl = document.getElementById('side-pcr');
        const powerEl = document.getElementById('side-power');
        if (pcrEl) pcrEl.textContent = pcrData.pcr_oi?.toFixed(2) || "-";
        if (powerEl) powerEl.textContent = (pcrData.total_oi_change > 500000 ? "STRONG" : pcrData.total_oi_change > 100000 ? "MODERATE" : "WEAK");

        // Update Logs with replay info
        const logList = document.getElementById('sideLogsList');
        const msg = `[REPLAY] ${formatIST(pcrData.timestamp)} | PCR: ${pcrData.pcr_oi} | Spot: ${pcrData.spot_price || pcrData.underlying_price}`;
        const p = document.createElement('p');
        p.className = 'border-b border-black/5 last:border-0 py-1 text-blue-500 font-bold';
        p.textContent = msg;
        logList.prepend(p);
        if (logList.children.length > 50) logList.lastElementChild.remove();
    }

    addHorizontalLine(price, color = '#3b82f6') {
        const line = this.candleSeries.createPriceLine({
            price: price, color: color, lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: false, title: 'HLINE'
        });
        this.drawings.push({ type: 'hline', price, color, line });
        saveLayout();
    }

    clearDrawings() {
        this.drawings.forEach(d => {
            if (d.line) this.candleSeries.removePriceLine(d.line);
        });
        this.drawings = [];
        saveLayout();
    }

    destroy() {
        if (this.chart) {
            this.chart.remove();
            this.chart = null;
        }
    }
}