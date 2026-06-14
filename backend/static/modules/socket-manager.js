/**
 * PRODESK Socket Manager
 * Handles Socket.IO connection lifecycle and real-time event routing.
 */

export let socket = null;

export function initSocketConnection() {
    if (typeof io === 'undefined') return null;
    return io();
}

export function initSocket() {
    if (socket) return;
    socket = initSocketConnection();
    if (!socket) return;

    socket.on('connect', () => {
        console.log("Socket connected");
        charts.forEach(c => socket.emit('subscribe', { instrumentKeys: [c.symbol], interval: c.interval }));
    });

    socket.on('raw_tick', (data) => {
        for (const [key, quote] of Object.entries(data)) {
            const incomingKey = key.toUpperCase();
            charts.forEach(c => {
                // Strict match on technical instrument key to avoid data mixups
                if (c.symbol && c.symbol.toUpperCase() === incomingKey) {
                    c.updateRealtimeCandle(quote);
                }
            });
        }
    });

    socket.on('scalper_metrics', (data) => {
        if (!showAnalysisSidebar) return;
        const sideScalper = document.getElementById('sidebarScalper');
        if (sideScalper) sideScalper.classList.remove('hidden');

        const pcrEl = document.getElementById('side-pcr');
        const powerEl = document.getElementById('side-power');
        if (pcrEl) pcrEl.textContent = data.pcr;
        if (powerEl) powerEl.textContent = data.oi_power;

        const updateDot = (id, active) => {
            const dot = document.getElementById(id);
            if (!dot) return;
            if (active) {
                dot.classList.remove('bg-gray-200');
                dot.classList.add('bg-blue-500');
            } else {
                dot.classList.add('bg-gray-200');
                dot.classList.remove('bg-blue-500');
            }
        };
        updateDot('conf-lvl-dot', data.confluence.lvl);
        updateDot('conf-pcr-dot', data.confluence.pcr);
        updateDot('conf-oi-dot', data.confluence.oi);
        updateDot('conf-brk-dot', data.confluence.opt_brk);
        updateDot('conf-inv-dot', data.confluence.inv_dwn);
    });

    socket.on('scalper_log', (data) => {
        const logList = document.getElementById('sideLogsList');
        if (!logList) return;
        const msg = data.message || `[${data.time}] ${data.signal} @ ${data.underlying_level}`;
        const p = document.createElement('p');
        p.className = 'border-b border-black/5 last:border-0 py-1';
        if (msg.includes('BUY')) p.className += ' text-green-600 font-bold';
        else if (msg.includes('CLOSED')) p.className += ' text-blue-600';
        else p.className += ' text-gray-500';
        p.textContent = msg;
        logList.prepend(p);
        if (logList.children.length > 50) logList.lastElementChild.remove();
    });

    socket.on('brain_signal', (data) => {
        const logList = document.getElementById('sideLogsList');
        if (!logList) return;
        const timeStr = new Date().toLocaleTimeString('en-IN', { hour12: false });
        const msg = `[BRAIN] ${timeStr} | ${data.type} @ ${data.price} (${data.reason})`;
        const p = document.createElement('p');
        p.className = 'border-b border-black/5 last:border-0 py-1 text-purple-600 font-black';
        p.textContent = msg;
        logList.prepend(p);
        if (logList.children.length > 50) logList.lastElementChild.remove();
        if (data.confidence > 0.8) {
            console.warn("HIGH CONVICTION BRAIN SIGNAL:", data);
        }
    });

    socket.on('chart_update', (data) => {
        const updateKey = (data.instrumentKey || "").toUpperCase();
        const updateInterval = String(data.interval || "");
        charts.forEach(c => {
            // Strict match on technical instrument key and interval
            if (c.symbol && c.symbol.toUpperCase() === updateKey && String(c.interval) === updateInterval) {
                c.handleChartUpdate(data);
            }
        });
    });
}

export async function fetchIntraday(key, interval) {
    try {
        const res = await fetch(`/api/tv/intraday/${encodeURIComponent(key)}?interval=${interval}`);
        const data = await res.json();
        if (data && data.candles) {
            data.candles = data.candles.map(c => ({
                timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
            })).reverse();
            return data;
        }
        return { hrn: '', candles: [], indicators: [] };
    } catch (err) {
        console.warn("Fetch intraday failed:", err);
        return { candles: [], indicators: [] };
    }
}
