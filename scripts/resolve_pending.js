// Re-checks any not-yet-resolved "taken" trades from recent days (not just today) and
// updates their result in place once enough forward bars exist to determine the outcome.
// Does NOT re-run the account filter itself (who got "taken" on a given day is fixed once
// decided) -- only fills in the resolved/rMultiple fields as new bars arrive.
const { fetchChart, pool } = require('./lib');
const { simulateExit } = require('./simulate_exit');
const { loadHistory, saveHistory } = require('./history');

const LOOKBACK_DAYS = 10; // how many recent days to keep re-checking for pending trades

async function fetchLongRange30m(symbol) {
  const result = await fetchChart(symbol, 'range=1mo&interval=30m');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.volume[i] == null || q.open[i] == null) continue;
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] });
  }
  return bars;
}

async function run() {
  const history = loadHistory();
  const days = Object.keys(history).sort().slice(-LOOKBACK_DAYS);
  const pendingBySymbol = {};
  for (const d of days) {
    for (const t of (history[d].taken || [])) {
      if (!t.resolved) { (pendingBySymbol[t.symbol] = pendingBySymbol[t.symbol] || []).push({ day: d, trade: t }); }
    }
  }
  const symbols = Object.keys(pendingBySymbol);
  if (!symbols.length) { console.log('No pending trades to resolve.'); return; }

  const results = await pool(symbols, fetchLongRange30m, 8);
  let resolvedCount = 0;
  symbols.forEach((sym, i) => {
    if (!results[i].ok) return;
    const bars = results[i].value;
    for (const { trade } of pendingBySymbol[sym]) {
      const r = simulateExit(trade.side, trade.entryPrice, trade.stopPrice, trade.barTime, bars);
      trade.liveR = r.liveR;
      if (r.resolved) { trade.resolved = true; trade.rMultiple = r.rMultiple; resolvedCount++; }
    }
  });

  saveHistory(history);
  console.log(`Resolved ${resolvedCount} previously-pending trade(s) across ${symbols.length} symbol(s).`);
}

module.exports = { run };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
