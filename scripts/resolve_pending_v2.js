// Re-checks not-yet-resolved "taken" trades and updates their result using the ACTUAL
// system's exit rule (simulate_exit_v2: stop-or-EOD-close, no chandelier/trail/add-winners --
// none of that applies to this system, which never holds past its own entry day).
const { fetchChart, pool, dropIncompleteBars } = require('./lib');
const { simulateExit } = require('./simulate_exit_v2');
const { loadHistory, saveHistory } = require('./history');

const LOOKBACK_DAYS = 10;

function ptDateOf(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(ts * 1000));
}

async function fetchLongRange30m(symbol) {
  const result = await fetchChart(symbol, 'range=1mo&interval=30m');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.volume[i] == null || q.open[i] == null) continue;
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] });
  }
  return dropIncompleteBars(bars, 1800);
}

async function run() {
  const history = loadHistory();
  const days = Object.keys(history).sort().slice(-LOOKBACK_DAYS);
  const pendingBySymbol = {};
  for (const d of days) {
    for (const t of (history[d].taken || [])) {
      if (!t.resolved) (pendingBySymbol[t.symbol] = pendingBySymbol[t.symbol] || []).push(t);
    }
  }
  const symbols = Object.keys(pendingBySymbol);
  if (!symbols.length) { console.log('No pending trades to resolve.'); return; }

  const results = await pool(symbols, fetchLongRange30m, 8);
  let resolvedCount = 0;
  symbols.forEach((sym, i) => {
    if (!results[i].ok) return;
    const bars = results[i].value;
    for (const trade of pendingBySymbol[sym]) {
      const r = simulateExit(trade.side, trade.entryPrice, trade.stopPrice, trade.barTime, bars, trade.tf);
      trade.liveR = r.liveR;
      if (r.resolved) { trade.resolved = true; trade.rMultiple = r.rMultiple; trade.gapped = r.gapped || false; resolvedCount++; }
    }
  });

  saveHistory(history);
  console.log(`Resolved ${resolvedCount} previously-pending trade(s) across ${symbols.length} symbol(s).`);
}

module.exports = { run };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
