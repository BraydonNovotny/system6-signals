// LOCKED strategy rule (2026-07-28, "A2" in ll_backtest): when today's REALIZED loss (from
// already-resolved trades entered today) trips the -1R daily cap, close out any OTHER
// currently-open position (any entry day) that is down AT LEAST 0.25R as of TODAY'S OWN
// close -- no hindsight, only uses today's own actual closing price, nothing from the future.
// Passed the full curve-fit chain in ll_backtest: IS/OOS, parameter sweep (smooth, stable
// across -0.1R to -0.5R), lumpiness (clean, no concentration), and a 30-seed permutation test
// (p=0/30 on IS Sharpe, IS CAGR, OOS Sharpe, OOS CAGR). Backtest result: OOS CAGR 563.4% ->
// 608.0%, Sharpe 4.290 -> 4.430, maxDD IMPROVED 6.05% -> 5.59%.
//
// This mirrors the exclude_open_down_today mode in mcpt_engine_runner_step1.js exactly:
// dayLossR is the sum of TODAY's already-resolved losing trades' rMultiple; the reaction
// fires once that sum crosses -1R (matching the standard cap threshold most trades use).
const { fetchChart, ptDateString } = require('./lib');

const DOWN_THRESHOLD_R = -0.25;
const CAP_THRESHOLD = -1;
const LOOKBACK_DAYS = 10; // same window resolve_pending.js uses for "still open" positions

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

// Runs once, near market close (same EOD window as eod_add_winners.js). Looks at ALL
// currently open positions across recent days, not just today's -- a position carried over
// from a few days back is just as real an "already open when the cap trips" case as one
// entered this morning.
async function run(history) {
  const today = ptDateString();
  const todayDay = history[today];
  if (!todayDay) return [];

  const todayLossR = (todayDay.taken || [])
    .filter(t => t.resolved && t.rMultiple < 0)
    .reduce((a, t) => a + t.rMultiple, 0);
  if (todayLossR > CAP_THRESHOLD) return []; // cap hasn't tripped today -- nothing to do

  const days = Object.keys(history).sort().slice(-LOOKBACK_DAYS);
  const openPositions = [];
  for (const d of days) {
    for (const t of (history[d].taken || [])) {
      if (!t.resolved) openPositions.push({ day: d, trade: t });
    }
  }
  if (!openPositions.length) return [];

  const symbols = [...new Set(openPositions.map(p => p.trade.symbol))];
  const barsBySymbol = {};
  for (const sym of symbols) {
    try { barsBySymbol[sym] = await fetch30m(sym); } catch (e) { console.error(`cap-trigger-reaction fetch failed for ${sym}:`, e.message); }
  }

  const todayDayKeyPrefix = today; // 'YYYY-MM-DD', bars are matched by PT calendar date below
  const closedOut = [];
  for (const { day, trade } of openPositions) {
    const bars = barsBySymbol[trade.symbol];
    if (!bars || !bars.length) continue;
    // Today's own real bars for this symbol, in PT calendar terms.
    const todaysBars = bars.filter(b => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(b.time * 1000)) === todayDayKeyPrefix);
    if (!todaysBars.length) continue; // today hasn't traded yet for this symbol -- can't evaluate, skip
    const todaysClose = todaysBars[todaysBars.length - 1].close;

    const R = trade.side === 'long' ? (trade.entryPrice - trade.stopPrice) / trade.entryPrice : (trade.stopPrice - trade.entryPrice) / trade.entryPrice;
    if (R <= 0) continue;
    const ret = trade.side === 'long' ? (todaysClose - trade.entryPrice) / trade.entryPrice : (trade.entryPrice - todaysClose) / trade.entryPrice;
    const unrealizedR = ret / R;
    if (unrealizedR >= DOWN_THRESHOLD_R) continue; // not down enough (or up) -- leave it alone

    trade.resolved = true;
    trade.rMultiple = +unrealizedR.toFixed(2);
    trade.liveR = trade.rMultiple;
    trade.closedByCapReaction = true;
    closedOut.push({ symbol: trade.symbol, side: trade.side, entryDay: day, entryPrice: trade.entryPrice, rMultiple: trade.rMultiple, barTime: trade.barTime });
  }

  if (closedOut.length) {
    todayDay.closeAdjustments = todayDay.closeAdjustments || [];
    for (const c of closedOut) {
      todayDay.closeAdjustments.push({ type: 'closed_cap_reaction', symbol: c.symbol, side: c.side, entryPrice: c.entryPrice, rMultiple: c.rMultiple, barTime: c.barTime });
    }
  }
  return closedOut;
}

module.exports = { run };
