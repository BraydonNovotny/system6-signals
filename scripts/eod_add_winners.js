// LOCKED strategy rule (mirrors ll_backtest/website_stats_final.js's ADD_WINNERS_MODE,
// confirmed across the entire locked stack IS+OOS): if a position entered TODAY is still
// open at the entry day's close AND already up >= 0.5R (mark-to-market), size it up to
// 1.5x total (i.e. add ~0.5x more). This is informational only -- it flags which of
// today's open trades qualify; the user still places the add manually.
const { fetchChart, ptDateString } = require('./lib');
const { simulateExit } = require('./simulate_exit');

const ADD_WINNERS_THRESHOLD_R = 0.5;
const ADD_WINNERS_MULT = 1.5;

async function fetch30m(symbol) {
  const result = await fetchChart(symbol, 'range=10d&interval=30m');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.open[i] == null) continue;
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] });
  }
  return bars;
}

// Runs once, near market close (called from the EOD window in run.js). Looks only at
// TRADES ENTERED TODAY that are still unresolved -- a trade that already stopped out or
// hit target by end of day isn't "still open at the close" and doesn't qualify, and a
// carried-over position from a prior day was already evaluated on ITS entry day.
async function run(history) {
  const today = ptDateString();
  const day = history[today];
  if (!day) return [];
  const openToday = (day.taken || []).filter(t => !t.resolved);
  if (!openToday.length) return [];

  const symbols = [...new Set(openToday.map(t => t.symbol))];
  const barsBySymbol = {};
  for (const sym of symbols) {
    try { barsBySymbol[sym] = await fetch30m(sym); } catch (e) { console.error(`add-winners fetch failed for ${sym}:`, e.message); }
  }

  const addWinners = [];
  for (const t of openToday) {
    const bars = barsBySymbol[t.symbol];
    if (!bars) continue;
    const r = simulateExit(t.side, t.entryPrice, t.stopPrice, t.barTime, bars, t.tf);
    if (r.liveR != null && r.liveR >= ADD_WINNERS_THRESHOLD_R) {
      addWinners.push({ symbol: t.symbol, side: t.side, entryPrice: t.entryPrice, barTime: t.barTime, liveR: r.liveR, addMult: ADD_WINNERS_MULT });
    }
  }
  day.addWinners = addWinners;
  day.closeAdjustments = day.closeAdjustments || [];
  for (const w of addWinners) {
    day.closeAdjustments.push({ type: 'sized_up', symbol: w.symbol, side: w.side, entryPrice: w.entryPrice, barTime: w.barTime, liveR: w.liveR, addMult: w.addMult });
  }
  return addWinners;
}

module.exports = { run };
