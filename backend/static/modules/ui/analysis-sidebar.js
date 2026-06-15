// Globals: charts, activeChartIndex, showAnalysisSidebar (provided by main.js)

let _sidebarRefreshInterval = null;

/**
 * Initializes analysis sidebar toggle and OI profile toggle.
 * Sets up auto-refresh every 60 seconds when sidebar is visible.
 */
export function initAnalysisSidebar() {
    const toggle = document.getElementById('analysisToggle');
    const sidebar = document.getElementById('analysisSidebar');
    const closeBtn = document.getElementById('closeAnalysisBtn');
    const oiToggle = document.getElementById('oiProfileToggle');

    toggle?.addEventListener('change', () => {
        showAnalysisSidebar = toggle.checked;
        sidebar?.classList.toggle('hidden', !showAnalysisSidebar);
        if (showAnalysisSidebar) updateAnalysisSidebar();
    });

    closeBtn?.addEventListener('click', () => {
        if (toggle) toggle.checked = false;
        sidebar?.classList.add('hidden');
        showAnalysisSidebar = false;
    });

    oiToggle?.addEventListener('change', () => {
        charts.forEach(c => {
            c.showOiProfile = oiToggle.checked;
            if (c.showOiProfile) c.fetchOiProfile();
            else c.renderOiProfile();
        });
    });

    // Auto refresh sidebar every 60s
    if (_sidebarRefreshInterval) clearInterval(_sidebarRefreshInterval);
    _sidebarRefreshInterval = setInterval(() => {
        if (showAnalysisSidebar) updateAnalysisSidebar();
    }, 60000);
}

/**
 * Fetches and renders genie insights and OI buildup in sidebar.
 */
export async function updateAnalysisSidebar() {
    if (!showAnalysisSidebar) return;
    const chart = charts[activeChartIndex];
    if (!chart) return;

    try {
        const [genie, buildup] = await Promise.all([
            fetch(`/api/options/genie-insights/${encodeURIComponent(chart.symbol)}`).then(r => r.json()),
            fetch(`/api/options/oi-buildup/${encodeURIComponent(chart.symbol)}`).then(r => r.json())
        ]);

        renderSidebarGenie(genie);
        renderSidebarBuildup(buildup);
    } catch (e) { console.error("Sidebar update failed:", e); }
}

/**
 * Renders genie control data in the sidebar.
 * @param {Object} data - Genie insights data
 */
export function renderSidebarGenie(data) {
    const controlEl = document.getElementById('genieControl');
    const statusEl = document.getElementById('genieStatus');
    const rangeEl = document.getElementById('genieRange');
    const pcrEl = document.getElementById('sideCurrentPcr');

    if (controlEl) {
        controlEl.textContent = (data.control || "").replace(/_/g, ' ');
        if (data.control === 'BUYERS_IN_CONTROL') controlEl.className = 'text-xs font-black text-green-600 uppercase';
        else if (data.control === 'SELLERS_IN_CONTROL') controlEl.className = 'text-xs font-black text-red-600 uppercase';
        else controlEl.className = 'text-xs font-black text-gray-800 uppercase';
    }

    if (statusEl) statusEl.textContent = data.distribution?.status || "-";
    if (rangeEl) rangeEl.textContent = `RANGE: ${data.boundaries?.lower || "-"} - ${data.boundaries?.upper || "-"}`;

    if (pcrEl) {
        const pcr = data.pcr || 0;
        pcrEl.textContent = pcr.toFixed(2);
        pcrEl.className = `text-[9px] font-black ${pcr > 1.3 ? 'text-red-500' : pcr > 1.1 ? 'text-red-400' : pcr < 0.7 ? 'text-green-500' : pcr < 0.9 ? 'text-green-400' : 'text-blue-500'}`;
    }
}

/**
 * Renders OI buildup pattern distribution in the sidebar.
 * @param {Object} data - OI buildup data
 */
export function renderSidebarBuildup(data) {
    const container = document.getElementById('buildupSummary');
    if (!container) return;
    container.innerHTML = '';
    const patterns = data.summary?.pattern_distribution || {};

    Object.entries(patterns).forEach(([p, count]) => {
        const div = document.createElement('div');
        div.className = 'p-2 bg-gray-100 rounded border border-black/5 text-center';
        let color = 'text-gray-500';
        if (p.includes('Long Buildup')) color = 'text-green-600';
        if (p.includes('Short Buildup')) color = 'text-red-600';
        if (p.includes('Short Covering')) color = 'text-blue-600';
        if (p.includes('Long Unwinding')) color = 'text-orange-600';

        div.innerHTML = `
            <div class="text-[7px] text-gray-400 uppercase font-black truncate">${p}</div>
            <div class="text-xs font-black ${color}">${count}</div>
        `;
        container.appendChild(div);
    });
}