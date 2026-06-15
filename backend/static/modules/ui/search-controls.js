// Globals: charts, activeChartIndex (provided by main.js)

/**
 * Initializes symbol search input with debounced API calls.
 */
export function initSearch() {
    const searchInput = document.getElementById('symbolSearch');
    const resultsDiv = document.getElementById('searchResults');
    if (!searchInput || !resultsDiv) return;
    let debounceTimer;

    searchInput.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        const text = e.target.value.trim();
        if (text.length < 2) { resultsDiv.classList.add('hidden'); return; }
        debounceTimer = setTimeout(async () => {
            try {
                const res = await fetch(`/api/tv/search?text=${encodeURIComponent(text)}`);
                const data = await res.json();
                const symbols = data.symbols || [];

                if (symbols.length > 0) displaySearchResults(symbols);
            } catch (err) { console.error("Search failed:", err); }
        }, 300);
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const symbol = searchInput.value.trim().toUpperCase();
            if (symbol) {
                const chart = charts[activeChartIndex];
                if (chart) chart.switchSymbol(symbol);
                resultsDiv.classList.add('hidden');
            }
        }
    });

    document.addEventListener('click', (e) => {
        if (!searchInput.contains(e.target) && !resultsDiv.contains(e.target))
            resultsDiv.classList.add('hidden');
    });
}

/**
 * Renders search results dropdown with click handlers.
 * @param {Array} symbols - Array of symbol objects from search API
 */
export function displaySearchResults(symbols) {
    const resultsDiv = document.getElementById('searchResults');
    if (!resultsDiv) return;
    resultsDiv.innerHTML = '';
    if (symbols.length === 0) { resultsDiv.classList.add('hidden'); return; }
    symbols.forEach(s => {
        const item = document.createElement('div');
        item.className = 'search-item px-3 py-2 cursor-pointer border-b border-white/5 last:border-0';
        const isOption = s.type === 'option' || s.symbol.includes('CE') || s.symbol.includes('PE');
        item.innerHTML = `
            <div class="flex items-center justify-between">
                <div class="text-[11px] font-black text-blue-400 tracking-tight">${s.symbol}</div>
                ${isOption ? '<span class="text-[8px] bg-blue-500/20 text-blue-400 px-1 rounded">OPTION</span>' : ''}
            </div>
            <div class="text-[9px] text-gray-300 uppercase truncate mt-0.5 font-semibold">${s.description} <span class="text-gray-500 mx-1">|</span> <span class="text-blue-500/80">${s.exchange}</span></div>
        `;
        item.addEventListener('click', () => {
            const cleanSymbol = s.symbol.replace(/<\/?[^>]+(>|$)/g, "");
            const fullSymbol = s.exchange ? `${s.exchange}:${cleanSymbol}` : cleanSymbol;
            document.getElementById('symbolSearch').value = cleanSymbol;
            resultsDiv.classList.add('hidden');
            const chart = charts[activeChartIndex];
            if (chart) chart.switchSymbol(fullSymbol);
        });
        resultsDiv.appendChild(item);
    });
    resultsDiv.classList.remove('hidden');
}