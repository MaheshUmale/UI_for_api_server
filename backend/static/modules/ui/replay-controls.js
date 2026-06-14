// Globals: charts, activeChartIndex, updateReplayUI (provided by main.js)

/**
 * Initializes replay mode controls (play/pause/next/prev/exit).
 */
export function initReplayControls() {
    const replayModeBtn = document.getElementById('replayModeBtn');
    const exitReplayBtn = document.getElementById('exitReplayBtn');
    const replayNextBtn = document.getElementById('replayNextBtn');
    const replayPrevBtn = document.getElementById('replayPrevBtn');
    const replayPlayBtn = document.getElementById('replayPlayBtn');

    replayModeBtn?.addEventListener('click', () => {
        const chart = charts[activeChartIndex];
        if (!chart) return;
        chart.isReplayMode = true;
        chart.loadReplayHistory();
        document.getElementById('normalControls')?.classList.add('hidden');
        document.getElementById('replayControls')?.classList.remove('hidden');
        document.getElementById('replayStatus').innerText = 'SELECT START POINT';
        ['replayPlayBtn', 'replayNextBtn', 'replayPrevBtn'].forEach(id => {
            document.getElementById(id).disabled = true;
        });
    });

    exitReplayBtn?.addEventListener('click', () => {
        const chart = charts[activeChartIndex];
        if (!chart) return;
        chart.isPlaying = false;
        chart.isReplayMode = false;
        chart.replayIndex = -1;
        if (chart.replayRafId) cancelAnimationFrame(chart.replayRafId);
        chart.replayRafId = null;
        document.getElementById('replayControls')?.classList.add('hidden');
        document.getElementById('normalControls')?.classList.remove('hidden');
        chart.renderData();
    });

    replayNextBtn?.addEventListener('click', () => {
        const chart = charts[activeChartIndex];
        if (chart) chart.stepReplay(1);
    });

    replayPrevBtn?.addEventListener('click', () => {
        const chart = charts[activeChartIndex];
        if (chart) chart.stepReplay(-1);
    });

    replayPlayBtn?.addEventListener('click', () => {
        const chart = charts[activeChartIndex];
        if (!chart) return;
        if (chart.isPlaying) {
            chart.isPlaying = false;
            if (chart.replayRafId) cancelAnimationFrame(chart.replayRafId);
            chart.replayRafId = null;
        } else {
            chart.isPlaying = true;
            const stepDelay = 1000;
            let lastStepTime = performance.now();

            function replayLoop(now) {
                if (!chart.isPlaying) return;
                if (now - lastStepTime >= stepDelay) {
                    lastStepTime = now;
                    if (chart.replayIndex < chart.fullHistory.candles.size - 1) {
                        chart.stepReplay(1);
                    } else {
                        chart.isPlaying = false;
                        updateReplayUI(chart);
                        chart.replayRafId = null;
                        return;
                    }
                }
                chart.replayRafId = requestAnimationFrame(replayLoop);
            }
            chart.replayRafId = requestAnimationFrame(replayLoop);
        }
        updateReplayUI(chart);
    });
}

/**
 * Updates replay UI state (buttons, icons, status text).
 * @param {Object} chart - Chart instance to update UI for
 */
export function updateReplayUI(chart) {
    if (chart.index !== activeChartIndex) return;

    const playBtn = document.getElementById('replayPlayBtn');
    const nextBtn = document.getElementById('replayNextBtn');
    const prevBtn = document.getElementById('replayPrevBtn');
    const playIcon = document.getElementById('playIcon');
    const pauseIcon = document.getElementById('pauseIcon');
    const statusEl = document.getElementById('replayStatus');

    if (playBtn) playBtn.disabled = !chart.isReplayMode || chart.replayIndex === -1;
    if (nextBtn) nextBtn.disabled = !chart.isReplayMode || chart.replayIndex === -1;
    if (prevBtn) prevBtn.disabled = !chart.isReplayMode || chart.replayIndex === -1;

    if (playIcon) playIcon.classList.toggle('hidden', chart.isPlaying);
    if (pauseIcon) pauseIcon.classList.toggle('hidden', !chart.isPlaying);

    if (chart.replayIndex !== -1 && statusEl) {
        statusEl.innerText = `BAR ${chart.replayIndex + 1} / ${chart.fullHistory.candles.size}`;
    }
}
