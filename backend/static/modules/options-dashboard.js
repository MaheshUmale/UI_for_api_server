        // Global state
        let currentUnderlying = 'NSE:NIFTY';
        let socket = null;
        let charts = {};

        // Stubs for late-defined functions — real implementations override these below
        function buildStrategy() {}
        function loadAlerts() {}
        function updateScalperStatusUI() {}
        function renderBuildupSummary() {}
        async function createAlert() {}
        async function startScalper() {}
        async function stopScalper() {}

        // Chart.js Global Defaults
        if (window.Chart) {
            Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";
            Chart.defaults.color = '#94a3b8';
            Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(15, 23, 42, 0.9)';
            Chart.defaults.plugins.tooltip.titleFont = { size: 12, weight: '800' };
            Chart.defaults.plugins.tooltip.bodyFont = { size: 11, weight: '600' };
            Chart.defaults.plugins.tooltip.padding = 12;
            Chart.defaults.plugins.tooltip.cornerRadius = 8;
        }

        let theme = localStorage.getItem('theme') || 'light';

        function applyTheme(newTheme) {
            theme = newTheme;
            localStorage.setItem('theme', theme);
            if (theme === 'light') {
                document.body.classList.add('light-theme');
                document.getElementById('optionsSunIcon')?.classList.add('hidden');
                document.getElementById('optionsMoonIcon')?.classList.remove('hidden');
            } else {
                document.body.classList.remove('light-theme');
                document.getElementById('optionsSunIcon')?.classList.remove('hidden');
                document.getElementById('optionsMoonIcon')?.classList.add('hidden');
            }
            // Redraw charts if needed
            const textColor = theme === 'light' ? '#0f172a' : '#f8fafc';
            const mutedColor = theme === 'light' ? '#475569' : '#94a3b8';
            const gridColor = theme === 'light' ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)';

            Object.values(charts).forEach(chart => {
                if (chart && chart.options && chart.options.scales) {
                    // Update all scales (x, y, y-spot, y-pcr, etc)
                    Object.values(chart.options.scales).forEach(scale => {
                        if (scale.ticks) scale.ticks.color = mutedColor;
                        if (scale.grid) scale.grid.color = gridColor;
                        if (scale.title) scale.title.color = (scale.title.text === 'SPOT PRICE' || scale.title.text === 'PCR') ? scale.title.color : textColor;
                    });

                    if (chart.options.plugins.legend && chart.options.plugins.legend.labels) {
                        chart.options.plugins.legend.labels.color = textColor;
                    }
                    chart.update();
                }
            });
        }

        function formatIST(timestamp, short = false) {
            const options = {
                timeZone: 'Asia/Kolkata',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            };
            if (!short) options.second = '2-digit';
            return new Intl.DateTimeFormat('en-IN', options).format(new Date(timestamp));
        }

        // Initialize
        document.addEventListener('DOMContentLoaded', () => {
            applyTheme(localStorage.getItem('theme') || 'light');
            initSocket();
            loadData();
            setupEventListeners();

            // Auto-refresh fallback every 30 minutes (lazy tabs use Socket.IO)
            setInterval(loadData, 1800000);
        });

        function initSocket() {
            if (typeof io === 'undefined') {
                console.error('Socket.io not loaded');
                return;
            }
            socket = io();

            socket.on('connect', () => {
                console.log('Socket connected');
                if (socket) socket.emit('subscribe_options', { underlying: currentUnderlying });
                if (socket) socket.emit('subscribe', { instrumentKeys: [currentUnderlying], interval: '1' });
            });

            socket.on('raw_tick', (data) => {
                for (const [key, quote] of Object.entries(data)) {
                    if (key.toUpperCase() === currentUnderlying.toUpperCase()) {
                        const price = parseFloat(quote.last_price);
                        if (!isNaN(price) && price > 0) {
                            document.getElementById('spotPrice').textContent = price.toLocaleString(undefined, {minimumFractionDigits: 2});
                        }
                    }
                }
            });

            socket.on('chart_update', (data) => {
                if (data.instrumentKey?.toUpperCase() === currentUnderlying.toUpperCase() && data.ohlcv?.length > 0) {
                    const latest = data.ohlcv[data.ohlcv.length - 1];
                    const price = parseFloat(latest[4]);
                    if (!isNaN(price) && price > 0) {
                        document.getElementById('spotPrice').textContent = price.toLocaleString(undefined, {minimumFractionDigits: 2});
                    }
                }
            });

            // Throttle LTP updates to 10fps per symbol to prevent flash churn
            const ltpThrottle = {};
            const ltpPending = {};

            socket.on('options_quote_update', (data) => {
                if (data.underlying !== currentUnderlying) return;
                const now = performance.now();
                const sym = data.symbol;

                // Store latest pending value
                ltpPending[sym] = data.lp;

                // Throttle DOM updates to 10fps per symbol
                if (ltpThrottle[sym] && now - ltpThrottle[sym] < 100) return;
                ltpThrottle[sym] = now;

                const ltpEl = document.getElementById(`ltp-${sym}`);
                if (!ltpEl) return;

                const newLtp = ltpPending[sym];
                delete ltpPending[sym];
                const oldLtp = parseFloat(ltpEl.textContent.replace(/,/g, ''));
                ltpEl.textContent = newLtp.toFixed(2);

                // Debounced flash animation (skip if recently flashed)
                const row = ltpEl.closest('tr');
                if (row && !isNaN(oldLtp) && Math.abs(oldLtp - newLtp) > 0.01) {
                    row.classList.remove('flash-up', 'flash-down');
                    requestAnimationFrame(() => {
                        row.classList.add(newLtp >= oldLtp ? 'flash-up' : 'flash-down');
                    });
                }
            });

            socket.on('options_alert', (data) => {
                showAlert(data.message);
            });

            socket.on('scalper_log', (data) => {
                const logEl = document.getElementById('scalperLog');
                const p = document.createElement('p');

                let message = data.message;
                if (!message && data.signal) {
                    // Structured signal log matching prompt requirements
                    message = `[${data.time}] [SIGNAL: ${data.signal}] [LVL: ${data.underlying_level}] [OI: ${data.oi_confirmation}] [INV: ${data.inverse_status}]`;
                    p.className = 'text-green-400 font-black bg-green-500/10 p-1 rounded border border-green-500/20 my-1';
                } else if (message) {
                    // Colorize simple logs
                    if (message.includes('ORDER SENT') || message.includes('SIGNAL')) p.className = 'text-green-400 font-bold';
                    else if (message.includes('ATM Switched') || message.includes('Fetching')) p.className = 'text-blue-400 italic';
                    else if (message.includes('CLOSED') || message.includes('RiskMgmt')) p.className = 'text-orange-400 font-bold';
                    else if (message.includes('ERROR')) p.className = 'text-red-500';
                    else p.className = 'text-gray-300';
                }

                p.textContent = message || "Unknown log event";
                logEl.appendChild(p);
                logEl.scrollTop = logEl.scrollHeight;

                // Sync status if needed
                window.updateScalperStatusUI();
            });

            socket.on('options_snapshot_update', (data) => {
                if (data.underlying !== currentUnderlying) return;
                data.updates.forEach(u => {
                    const ltpEl = document.getElementById(`ltp-${u.symbol}`);
                    if (ltpEl && u.ltp !== undefined) ltpEl.textContent = u.ltp.toFixed(2);
                    const oiEl = document.getElementById(`oi-${u.symbol}`);
                    if (oiEl && u.oi !== undefined) oiEl.textContent = u.oi.toLocaleString();
                    const oichgEl = document.getElementById(`oichg-${u.symbol}`);
                    if (oichgEl && u.oi_change !== undefined) {
                        oichgEl.textContent = u.oi_change;
                        oichgEl.className = `py-2.5 px-3 font-bold ${u.oi_change > 0 ? 'text-green-500' : 'text-red-500'}`;
                    }
                    const ivEl = document.getElementById(`iv-${u.symbol}`);
                    if (ivEl && u.iv !== undefined) ivEl.textContent = u.iv.toFixed(2);
                    const deltaEl = document.getElementById(`delta-${u.symbol}`);
                    if (deltaEl && u.delta !== undefined) {
                        deltaEl.textContent = u.delta.toFixed(2);
                        deltaEl.className = `py-2.5 px-3 ${u.delta > 0 ? 'greek-positive' : 'greek-negative'}`;
                    }
                    const thetaEl = document.getElementById(`theta-${u.symbol}`);
                    if (thetaEl && u.theta !== undefined) thetaEl.textContent = u.theta.toFixed(2);
                });
            });

            socket.on('scalper_metrics', (data) => {
                const powerEl = document.getElementById('scalperOIPower');
                const sentimentEl = document.getElementById('scalperOISentiment');
                const statusEl = document.getElementById('scalperOIStatus');
                const zoneEl = document.getElementById('scalperSignalZone');
                const ceVwapEl = document.getElementById('ceVwap');
                const peVwapEl = document.getElementById('peVwap');

                if (powerEl) powerEl.textContent = data.oi_power;
                if (sentimentEl) {
                    sentimentEl.textContent = data.oi_sentiment.replace(/_/g, ' ');
                    if (data.oi_sentiment.includes('BULLISH')) sentimentEl.className = 'text-lg font-black text-green-500 mt-1';
                    else if (data.oi_sentiment.includes('BEARISH')) sentimentEl.className = 'text-lg font-black text-red-500 mt-1';
                    else sentimentEl.className = 'text-lg font-black text-white mt-1';
                }
                if (statusEl) {
                    statusEl.textContent = data.oi_status.replace(/_/g, ' ');
                    if (data.oi_status === 'LONG_BUILDUP') statusEl.className = 'text-lg font-black text-green-500 mt-1';
                    else if (data.oi_status === 'SHORT_BUILDUP') statusEl.className = 'text-lg font-black text-red-500 mt-1';
                    else if (data.oi_status === 'SHORT_COVERING') statusEl.className = 'text-lg font-black text-blue-500 mt-1';
                    else if (data.oi_status === 'LONG_UNWINDING') statusEl.className = 'text-lg font-black text-orange-500 mt-1';
                    else statusEl.className = 'text-lg font-black text-white mt-1';
                }
                if (zoneEl) zoneEl.textContent = data.underlying_level || '-';
                if (ceVwapEl) ceVwapEl.textContent = data.vwap.call || '-';
                if (peVwapEl) peVwapEl.textContent = data.vwap.put || '-';

                // Confluence Check UI
                if (data.confluence) {
                    const updateConf = (id, active) => {
                        const el = document.getElementById(id);
                        if (!el) return;
                        if (active) {
                            el.classList.remove('opacity-40');
                            el.classList.add('bg-blue-600', 'border-blue-400', 'text-white', 'shadow-[0_0_15px_rgba(59,130,246,0.5)]');
                        } else {
                            el.classList.add('opacity-40');
                            el.classList.remove('bg-blue-600', 'border-blue-400', 'text-white', 'shadow-[0_0_15px_rgba(59,130,246,0.5)]');
                        }
                    };
                    updateConf('conf-lvl', data.confluence.lvl);
                    updateConf('conf-pcr', data.confluence.pcr);
                    updateConf('conf-oi', data.confluence.oi);
                    updateConf('conf-brk', data.confluence.opt_brk);
                    updateConf('conf-inv', data.confluence.inv_dwn);
                }
            });
        }

        function setupEventListeners() {
            // Underlying selector
            document.getElementById('underlyingSelect').addEventListener('change', (e) => {
                const oldUnderlying = currentUnderlying;
                currentUnderlying = e.target.value;

                if (socket) socket.emit('unsubscribe_options', { underlying: oldUnderlying });
                if (socket) socket.emit('unsubscribe', { instrumentKeys: [oldUnderlying], interval: '1' });

                if (socket) socket.emit('subscribe_options', { underlying: currentUnderlying });
                if (socket) socket.emit('subscribe', { instrumentKeys: [currentUnderlying], interval: '1' });

                loadData();
            });

            // Refresh button
            document.getElementById('refreshBtn').addEventListener('click', loadData);

            // Backfill button
            document.getElementById('backfillBtn').addEventListener('click', async () => {
                try {
                    const response = await fetch('/api/options/backfill', { method: 'POST' });
                    const data = await response.json();
                    showAlert(data.message);
                } catch (error) {
                    console.error('Backfill error:', error);
                }
            });

            // Alerts header button
            document.getElementById('alertsBtn').addEventListener('click', () => switchTab('alerts'));

            // Strategy header button
            document.getElementById('strategyBtn').addEventListener('click', () => switchTab('strategies'));

            // Theme toggle
            document.getElementById('optionsThemeToggle').addEventListener('click', () => {
                const isLight = document.body.classList.contains('light-theme');
                applyTheme(isLight ? 'dark' : 'light');
            });

            // Tab switching
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const tabId = btn.dataset.tab;
                    switchTab(tabId);
                });
            });

            // Strategy builder
            document.getElementById('buildStrategyBtn')?.addEventListener('click', () => window.buildStrategy());

            // Strategy type change
            document.getElementById('strategyType').addEventListener('change', (e) => {
                const container = document.getElementById('customLegsContainer');
                if (e.target.value === 'custom') {
                    container.classList.remove('hidden');
                    if (document.getElementById('legsList').children.length === 0) {
                        addLegRow();
                    }
                } else {
                    container.classList.add('hidden');
                }
            });

            // Add leg button
            document.getElementById('addLegBtn').addEventListener('click', addLegRow);

            // Create Alert button
            document.getElementById('createAlertBtn').addEventListener('click', createAlert);

            // Scalper Start/Stop
            document.getElementById('startScalperBtn').addEventListener('click', startScalper);
            document.getElementById('stopScalperBtn').addEventListener('click', stopScalper);
            document.getElementById('clearLogBtn').addEventListener('click', () => {
                document.getElementById('scalperLog').innerHTML = '';
            });
        }

        function addLegRow() {
            const list = document.getElementById('legsList');
            const id = Date.now();
            const row = document.createElement('div');
            row.id = `leg-${id}`;
            row.className = 'grid grid-cols-5 gap-1 items-center bg-slate-800/50 p-2 rounded';
            row.innerHTML = `
                <input type="number" placeholder="Strike" class="col-span-2 bg-slate-900 border border-white/5 rounded px-1 py-1 text-[10px] strike-input">
                <select class="bg-slate-900 border border-white/5 rounded px-1 py-1 text-[10px] type-input">
                    <option value="call">CE</option>
                    <option value="put">PE</option>
                </select>
                <select class="bg-slate-900 border border-white/5 rounded px-1 py-1 text-[10px] pos-input">
                    <option value="long">Buy</option>
                    <option value="short">Sell</option>
                </select>
                <button onclick="document.getElementById('leg-${id}').remove()" class="text-red-500 text-[10px] font-bold">×</button>
            `;
            list.appendChild(row);
        }

        const tabLoaded = { overview: false, alerts: false, scalper: false, system: false };

        function switchTab(tabId) {
            // Update active tab button
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.classList.remove('tab-active');
                if (btn.dataset.tab === tabId) {
                    btn.classList.add('tab-active');
                }
            });

            // Show active tab content
            document.querySelectorAll('.tab-pane').forEach(pane => {
                pane.classList.add('hidden');
            });
            document.getElementById(tabId + 'Tab').classList.remove('hidden');

            // Load tab-specific data only on first visit (lazy loading)
            if (tabId === 'overview' && !tabLoaded.overview) { tabLoaded.overview = true; loadOverviewData(); }
            if (tabId === 'alerts' && !tabLoaded.alerts) { tabLoaded.alerts = true; window.loadAlerts(); }
            if (tabId === 'scalper' && !tabLoaded.scalper) { tabLoaded.scalper = true; window.updateScalperStatusUI(); }
            if (tabId === 'system' && !tabLoaded.system) { tabLoaded.system = true; loadSystemStatus(); }
        }

        async function loadSystemStatus() {
            try {
                const response = await fetch('/api/tv/status');
                const data = await response.json();
                if (!data) return;

                // Update Health Score
                const health = (data.system_health || {}).overall_health || 0;
                document.getElementById('healthScoreText').textContent = health.toFixed(0) + '%';
                document.getElementById('healthCircle').setAttribute('stroke-dasharray', `${health}, 100`);

                // Update Basic Stats
                document.getElementById('engineStatus').textContent = data.is_running ? 'RUNNING' : 'STOPPED';
                const conn = data.connections || {};
                const cache = data.cache || {};
                document.getElementById('engineConnections').textContent = `${conn.active || 0} Active / ${conn.total || 0} Total`;
                document.getElementById('engineCache').textContent = (cache.usage_percentage || 0).toFixed(1) + '%';

                // Update Quality
                const qm = data.quality_metrics || {};
                const quality = qm.current_metrics || {};
                document.getElementById('qualityCompleteness').textContent = ((quality.completeness_rate || 0) * 100).toFixed(1) + '%';
                document.getElementById('qualityAccuracy').textContent = ((quality.accuracy_rate || 0) * 100).toFixed(1) + '%';

                // Update Performance
                const perf = data.performance_metrics || {};
                document.getElementById('perfLatency').textContent = (perf.avg_response_time_ms || 0).toFixed(0) + 'ms';
                document.getElementById('perfThroughput').textContent = (perf.requests_per_second || 0).toFixed(2) + ' req/s';
                document.getElementById('perfErrorRate').textContent = ((perf.error_rate || 0) * 100).toFixed(2) + '%';

                // Update Recommendations
                const recs = (data.system_health || {}).recommendations || [];
                if (recs && recs.length > 0) {
                    document.getElementById('systemRec').textContent = recs[0];
                } else {
                    document.getElementById('systemRec').textContent = 'System operating within normal parameters.';
                }
            } catch (error) {
                console.error('Error loading system status:', error);
            }
        }

        function setSkeleton(show) {
            const skeletonBody = document.getElementById('optionChainSkeleton');
            const chainBody = document.getElementById('optionChainBody');
            const confluenceSk = document.getElementById('confluenceSkeleton');
            const oiSk = document.getElementById('oiSkeleton');
            const oiTrendSk = document.getElementById('oiTrendMergedSkeleton');
            if (skeletonBody) skeletonBody.classList.toggle('hidden', !show);
            if (chainBody) chainBody.classList.toggle('hidden', show);
            if (confluenceSk) confluenceSk.classList.toggle('hidden', !show);
            if (oiSk) oiSk.classList.toggle('hidden', !show);
            if (oiTrendSk) oiTrendSk.classList.toggle('hidden', !show);
        }

        async function loadData() {
            setSkeleton(true);
            try {
                // Load option chain
                const chainResponse = await fetch(`/api/options/chain/${currentUnderlying}/with-greeks`);
                const chainData = await chainResponse.json();

                // Load high activity strikes for highlighting
                const activityRes = await fetch(`/api/options/high-activity/${currentUnderlying}`);
                const activityData = await activityRes.json();
                const activityArr = Array.isArray(activityData) ? activityData : (activityData.strikes || []);
                const highActivityStrikes = new Set(activityArr.map(s => s.strike));

                renderOptionChain(chainData, highActivityStrikes);

                // Load Genie Insights
                const genieRes = await fetch(`/api/options/genie-insights/${currentUnderlying}`);
                const genieData = await genieRes.json();
                updateGenieCard(genieData);

                // Load Buildup summary for the card
                const buildupRes = await fetch(`/api/options/oi-buildup/${currentUnderlying}`);
                const buildupData = await buildupRes.json();
                if (typeof window.renderBuildupSummary === 'function') {
                    window.renderBuildupSummary(buildupData);
                }

                // Update source if available
                if (chainData.source) {
                    document.getElementById('dataSource').textContent = chainData.source.toUpperCase();
                }

                // Load IV analysis
                const ivResponse = await fetch(`/api/options/iv-analysis/${currentUnderlying}`);
                const ivData = await ivResponse.json();
                updateIVCard(ivData);

                // Load PCR Trend & Summary Metrics
                await loadOverviewData();

                // Update timestamp
                document.getElementById('lastUpdated').textContent = formatIST(new Date());
            } catch (error) {
                console.error('Error loading data:', error);
            } finally {
                setSkeleton(false);
            }
        }

        async function loadOverviewData() {
            try {
                const [pcrRes, oiRes, srRes] = await Promise.all([
                    fetch(`/api/options/pcr-trend/${currentUnderlying}`).then(r => r.json()),
                    fetch(`/api/options/oi-analysis/${currentUnderlying}`).then(r => r.json()),
                    fetch(`/api/options/support-resistance/${currentUnderlying}`).then(r => r.json())
                ]);

                renderPCRChart(pcrRes);
                renderOIChart(oiRes);
                renderSupportResistance(srRes);
                renderMergedOIChart(pcrRes);
                updateSummaryFromOverview(pcrRes, oiRes);

            } catch (e) { console.error("Overview data load failed:", e); }
        }

        function updateSummaryFromOverview(pcrData, oiData) {
            const history = pcrData.history || [];
            if (history.length > 0) {
                const latest = history[history.length - 1];
                document.getElementById('pcrValue').textContent = latest.pcr_oi?.toFixed(2) || '0.00';
                document.getElementById('pcrVol').textContent = latest.pcr_vol?.toFixed(2) || '0.00';
                document.getElementById('maxPain').textContent = (latest.max_pain || 0).toLocaleString();

                const spot = latest.spot_price || latest.underlying_price || 0;
                if (spot > 0) {
                    const diff = latest.max_pain - spot;
                    const diffPct = (diff / spot * 100).toFixed(2);
                    const diffEl = document.getElementById('maxPainDiff');
                    diffEl.textContent = `${diff > 0 ? '+' : ''}${diff.toLocaleString()} (${diffPct}%)`;
                    diffEl.className = `text-[8px] font-black ${diff >= 0 ? 'text-green-500' : 'text-red-500'} uppercase tracking-tighter`;
                }

                // PCR Signal
                const pcr = latest.pcr_oi;
                const pcrSignal = document.getElementById('pcrSignal');
                if (pcr > 1.3) { pcrSignal.textContent = 'OVERBOUGHT'; pcrSignal.className = 'text-[8px] font-black bg-red-500/20 text-red-500 px-1.5 py-0.5 rounded uppercase'; }
                else if (pcr > 1.1) { pcrSignal.textContent = 'BEARISH'; pcrSignal.className = 'text-[8px] font-black bg-red-400/20 text-red-400 px-1.5 py-0.5 rounded uppercase'; }
                else if (pcr < 0.7) { pcrSignal.textContent = 'OVERSOLD'; pcrSignal.className = 'text-[8px] font-black bg-green-500/20 text-green-500 px-1.5 py-0.5 rounded uppercase'; }
                else if (pcr < 0.9) { pcrSignal.textContent = 'BULLISH'; pcrSignal.className = 'text-[8px] font-black bg-green-400/20 text-green-400 px-1.5 py-0.5 rounded uppercase'; }
                else { pcrSignal.textContent = 'NEUTRAL'; pcrSignal.className = 'text-[8px] font-black bg-gray-500/20 text-gray-400 px-1.5 py-0.5 rounded uppercase'; }
            }
        }

        function renderOptionChain(data, highActivityStrikes = new Set()) {
            const tbody = document.getElementById('optionChainBody');
            tbody.innerHTML = '';

            const chain = data.chain || [];
            const spotPrice = data.spot_price || 0;

            // Update Summary Cards
            document.getElementById('spotPrice').textContent = spotPrice.toLocaleString(undefined, {minimumFractionDigits: 2});
            document.getElementById('aimSpot').textContent = spotPrice.toFixed(0);

            if (data.net_delta !== undefined) {
                const deltaEl = document.getElementById('netDelta');
                deltaEl.textContent = (data.net_delta / 1000000).toFixed(2) + 'M';
                const sigEl = document.getElementById('deltaSignal');
                if (data.net_delta > 100000) { sigEl.textContent = 'BULLISH'; sigEl.className = 'text-[8px] font-black bg-green-500/20 text-green-500 px-1.5 py-0.5 rounded uppercase mb-1'; }
                else if (data.net_delta < -100000) { sigEl.textContent = 'BEARISH'; sigEl.className = 'text-[8px] font-black bg-red-500/20 text-red-500 px-1.5 py-0.5 rounded uppercase mb-1'; }
                else { sigEl.textContent = 'NEUTRAL'; sigEl.className = 'text-[8px] font-black bg-gray-500/20 text-gray-400 px-1.5 py-0.5 rounded uppercase mb-1'; }
            }
            if (data.net_theta !== undefined) {
                document.getElementById('netTheta').textContent = (data.net_theta / 1000000).toFixed(2) + 'M';
            }

            if (chain.length === 0) {
                tbody.innerHTML = '<tr><td colspan="13" class="py-10 text-center text-gray-500 font-bold">No data available. Please click "Backfill" or wait for the next snapshot.</td></tr>';
                return;
            }

            // Group by strike
            const strikes = {};
            chain.forEach(item => {
                if (!strikes[item.strike]) {
                    strikes[item.strike] = { call: null, put: null };
                }
                strikes[item.strike][item.option_type] = item;
            });

            // Sort strikes
            const sortedStrikes = Object.keys(strikes).sort((a, b) => parseFloat(a) - parseFloat(b));

            sortedStrikes.forEach(strike => {
                const strikeVal = parseFloat(strike);
                const data = strikes[strike];
                const call = data.call || {};
                const put = data.put || {};

                const isATM = Math.abs(strikeVal - spotPrice) / spotPrice < 0.002;
                const isHighActivity = highActivityStrikes.has(strikeVal);

                // ITM/OTM Shading
                const callITM = strikeVal < spotPrice;
                const putITM = strikeVal > spotPrice;

                let rowClass = isATM ? 'bg-blue-500/10' : '';
                if (isHighActivity) rowClass += ' border-l-2 border-yellow-500/50';

                const row = document.createElement('tr');
                row.className = `${rowClass} hover:bg-white/10 transition-colors border-b border-white/5`;
                row.innerHTML = `
                    <td id="iv-${call.symbol}" class="py-2.5 px-3 text-right text-gray-400 font-medium ${callITM ? 'bg-yellow-500/5' : ''}">${call.iv || '-'}</td>
                    <td id="delta-${call.symbol}" class="py-2.5 px-3 text-right ${callITM ? 'bg-yellow-500/5' : ''} ${call.delta > 0 ? 'greek-positive' : 'greek-negative'}">${call.delta?.toFixed(2) || '-'}</td>
                    <td id="theta-${call.symbol}" class="py-2.5 px-3 text-right ${callITM ? 'bg-yellow-500/5' : ''} text-gray-500 font-medium">${call.theta?.toFixed(2) || '-'}</td>
                    <td id="ltp-${call.symbol}" class="py-2.5 px-3 text-right ${callITM ? 'bg-yellow-500/5' : ''} font-black text-green-500 text-xs">${call.ltp?.toFixed(2) || '-'}</td>
                    <td id="oichg-${call.symbol}" class="py-2.5 px-3 text-right ${callITM ? 'bg-yellow-500/5' : ''} font-bold ${call.oi_change > 0 ? 'text-green-500' : 'text-red-500'}">${call.oi_change || '-'}</td>
                    <td id="oi-${call.symbol}" class="py-2.5 px-3 text-right border-r border-white/10 ${callITM ? 'bg-yellow-500/5' : ''} font-bold text-white">${call.oi?.toLocaleString() || '-'}</td>
                    <td class="py-2.5 px-3 text-center strike-cell text-sm shadow-inner font-black">${strike}</td>
                    <td id="oi-${put.symbol}" class="py-2.5 px-3 text-left ${putITM ? 'bg-yellow-500/5' : ''} font-bold text-white">${put.oi?.toLocaleString() || '-'}</td>
                    <td id="oichg-${put.symbol}" class="py-2.5 px-3 text-left ${putITM ? 'bg-yellow-500/5' : ''} font-bold ${put.oi_change > 0 ? 'text-green-500' : 'text-red-500'}">${put.oi_change || '-'}</td>
                    <td id="ltp-${put.symbol}" class="py-2.5 px-3 text-left ${putITM ? 'bg-yellow-500/5' : ''} font-black text-red-500 text-xs">${put.ltp?.toFixed(2) || '-'}</td>
                    <td id="theta-${put.symbol}" class="py-2.5 px-3 text-left ${putITM ? 'bg-yellow-500/5' : ''} text-gray-500 font-medium">${put.theta?.toFixed(2) || '-'}</td>
                    <td id="delta-${put.symbol}" class="py-2.5 px-3 text-left ${putITM ? 'bg-yellow-500/5' : ''} ${put.delta > 0 ? 'greek-positive' : 'greek-negative'}">${put.delta?.toFixed(2) || '-'}</td>
                    <td id="iv-${put.symbol}" class="py-2.5 px-3 text-left text-gray-400 font-medium ${putITM ? 'bg-yellow-500/5' : ''}">${put.iv || '-'}</td>
                `;
                tbody.appendChild(row);
            });
        }

        function updateSummaryCards(data) {
            const oiData = data.data || [];

            // Calculate totals
            let totalCallOI = 0, totalPutOI = 0;
            let totalCallOIChange = 0, totalPutOIChange = 0;

            oiData.forEach(item => {
                totalCallOI += item.call_oi || 0;
                totalPutOI += item.put_oi || 0;
                totalCallOIChange += item.call_oi_change || 0;
                totalPutOIChange += item.put_oi_change || 0;
            });

            const pcr = totalCallOI > 0 ? (totalPutOI / totalCallOI).toFixed(2) : '0.00';
            const pcrVol = totalCallOIChange > 0 ? (totalPutOIChange / totalCallOIChange).toFixed(2) : '0.00';

            document.getElementById('pcrValue').textContent = pcr;
            document.getElementById('pcrVol').textContent = pcrVol;

            // PCR Signal - Decisive Thresholds for Indices
            const pcrSignal = document.getElementById('pcrSignal');
            if (pcr > 1.3) {
                pcrSignal.textContent = 'OVERBOUGHT';
                pcrSignal.className = 'text-[10px] font-black bg-red-500/20 text-red-500 px-2 py-0.5 rounded uppercase';
            } else if (pcr > 1.1) {
                pcrSignal.textContent = 'BEARISH';
                pcrSignal.className = 'text-[10px] font-black bg-red-400/20 text-red-400 px-2 py-0.5 rounded uppercase';
            } else if (pcr < 0.7) {
                pcrSignal.textContent = 'OVERSOLD';
                pcrSignal.className = 'text-[10px] font-black bg-green-500/20 text-green-500 px-2 py-0.5 rounded uppercase';
            } else if (pcr < 0.9) {
                pcrSignal.textContent = 'BULLISH';
                pcrSignal.className = 'text-[10px] font-black bg-green-400/20 text-green-400 px-2 py-0.5 rounded uppercase';
            } else {
                pcrSignal.textContent = 'NEUTRAL';
                pcrSignal.className = 'text-[10px] font-black bg-gray-500/20 text-gray-400 px-2 py-0.5 rounded uppercase';
            }
        }

        function updateIVCard(data) {
            document.getElementById('ivRank').textContent = data.iv_rank !== undefined ? data.iv_rank + '%' : '-';
            document.getElementById('ivValue').textContent = data.current_iv !== undefined ? data.current_iv + '%' : '-';

            const ivSignal = document.getElementById('ivSignal');
            if (data.iv_rank > 70) {
                ivSignal.textContent = 'HIGH';
                ivSignal.className = 'text-[10px] font-black bg-red-500/20 text-red-500 px-2 py-0.5 rounded uppercase';
            } else if (data.iv_rank < 30) {
                ivSignal.textContent = 'LOW';
                ivSignal.className = 'text-[10px] font-black bg-green-500/20 text-green-500 px-2 py-0.5 rounded uppercase';
            } else {
                ivSignal.textContent = 'NORMAL';
                ivSignal.className = 'text-[10px] font-black bg-gray-500/20 text-gray-400 px-2 py-0.5 rounded uppercase';
            }
        }

        function updateGenieCard(data) {
            const controlEl = document.getElementById('genieControl');
            const distEl = document.getElementById('genieDistribution');
            const rangeEl = document.getElementById('genieRange');
            const sidewaysBadge = document.getElementById('sidewaysBadge');

            controlEl.textContent = data.control.replace(/_/g, ' ');
            if (data.control === 'BUYERS_IN_CONTROL') controlEl.className = 'text-lg font-black text-green-500 uppercase';
            else if (data.control === 'SELLERS_IN_CONTROL') controlEl.className = 'text-lg font-black text-red-500 uppercase';
            else controlEl.className = 'text-lg font-black text-white uppercase';

            distEl.textContent = data.distribution.status;
            distEl.className = data.distribution.is_aggressive_distribution ? 'text-[9px] font-black text-red-400 mt-1 uppercase' : 'text-[9px] font-bold text-gray-500 mt-1 uppercase';

            rangeEl.textContent = `${(data.boundaries || {}).lower || '-'} - ${(data.boundaries || {}).upper || '-'}`;

            if (data.sideways_expected) sidewaysBadge.classList.remove('hidden');
            else sidewaysBadge.classList.add('hidden');
        }

        async function loadOIAnalysis() {
            try {
                const response = await fetch(`/api/options/oi-analysis/${currentUnderlying}`);
                const data = await response.json();
                renderOIChart(data);

                // Load support/resistance
                const srResponse = await fetch(`/api/options/support-resistance/${currentUnderlying}`);
                const srData = await srResponse.json();
                renderSupportResistance(srData);
            } catch (error) {
                console.error('Error loading OI analysis:', error);
            }
        }

        function renderOIChart(data) {
            const ctx = document.getElementById('oiChart').getContext('2d');

            const oiData = data.data || [];
            const strikes = oiData.map(d => d.strike);
            const callOI = oiData.map(d => d.call_oi);
            const putOI = oiData.map(d => d.put_oi);

            if (charts.oi) {
                charts.oi.data.labels = strikes;
                charts.oi.data.datasets[0].data = callOI;
                charts.oi.data.datasets[1].data = putOI;
                charts.oi.update('none');
            } else {
                charts.oi = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: strikes,
                        datasets: [
                            {
                                label: 'Call OI',
                                data: callOI,
                                backgroundColor: 'rgba(34, 197, 94, 0.6)',
                                borderColor: 'rgba(34, 197, 94, 1)',
                                borderWidth: 1
                            },
                            {
                                label: 'Put OI',
                                data: putOI,
                                backgroundColor: 'rgba(239, 68, 68, 0.6)',
                                borderColor: 'rgba(239, 68, 68, 1)',
                                borderWidth: 1
                            }
                        ]
                    },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: { ticks: { color: '#94a3b8', font: { size: 9 } } },
                        y: { ticks: { color: '#94a3b8', font: { size: 9 } } }
                    },
                    plugins: {
                        legend: { labels: { color: '#f8fafc', font: { size: 10 } } }
                    }
                    }
                });
            }
        }

        function renderSupportResistance(data) {
            const container = document.getElementById('supportResistance');
            container.innerHTML = '';

            const resistance = data.resistance_levels || [];
            const support = data.support_levels || [];

            const allLevels = [
                ...resistance.map(l => ({...l, type: 'RES'})),
                ...support.map(l => ({...l, type: 'SUP'}))
            ].sort((a, b) => b.strike - a.strike);

            allLevels.forEach(level => {
                const isSup = level.type === 'SUP';
                const color = isSup ? 'text-green-500' : 'text-red-500';
                const bgColor = isSup ? 'bg-green-500/5' : 'bg-red-500/5';
                const borderColor = isSup ? 'border-green-500/20' : 'border-red-500/20';
                const label = level.oi > 1000000 ? '(ss)' : level.oi > 500000 ? '(s)' : '';

                // Sparkline generator for Trend
                let sparkline = '';
                if (level.oi_history && level.oi_history.length > 1) {
                    const min = Math.min(...level.oi_history);
                    const max = Math.max(...level.oi_history);
                    const range = max - min || 1;
                    const points = level.oi_history.map((val, i) => {
                        const x = (i / (level.oi_history.length - 1)) * 50;
                        const y = 12 - ((val - min) / range) * 10;
                        return `${x},${y}`;
                    }).join(' ');
                    sparkline = `<svg class="w-12 h-3 overflow-visible" viewBox="0 0 50 12"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${color} opacity-70"/></svg>`;
                }

                const div = document.createElement('div');
                div.className = `flex justify-between items-center py-2 px-3 ${bgColor} border-l-4 ${borderColor} rounded-r mb-1.5 shadow-sm transition-all hover:translate-x-1`;
                div.innerHTML = `
                    <div class="flex items-center gap-3">
                        <div class="flex flex-col">
                            <span class="text-xs font-black ${color} tracking-tighter">${level.strike}</span>
                            <span class="text-[7px] text-gray-500 font-black uppercase">${isSup ? 'Support' : 'Resist'}</span>
                        </div>
                    </div>
                    <div class="flex items-center gap-4">
                        <div class="flex flex-col items-end">
                             <div class="mb-0.5">${sparkline}</div>
                             <div class="flex items-center gap-1.5">
                                 <span class="text-[9px] text-gray-400 font-black">${(level.oi/1000000).toFixed(2)}M</span>
                                 <span class="text-[10px] font-black ${color}">${label}</span>
                             </div>
                        </div>
                    </div>
                `;
                container.appendChild(div);
            });
        }

        async function loadPCRTrend() {
            try {
                const response = await fetch(`/api/options/pcr-trend/${currentUnderlying}`);
                const data = await response.json();
                renderPCRChart(data);

                // Update Max Pain from latest trend data
                if (data.history && data.history.length > 0) {
                    const latest = data.history[data.history.length - 1];
                    const maxPain = latest.max_pain || 0;
                    const spot = latest.spot_price || latest.underlying_price || 0;

                    document.getElementById('maxPain').textContent = maxPain.toLocaleString();

                    if (spot > 0) {
                        // Backup update for spot price
                        const spotEl = document.getElementById('spotPrice');
                        if (spotEl.textContent === '0.00' || spotEl.textContent === '-') {
                            spotEl.textContent = spot.toLocaleString(undefined, {minimumFractionDigits: 2});
                        }

                        const diff = maxPain - spot;
                        const diffPct = (diff / spot * 100).toFixed(2);
                        const diffEl = document.getElementById('maxPainDiff');
                        diffEl.textContent = `${diff > 0 ? '+' : ''}${diff.toLocaleString()} (${diffPct}%)`;
                        diffEl.className = `text-[10px] font-black ${diff >= 0 ? 'text-green-500' : 'text-red-500'}`;
                    }
                }
            } catch (error) {
                console.error('Error loading PCR trend:', error);
            }
        }

        function renderMergedOIChart(pcrData) {
            const ctx = document.getElementById('oiTrendMergedChart').getContext('2d');

            const history = pcrData.history || [];
            const labels = history.map(h => formatIST(h.timestamp, true));
            const totalOI = history.map(h => h.total_oi);
            const totalOIChange = history.map(h => h.total_oi_change);
            const oiChangeColors = history.map(h => (h.total_oi_change || 0) >= 0 ? 'rgba(34, 197, 94, 0.5)' : 'rgba(239, 68, 68, 0.5)');

            if (charts.oiTrendMerged) {
                charts.oiTrendMerged.data.labels = labels;
                charts.oiTrendMerged.data.datasets[0].data = totalOI;
                charts.oiTrendMerged.data.datasets[1].data = totalOIChange;
                charts.oiTrendMerged.data.datasets[1].backgroundColor = oiChangeColors;
                charts.oiTrendMerged.update('none');
            } else {
                charts.oiTrendMerged = new Chart(ctx, {
                    data: {
                        labels,
                        datasets: [
                            {
                                type: 'line',
                                label: 'Total OI',
                                data: totalOI,
                                borderColor: '#3b82f6',
                                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                                fill: true, tension: 0.4, pointRadius: 0, yAxisID: 'y'
                            },
                            {
                                type: 'bar',
                                label: 'OI Change',
                                data: totalOIChange,
                                backgroundColor: oiChangeColors,
                                yAxisID: 'y1'
                            }
                        ]
                    },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    scales: {
                        x: { display: false },
                        y: { type: 'linear', display: true, position: 'left', ticks: { color: '#64748b', font: { size: 8 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
                        y1: { type: 'linear', display: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#64748b', font: { size: 8 } } }
                    },
                    plugins: {
                        legend: { display: true, position: 'top', align: 'end', labels: { color: '#94a3b8', font: { size: 8 }, boxWidth: 8, usePointStyle: true } }
                    }
                    }
                });
            }
        }

        function renderPCRChart(data) {
            let history = data.history || [];

            // Deduplicate by timestamp (Frontend Safety)
            const seen = new Set();
            history = history.filter(h => {
                if (seen.has(h.timestamp)) return false;
                seen.add(h.timestamp);
                return true;
            });

            // Filter out invalid spot prices to ensure correct auto-scaling
            const validHistory = history.filter(h => (h.spot_price || h.underlying_price) > 0);

            const timestamps = validHistory.map(h => formatIST(h.timestamp));
            const theme = localStorage.getItem('theme') || 'light';
            const textColor = theme === 'light' ? '#0f172a' : '#f8fafc';
            const mutedColor = theme === 'light' ? '#475569' : '#94a3b8';

            // 1. Confluence Chart (Spot + PCR)
            const confCtx = document.getElementById('confluenceChart').getContext('2d');

            const spotData = validHistory.map(h => h.spot_price || h.underlying_price);
            const pcrData = validHistory.map(h => h.pcr_oi);

            if (charts.confluence) {
                charts.confluence.data.labels = timestamps;
                charts.confluence.data.datasets[0].data = spotData;
                charts.confluence.data.datasets[1].data = pcrData;
                charts.confluence.update('none');
            } else {
                charts.confluence = new Chart(confCtx, {
                    type: 'line',
                    data: {
                        labels: timestamps,
                        datasets: [
                            {
                                label: 'Spot Price',
                                data: spotData,
                                borderColor: theme === 'light' ? '#000000' : '#ffffff',
                                borderWidth: 2,
                                borderDash: [3, 3], // Dotted line as in image
                                fill: false,
                                tension: 0.4,
                                pointRadius: 0,
                                yAxisID: 'y-spot'
                            },
                            {
                                label: 'PCR (OI)',
                                data: pcrData,
                            borderColor: '#3b82f6',
                            backgroundColor: 'rgba(59, 130, 246, 0.1)',
                            fill: true,
                            tension: 0.4,
                            pointRadius: 0,
                            yAxisID: 'y-pcr'
                        },
                        // {
                        //     label: 'PCR (Vol)',
                        //     data: history.map(h => h.pcr_vol),
                        //     borderColor: 'rgba(168, 85, 247, 1)',
                        //     backgroundColor: 'rgba(168, 85, 247, 0.1)',
                        //     fill: false,
                        //     borderDash: [5, 5],
                        //     tension: 0.4,
                        //     yAxisID: 'y-pcr'
                        // }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    scales: {
                        x: { ticks: { color: mutedColor, font: { size: 9 } } },
                        'y-spot': {
                            type: 'linear',
                            display: true,
                            position: 'right',
                            ticks: { color: theme === 'light' ? '#000000' : '#ffffff', font: { size: 9, weight: 'bold' } },
                            grid: { drawOnChartArea: false },
                            beginAtZero: false,
                            grace: '5%',
                            title: { display: true, text: 'SPOT PRICE', color: theme === 'light' ? '#000000' : '#ffffff', font: { size: 10, weight: 'bold' } }
                        },
                        'y-pcr': {
                            type: 'linear',
                            display: true,
                            position: 'left',
                            ticks: { color: '#3b82f6', font: { size: 9, weight: 'bold' } },
                            beginAtZero: false,
                            grace: '5%',
                            title: { display: true, text: 'PCR', color: '#3b82f6', font: { size: 10, weight: 'bold' } }
                        }
                    },
                    plugins: {
                        legend: { labels: { color: textColor, font: { size: 10 } } }
                    }
                }
            });

        }

        async function loadGreeks() {
            try {
                const response = await fetch(`/api/options/chain/${currentUnderlying}/with-greeks`);
                const data = await response.json();
                renderGreeksCharts(data);
            } catch (error) {
                console.error('Error loading Greeks:', error);
            }
        }

        function renderGreeksCharts(data) {
            const chain = data.chain || [];
            const strikes = [...new Set(chain.map(c => c.strike))].sort((a, b) => a - b);

            // Delta chart
            const deltaCtx = document.getElementById('deltaChart').getContext('2d');

            const callDeltas = strikes.map(s => {
                const item = chain.find(c => c.strike === s && c.option_type === 'call');
                return item ? item.delta : 0;
            });
            const putDeltas = strikes.map(s => {
                const item = chain.find(c => c.strike === s && c.option_type === 'put');
                return item ? item.delta : 0;
            });

            if (charts.delta) {
                charts.delta.data.labels = strikes;
                charts.delta.data.datasets[0].data = callDeltas;
                charts.delta.data.datasets[1].data = putDeltas;
                charts.delta.update('none');
            } else {
                charts.delta = new Chart(deltaCtx, {
                    type: 'line',
                    data: {
                        labels: strikes,
                        datasets: [
                            {
                                label: 'Call Delta',
                                data: callDeltas,
                                borderColor: 'rgba(34, 197, 94, 1)',
                                backgroundColor: 'rgba(34, 197, 94, 0.1)',
                                fill: false
                            },
                            {
                                label: 'Put Delta',
                                data: putDeltas,
                                borderColor: 'rgba(239, 68, 68, 1)',
                                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                                fill: false
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            x: { ticks: { color: '#94a3b8', font: { size: 9 } } },
                            y: { ticks: { color: '#94a3b8', font: { size: 9 } } }
                        },
                        plugins: {
                            legend: { labels: { color: '#f8fafc', font: { size: 10 } } }
                        }
                    }
                });
            }

            // Theta chart
            const thetaCtx = document.getElementById('thetaChart').getContext('2d');

            const callThetas = strikes.map(s => {
                const item = chain.find(c => c.strike === s && c.option_type === 'call');
                return item ? item.theta : 0;
            });
            const putThetas = strikes.map(s => {
                const item = chain.find(c => c.strike === s && c.option_type === 'put');
                return item ? item.theta : 0;
            });

            if (charts.theta) {
                charts.theta.data.labels = strikes;
                charts.theta.data.datasets[0].data = callThetas;
                charts.theta.data.datasets[1].data = putThetas;
                charts.theta.update('none');
            } else {
                charts.theta = new Chart(thetaCtx, {
                    type: 'bar',
                    data: {
                        labels: strikes,
                        datasets: [
                            {
                                label: 'Call Theta',
                                data: callThetas,
                                backgroundColor: 'rgba(34, 197, 94, 0.6)'
                            },
                            {
                                label: 'Put Theta',
                                data: putThetas,
                                backgroundColor: 'rgba(239, 68, 68, 0.6)'
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            x: { ticks: { color: '#94a3b8', font: { size: 9 } } },
                            y: { ticks: { color: '#94a3b8', font: { size: 9 } } }
                        },
                        plugins: {
                            legend: { labels: { color: '#f8fafc', font: { size: 10 } } }
                        }
                    }
                });
            }
        }

        async function loadBuildupAnalysis() {
            try {
                const response = await fetch(`/api/options/oi-buildup/${currentUnderlying}`);
                const data = await response.json();
                renderBuildupAnalysis(data);
            } catch (error) {
                console.error('Error loading buildup analysis:', error);
            }
        }

        window.renderBuildupSummary = function(data) {
            const container = document.getElementById('buildupAnalysis');
            container.innerHTML = '';
            const patterns = data.summary?.pattern_distribution || {};
            const colors = { 'Long Buildup': 'text-green-500', 'Short Buildup': 'text-red-500', 'Long Unwinding': 'text-orange-500', 'Short Covering': 'text-blue-400' };

            Object.entries(patterns).forEach(([p, count]) => {
                const div = document.createElement('div');
                div.className = 'flex flex-col items-center bg-black/10 rounded py-1 px-2';
                div.innerHTML = `
                    <div class="text-[7px] text-gray-500 uppercase font-black truncate w-full text-center">${p.replace(' Buildup', '')}</div>
                    <div class="text-xs font-black ${colors[p] || 'text-white'}">${count}</div>
                `;
                container.appendChild(div);
            });
        }

        window.buildStrategy = async function() {
            const strategyType = document.getElementById('strategyType').value;

            try {
                let endpoint = '';
                let body = {};

                // Get current spot price
                const chainResponse = await fetch(`/api/options/chain/${currentUnderlying}/with-greeks`);
                const chainData = await chainResponse.json();
                const spotPrice = chainData.spot_price || 0;

                switch(strategyType) {
                    case 'bull_call_spread':
                        endpoint = '/api/strategy/bull-call-spread';
                        body = {
                            underlying: currentUnderlying,
                            spot_price: spotPrice,
                            lower_strike: Math.floor(spotPrice / 100) * 100,
                            higher_strike: Math.ceil((spotPrice + 200) / 100) * 100,
                            lower_premium: 50,
                            higher_premium: 20,
                            expiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
                        };
                        break;
                    case 'iron_condor':
                        endpoint = '/api/strategy/iron-condor';
                        body = {
                            underlying: currentUnderlying,
                            spot_price: spotPrice,
                            put_sell_strike: Math.floor((spotPrice - 200) / 100) * 100,
                            put_buy_strike: Math.floor((spotPrice - 400) / 100) * 100,
                            call_sell_strike: Math.ceil((spotPrice + 200) / 100) * 100,
                            call_buy_strike: Math.ceil((spotPrice + 400) / 100) * 100,
                            premiums: { put_buy: 10, put_sell: 25, call_sell: 25, call_buy: 10 },
                            expiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
                        };
                        break;
                    case 'long_straddle':
                        endpoint = '/api/strategy/long-straddle';
                        body = {
                            underlying: currentUnderlying,
                            spot_price: spotPrice,
                            strike: Math.round(spotPrice / 100) * 100,
                            call_premium: 80,
                            put_premium: 70,
                            expiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
                        };
                        break;
                    case 'custom':
                        endpoint = '/api/strategy/build';
                        const legs = [];
                        document.querySelectorAll('#legsList > div').forEach(row => {
                            legs.push({
                                strike: parseFloat(row.querySelector('.strike-input').value),
                                option_type: row.querySelector('.type-input').value,
                                position: row.querySelector('.pos-input').value,
                                quantity: 1,
                                premium: 10, // Default for analysis
                                expiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
                            });
                        });
                        body = {
                            name: 'Custom Strategy',
                            strategy_type: 'CUSTOM',
                            underlying: currentUnderlying,
                            spot_price: spotPrice,
                            legs: legs
                        };
                        break;
                }

                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });

                const data = await response.json();
                renderStrategyAnalysis(data.analysis);
            } catch (error) {
                console.error('Error building strategy:', error);
            }
        }

        function renderStrategyAnalysis(analysis) {
            const container = document.getElementById('strategyAnalysis');
            const chartContainer = document.getElementById('payoffChartContainer');

            if (!analysis || analysis.error) {
                container.innerHTML = `<p class="text-red-500 text-xs">Error: ${analysis?.error || 'Failed to load analysis'}</p>`;
                chartContainer.classList.add('hidden');
                return;
            }

            container.innerHTML = `
                <div class="space-y-4">
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                        <div class="bg-slate-900/50 rounded p-2">
                            <div class="text-[8px] text-gray-500 uppercase">Net Premium</div>
                            <div class="text-sm font-bold ${analysis.net_premium >= 0 ? 'text-green-500' : 'text-red-500'}">${analysis.net_premium > 0 ? '+' : ''}${analysis.net_premium}</div>
                        </div>
                        <div class="bg-slate-900/50 rounded p-2">
                            <div class="text-[8px] text-gray-500 uppercase">Max Profit</div>
                            <div class="text-sm font-bold text-green-500">${analysis.max_profit}</div>
                        </div>
                        <div class="bg-slate-900/50 rounded p-2">
                            <div class="text-[8px] text-gray-500 uppercase">Max Loss</div>
                            <div class="text-sm font-bold text-red-500">${analysis.max_loss}</div>
                        </div>
                        <div class="bg-slate-900/50 rounded p-2">
                            <div class="text-[8px] text-gray-500 uppercase">Breakeven</div>
                            <div class="text-sm font-bold text-blue-500">${analysis.breakeven_points?.length > 0 ? analysis.breakeven_points.map(b => Math.round(b)).join(', ') : '-'}</div>
                        </div>
                    </div>

                    <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                        <div class="bg-slate-900/50 rounded p-2">
                            <div class="text-[8px] text-gray-500 uppercase">Delta</div>
                            <div class="text-sm font-bold">${analysis.net_delta}</div>
                        </div>
                        <div class="bg-slate-900/50 rounded p-2">
                            <div class="text-[8px] text-gray-500 uppercase">Gamma</div>
                            <div class="text-sm font-bold">${analysis.net_gamma}</div>
                        </div>
                        <div class="bg-slate-900/50 rounded p-2">
                            <div class="text-[8px] text-gray-500 uppercase">Theta</div>
                            <div class="text-sm font-bold ${analysis.net_theta >= 0 ? 'text-green-500' : 'text-red-500'}">${analysis.net_theta}</div>
                        </div>
                        <div class="bg-slate-900/50 rounded p-2">
                            <div class="text-[8px] text-gray-500 uppercase">Vega</div>
                            <div class="text-sm font-bold">${analysis.net_vega}</div>
                        </div>
                    </div>

                    <div>
                        <h4 class="text-[9px] text-gray-400 uppercase mb-1">Legs</h4>
                        <div class="space-y-1">
                            ${analysis.legs?.map(leg => `
                                <div class="flex justify-between items-center bg-slate-900/50 rounded px-2 py-1 text-[10px]">
                                    <div class="flex gap-2">
                                        <span class="font-bold uppercase ${leg.position === 'long' ? 'text-blue-500' : 'text-orange-500'}">${leg.position}</span>
                                        <span>${leg.strike} ${leg.option_type.toUpperCase()}</span>
                                    </div>
                                    <div class="${leg.net_premium >= 0 ? 'text-green-500' : 'text-red-500'}">${leg.net_premium}</div>
                                </div>
                            `).join('') || ''}
                        </div>
                    </div>
                </div>
            `;

            if (analysis.payoff_chart_data) {
                chartContainer.classList.remove('hidden');
                renderPayoffChart(analysis.payoff_chart_data);
            } else {
                chartContainer.classList.add('hidden');
            }
        }

        function renderPayoffChart(data) {
            const ctx = document.getElementById('payoffChart').getContext('2d');

            const payoffLabels = data.prices.map(p => Math.round(p));
            const payoffData = data.pnl;

            if (charts.payoff) {
                charts.payoff.data.labels = payoffLabels;
                charts.payoff.data.datasets[0].data = payoffData;
                charts.payoff.update('none');
            } else {
                charts.payoff = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: payoffLabels,
                        datasets: [{
                            label: 'P&L',
                            data: payoffData,
                            borderColor: '#3b82f6',
                            backgroundColor: (context) => {
                                const chart = context.chart;
                                const {ctx, chartArea} = chart;
                                if (!chartArea) return null;
                                const zero = chart.scales.y.getPixelForValue(0);
                                const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                                const zeroPos = (zero - chartArea.top) / (chartArea.bottom - chartArea.top);
                                if (zeroPos > 0 && zeroPos < 1) {
                                    gradient.addColorStop(0, 'rgba(34, 197, 94, 0.2)');
                                    gradient.addColorStop(zeroPos, 'rgba(34, 197, 94, 0)');
                                    gradient.addColorStop(zeroPos, 'rgba(239, 68, 68, 0)');
                                    gradient.addColorStop(1, 'rgba(239, 68, 68, 0.2)');
                                }
                                return gradient;
                            },
                            fill: true,
                            tension: 0.3,
                            pointRadius: 0
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: { display: false },
                            tooltip: {
                                mode: 'index',
                                intersect: false,
                                callbacks: {
                                    label: (context) => `P&L: ${context.parsed.y.toFixed(2)}`
                                }
                            }
                        },
                        scales: {
                            x: {
                                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                                ticks: { color: '#64748b', font: { size: 8 } }
                            },
                            y: {
                                grid: { color: 'rgba(255, 255, 255, 0.05)' },
                                ticks: { color: '#64748b', font: { size: 8 } }
                            }
                        }
                    }
                });
            }
        }

        window.loadAlerts = async function() {
            const list = document.getElementById('alertsList');
            try {
                const response = await fetch(`/api/alerts?underlying=${currentUnderlying}`);
                const data = await response.json();

                if (!data.alerts || data.alerts.length === 0) {
                    list.innerHTML = '<p class="text-gray-500 text-xs">No active alerts for this underlying</p>';
                    return;
                }

                list.innerHTML = data.alerts.map(alert => `
                    <div class="glass-panel rounded p-3 flex justify-between items-center">
                        <div>
                            <div class="text-xs font-bold">${alert.name}</div>
                            <div class="text-[10px] text-gray-400">${alert.alert_type.replace(/_/g, ' ')}: ${alert.condition.threshold}</div>
                            <div class="text-[9px] ${alert.status === 'active' ? 'text-green-500' : 'text-yellow-500'} uppercase font-bold">${alert.status}</div>
                        </div>
                        <div class="flex gap-2">
                            ${alert.status === 'active'
                                ? `<button onclick="pauseAlert('${alert.id}')" class="text-yellow-500 text-[10px] font-bold uppercase">Pause</button>`
                                : `<button onclick="resumeAlert('${alert.id}')" class="text-green-500 text-[10px] font-bold uppercase">Resume</button>`
                            }
                            <button onclick="deleteAlert('${alert.id}')" class="text-red-500 text-[10px] font-bold uppercase">Delete</button>
                        </div>
                    </div>
                `).join('');
            } catch (error) {
                console.error('Error loading alerts:', error);
                list.innerHTML = '<p class="text-red-500 text-xs">Error loading alerts</p>';
            }
        }

        async function createAlert() {
            const name = document.getElementById('alertName').value;
            const type = document.getElementById('alertType').value;
            const threshold = parseFloat(document.getElementById('alertThreshold').value);

            if (!name || isNaN(threshold)) {
                showAlert('Please enter alert name and threshold');
                return;
            }

            try {
                const response = await fetch('/api/alerts/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: name,
                        alert_type: type,
                        underlying: currentUnderlying,
                        condition: { threshold: threshold },
                        cooldown_minutes: 15
                    })
                });

                const data = await response.json();
                if (data.status === 'success') {
                    showAlert('Alert created successfully');
                    window.loadAlerts();
                    // Clear inputs
                    document.getElementById('alertName').value = '';
                    document.getElementById('alertThreshold').value = '';
                }
            } catch (error) {
                console.error('Error creating alert:', error);
                showAlert('Failed to create alert');
            }
        }

        async function pauseAlert(id) {
            await fetch(`/api/alerts/${id}/pause`, { method: 'POST' });
            window.loadAlerts();
        }

        async function resumeAlert(id) {
            await fetch(`/api/alerts/${id}/resume`, { method: 'POST' });
            window.loadAlerts();
        }

        async function deleteAlert(id) {
            if (confirm('Are you sure you want to delete this alert?')) {
                await fetch(`/api/alerts/${id}`, { method: 'DELETE' });
                window.loadAlerts();
            }
        }

        // ==================== SCALPER LOGIC ====================

        window.updateScalperStatusUI = async function() {
            try {
                const response = await fetch('/api/scalper/status');
                const data = await response.json();

                const dot = document.getElementById('statusDot');
                const text = document.getElementById('statusText');
                const startBtn = document.getElementById('startScalperBtn');
                const stopBtn = document.getElementById('stopScalperBtn');

                if (data.is_running) {
                    dot.className = 'w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]';
                    text.textContent = 'Active: ' + data.underlying;
                    text.className = 'text-[10px] font-bold text-green-400 uppercase';
                    startBtn.classList.add('hidden');
                    stopBtn.classList.remove('hidden');
                } else {
                    dot.className = 'w-2 h-2 rounded-full bg-red-500';
                    text.textContent = 'Inactive';
                    text.className = 'text-[10px] font-bold text-gray-400 uppercase';
                    startBtn.classList.remove('hidden');
                    stopBtn.classList.add('hidden');
                }

                // Update active trades
                const tradesList = document.getElementById('activeTradesList');
                if (data.active_trades && data.active_trades.length > 0) {
                    tradesList.innerHTML = data.active_trades.map(t => `
                        <div class="bg-slate-900/50 border border-white/5 rounded p-2">
                            <div class="flex justify-between items-center mb-1">
                                <span class="text-[10px] font-black ${t.side === 'CALL' ? 'text-green-500' : 'text-red-500'}">${t.side}</span>
                                <span class="text-[10px] font-bold text-blue-400">LTP: ${t.last_price}</span>
                            </div>
                            <div class="flex justify-between text-[8px] text-gray-500">
                                <span>Entry: ${t.entry_price}</span>
                                <span>SL: ${t.sl}</span>
                                <span>TP: ${t.tp}</span>
                            </div>
                        </div>
                    `).join('');
                } else {
                    tradesList.innerHTML = '<p class="text-[10px] text-gray-500">No active trades</p>';
                }

            } catch (error) {
                console.error('Error updating scalper UI:', error);
            }
        }

        async function startScalper() {
            const underlying = document.getElementById('scalperUnderlying').value;
            try {
                const response = await fetch(`/api/scalper/start?underlying=${underlying}`, { method: 'POST' });
                const data = await response.json();
                window.updateScalperStatusUI();
            } catch (error) {
                console.error('Error starting scalper:', error);
            }
        }

        async function stopScalper() {
            try {
                const response = await fetch('/api/scalper/stop', { method: 'POST' });
                const data = await response.json();
                window.updateScalperStatusUI();
            } catch (error) {
                console.error('Error stopping scalper:', error);
            }
        }

        function showAlert(message) {
            // Simple alert - can be enhanced with toast notifications
            alert(message);
        }

        // Expose key functions globally for any external references or inline handlers
        window.buildStrategy = window.buildStrategy;
        window.loadAlerts = window.loadAlerts;
        window.updateScalperStatusUI = window.updateScalperStatusUI;
        window.renderBuildupSummary = window.renderBuildupSummary;
}
