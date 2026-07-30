// LOCKED strategy rule (2026-07-29, "dist-top" rule in ll_backtest): at end of day, if QQQ shows
// 3 consecutive days of ascending highs, each an up (blue) bar, on DESCENDING volume, while QQQ
// hasn't touched its own 8ema in 3+ days -- rising price on shrinking participation, a classic
// exhaustion/distribution signature -- force-close any currently open LONG position. Also blocks
// NEW long entries the following trading day (see RULE_DISTTOP_ENTRY_BLOCK in scan_entries.js).
// Uses only TODAY's own now-known daily close -- no future data, no hindsight, decided at EOD
// exactly like the already-live eod_724_exit.js / eod_cap_trigger_reaction.js.
//
// Traced directly to the real 2026-06-02 drawdown (the OOS system's single worst one): QQQ's
// 5/29->6/1->6/2 highs rose 741.63<745.65<746.44, all blue bars, volume fell 37.5M>33.9M>30.1M,
// 7 days since an 8ema touch -- then QQQ dropped 740->705 (-4.8%) over the next 3 days, entirely
// from long positions taken right into the top. Passed the full 4-step overfitting check in
// ll_backtest: IS/OOS, a parameter sweep (days-since-touch 1-8, days=3 picked -- entryBlock
// specifically improves monotonically with MORE days, unlike the fade variants), lumpiness
// (broad-based, top-10 trades <10% of total R), and a 30-seed permutation test (p=0/30 on IS
// Sharpe, IS CAGR, OOS Sharpe, OOS CAGR). Stacked on the real 4-combo baseline: 619.4%->639.8%
// CAGR (+20.4pts), and the only lever this cycle to also improve max drawdown (5.59%->5.53%).
const { fetchChart, ptDateString } = require('./lib');
const { emaSeries } = require('../vendor/strategy-core/indicators.js');
// Dist-top day detection now lives in the shared strategy-core submodule -- see
// vendor/strategy-core/disttop.js. Do NOT duplicate this logic here (or in scan_entries.js's
// entry-block); update the submodule instead so the EOD-close and next-day entry-block can
// never disagree on what counts as a dist-top day.
const { isDistTopDay: isDistTopDayShared } = require('../vendor/strategy-core/disttop.js');

const LOOKBACK_DAYS = 10; // same window resolve_pending.js/eod_724_exit.js use for "still open" positions

async function fetchQqqDaily() {
  const result = await fetchChart('QQQ', 'range=2y&interval=1d');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.volume[i] == null || q.open[i] == null) continue;
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] });
  }
  return bars;
}

async function fetch30m(symbol) {
  const result = await fetchChart(symbol, 'range=10d&interval=30m');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    bars.push({ time: ts[i], close: q.close[i] });
  }
  return bars;
}

// Is TODAY (QQQ's own last daily bar) a dist-top day? Checked using QQQ's OWN daily bars --
// since this runs at EOD, today's own high/close/volume are already fully known. Delegates to
// the shared strategy-core implementation (see import above).
async function isDistTopDay() {
  const bars = await fetchQqqDaily();
  if (bars.length < 30) return false;
  const closes = bars.map(b => b.close);
  const ema8 = emaSeries(closes, 8);
  return isDistTopDayShared(bars, ema8, bars.length - 1);
}

// Runs once, near market close (same EOD window as eod_724_exit.js). Closes ALL currently open
// LONG positions across recent days if today is a dist-top day.
async function run(history) {
  const today = ptDateString();
  const todayDay = history[today];
  if (!todayDay) return [];

  if (!(await isDistTopDay())) return [];

  const days = Object.keys(history).sort().slice(-LOOKBACK_DAYS);
  const openLongs = [];
  for (const d of days) {
    for (const t of (history[d].taken || [])) {
      if (!t.resolved && t.side === 'long') openLongs.push({ day: d, trade: t });
    }
  }
  if (!openLongs.length) return [];

  const symbols = [...new Set(openLongs.map(p => p.trade.symbol))];
  const barsBySymbol = {};
  for (const sym of symbols) {
    try { barsBySymbol[sym] = await fetch30m(sym); } catch (e) { console.error(`disttop-exit fetch failed for ${sym}:`, e.message); }
  }

  const closedOut = [];
  for (const { day, trade } of openLongs) {
    const bars = barsBySymbol[trade.symbol];
    if (!bars || !bars.length) continue;
    const todaysBars = bars.filter(b => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(b.time * 1000)) === today);
    if (!todaysBars.length) continue;
    const todaysClose = todaysBars[todaysBars.length - 1].close;

    const R = (trade.entryPrice - trade.stopPrice) / trade.entryPrice;
    if (R <= 0) continue;
    const ret = (todaysClose - trade.entryPrice) / trade.entryPrice;
    const rMultiple = ret / R;

    trade.resolved = true;
    trade.rMultiple = +rMultiple.toFixed(2);
    trade.liveR = trade.rMultiple;
    trade.closedByDistTop = true;
    closedOut.push({ symbol: trade.symbol, side: trade.side, entryDay: day, entryPrice: trade.entryPrice, rMultiple: trade.rMultiple, barTime: trade.barTime });
  }

  if (closedOut.length) {
    todayDay.closeAdjustments = todayDay.closeAdjustments || [];
    for (const c of closedOut) {
      todayDay.closeAdjustments.push({ type: 'closed_disttop_rule', symbol: c.symbol, side: c.side, entryPrice: c.entryPrice, rMultiple: c.rMultiple, barTime: c.barTime });
    }
  }
  return closedOut;
}

module.exports = { run, isDistTopDay };
