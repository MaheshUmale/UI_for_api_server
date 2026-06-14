/**
 * PRODESK Utility Formatters
 * Shared formatting, color, and normalization helpers.
 */

export function formatIST(ts) {
    if (!ts) return '-';
    const date = new Date(ts);
    return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(date);
}

export function normalizeSymbol(sym) {
    if (!sym) return "";
    let s = String(sym).toUpperCase().trim();
    if (s.includes(':')) s = s.split(':')[1];
    if (s.includes('|')) s = s.split('|')[1];
    return s.split(' ')[0]
        .replace("NIFTY 50", "NIFTY")
        .replace("BANK NIFTY", "BANKNIFTY")
        .replace("FIN NIFTY", "FINNIFTY");
}

export function rgbaToHex(rgba) {
    if (!rgba) return '#3b82f6';
    if (rgba.startsWith('#')) return rgba;
    const parts = rgba.match(/[\d.]+/g);
    if (!parts || parts.length < 3) return '#3b82f6';
    const r = parseInt(parts[0]);
    const g = parseInt(parts[1]);
    const b = parseInt(parts[2]);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

export function tvColorToRGBA(color) {
    if (color === null || color === undefined) return null;
    if (typeof color === 'string') return color;
    if (typeof color === 'number') {
        const uColor = color >>> 0;
        const a = ((uColor >> 24) & 0xFF) / 255;
        const r = (uColor >> 16) & 0xFF;
        const g = (uColor >> 8) & 0xFF;
        const b = uColor & 0xFF;
        const alpha = ((uColor >> 24) & 0xFF) === 0 ? 1.0 : a;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return null;
}

export function applyRvolColoring(candles) {
    if (candles.length < 2) return candles;
    const volumes = candles.map(c => c.volume || 0);
    const period = Math.min(20, candles.length);
    const sma = [];
    for (let i = 0; i < candles.length; i++) {
        if (i < period - 1) { sma.push(null); continue; }
        let sum = 0;
        for (let j = 0; j < period; j++) sum += volumes[i - j];
        sma.push(sum / period);
    }
    return candles.map((c, i) => {
        const s = sma[i];
        if (!s || s === 0) return c;
        const volPct = c.volume / s;
        const isUp = c.close >= c.open;
        let cCol;
        if (volPct >= 3) cCol = isUp ? '#007504' : 'rgb(137, 1, 1)';
        else if (volPct >= 2) cCol = isUp ? 'rgb(3, 179, 9)' : '#d30101';
        else {
            let op = volPct >= 1.6 ? 0.9 : volPct >= 1.2 ? 0.7 : volPct >= 0.8 ? 0.4 : volPct >= 0.5 ? 0.2 : 0.1;
            cCol = `rgba(${isUp ? 3 : 211}, ${isUp ? 179 : 1}, ${isUp ? 9 : 1}, ${op})`;
        }
        return { ...c, color: cCol, wickColor: cCol, borderColor: cCol };
    });
}

export function setLoading(show) {
    const loadingDom = document.getElementById('loading');
    if (loadingDom) loadingDom.classList.toggle('hidden', !show);
}
