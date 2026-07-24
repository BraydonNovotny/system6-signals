// LOCKED strategy rule (mirrors ll_backtest's close-position filter -- the single biggest,
// cleanest win found in the whole research build): a position's entry day has its own close
// checked against its own daily range. If it closed in the weak 20% of that range while
// LONG, or the strong 20% while SHORT, the setup didn't confirm -- exit AT THE CLOSE rather
// than continuing to hold overnight into the normal stop/target/trail simulation.
//
// This can't be evaluated at entry time (you don't know where today will close yet), so
// unlike a pre-entry filter it's a same-day EOD exit check: every trade entered TODAY that's
// still open gets evaluated once, right after the close, and force-closed if it fails.
const { fetchChart, ptDateString } = require('./lib');

const CLOSEPOS_MIN = 0.20;

async function fetch30m(symbol) {
  const result = await fetchChart(symbol, 'range=5d&interval=30m');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.open[i] == null) continue;
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] });
  }
  return bars;
}

// Runs once, near market close (same EOD window as eod_add_winners.js / scan_roster.js).
// Only affects TRADES ENTERED TODAY that are still unresolved -- a trade already stopped
// out or hit target intraday resolves on its own merits, unaffected by this check.
async function run(history) {
  const today = ptDateString();
  const day = history[today];
  if (!day) return [];
  const openToday = (day.taken || []).filter(t => !t.resolved);
  if (!openToday.length) return [];

  const symbols = [...new Set(openToday.map(t => t.symbol))];
  const barsBySymbol = {};
  for (const sym of symbols) {
    try { barsBySymbol[sym] = await fetch30m(sym); } catch (e) { console.error(`close-pos check fetch failed for ${sym}:`, e.message); }
  }

  const closedOut = [];
  for (const t of openToday) {
    const bars = barsBySymbol[t.symbol];
    if (!bars || !bars.length) continue;
    // today's session: all bars from entry time through the most recent fetched bar
    const todaysBars = bars.filter(b => b.time >= t.barTime);
    if (!todaysBars.length) continue;
    const high = Math.max(...todaysBars.map(b => b.high));
    const low = Math.min(...todaysBars.map(b => b.low));
    const lastClose = todaysBars[todaysBars.length - 1].close;
    const range = high - low;
    const closePos = range > 0 ? (lastClose - low) / range : 0.5;

    const failed = t.side === 'long' ? closePos < CLOSEPOS_MIN : closePos > (1 - CLOSEPOS_MIN);
    if (!failed) continue;

    const R = t.side === 'long' ? (t.entryPrice - t.stopPrice) / t.entryPrice : (t.stopPrice - t.entryPrice) / t.entryPrice;
    const ret = t.side === 'long' ? (lastClose - t.entryPrice) / t.entryPrice : (t.entryPrice - lastClose) / t.entryPrice;
    t.resolved = true;
    t.rMultiple = R > 0 ? +(ret / R).toFixed(2) : 0;
    t.liveR = t.rMultiple;
    t.closedByClosePosRule = true;
    closedOut.push({ symbol: t.symbol, side: t.side, closePos: +closePos.toFixed(2), rMultiple: t.rMultiple });
  }
  if (closedOut.length) {
    day.closeAdjustments = day.closeAdjustments || [];
    for (const c of closedOut) {
      const t = openToday.find(x => x.symbol === c.symbol && x.side === c.side);
      day.closeAdjustments.push({ type: 'closed', symbol: c.symbol, side: c.side, entryPrice: t?.entryPrice, barTime: t?.barTime, rMultiple: c.rMultiple, closePos: c.closePos });
    }
  }
  return closedOut;
}

module.exports = { run };
