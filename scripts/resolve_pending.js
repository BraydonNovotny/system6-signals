// Re-checks any not-yet-resolved "taken" trades from recent days (not just today) and
// updates their result in place once enough forward bars exist to determine the outcome.
// Does NOT re-run the account filter itself (who got "taken" on a given day is fixed once
// decided) -- only fills in the resolved/rMultiple fields as new bars arrive.
//
// BUG FIX (found by direct user question, confirmed 0 trades had EVER been closed by the
// close-position rule across the entire live history): this function's natural exit sim
// has its own max-hold-cap (13 bars ~= one trading day) that force-closes a trade at end
// of its entry day via the blended target/chandelier fallback -- and since this runs on
// EVERY market-hours cycle, it was beating eod_close_position_check.js's dedicated
// 13:15-15:00 PT window to the punch for any trade entered early enough that its 13-bar
// cap lands at/before market close (13:00 PT) -- i.e. most morning entries. The close-
// position rule was effectively dead code. Fix: check close-position FIRST, right here,
// for any pending trade whose entry day has already closed -- before letting the natural
// cap-based fallback resolve it via the wrong rule.
const { fetchChart, pool } = require('./lib');
const { simulateExit } = require('./simulate_exit');
const { loadHistory, saveHistory } = require('./history');

const LOOKBACK_DAYS = 10; // how many recent days to keep re-checking for pending trades
const CLOSEPOS_MIN = 0.20;
const MARKET_CLOSE_DECIMAL_HOUR = 13.0; // 1:00pm PT

function ptDateOf(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(ts * 1000));
}
function ptNowDecimalHour() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: 'numeric', minute: 'numeric' }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  return (parseInt(get('hour'), 10) % 24) + parseInt(get('minute'), 10) / 60;
}

// Has this trade's own entry day's market session actually closed yet? (Either it's a
// past calendar day, or it's today and we're at/after 1:00pm PT.)
function entryDaySessionClosed(barTime, todayStr) {
  const entryDay = ptDateOf(barTime);
  if (entryDay < todayStr) return true;
  if (entryDay > todayStr) return false;
  return ptNowDecimalHour() >= MARKET_CLOSE_DECIMAL_HOUR;
}

// Same-day closePos override -- mirrors eod_close_position_check.js exactly, just called
// from a place that's guaranteed to run before the natural cap can beat it to resolving.
function checkClosePosition(trade, bars) {
  const entryDay = ptDateOf(trade.barTime);
  const entryDayBars = bars.filter(b => ptDateOf(b.time) === entryDay && b.time >= trade.barTime);
  if (!entryDayBars.length) return null;
  const high = Math.max(...entryDayBars.map(b => b.high));
  const low = Math.min(...entryDayBars.map(b => b.low));
  const lastClose = entryDayBars[entryDayBars.length - 1].close;
  const range = high - low;
  const closePos = range > 0 ? (lastClose - low) / range : 0.5;
  const failed = trade.side === 'long' ? closePos < CLOSEPOS_MIN : closePos > (1 - CLOSEPOS_MIN);
  if (!failed) return null;
  const R = trade.side === 'long' ? (trade.entryPrice - trade.stopPrice) / trade.entryPrice : (trade.stopPrice - trade.entryPrice) / trade.entryPrice;
  const ret = trade.side === 'long' ? (lastClose - trade.entryPrice) / trade.entryPrice : (trade.entryPrice - lastClose) / trade.entryPrice;
  return { rMultiple: R > 0 ? +(ret / R).toFixed(2) : 0, closePos: +closePos.toFixed(2) };
}

// SAME BUG, other half: eod_add_winners.js only flags a trade if it's still !resolved when
// its dedicated EOD window runs -- but the natural cap-based force-close (below, same
// entry-day boundary) can resolve it first. Snapshot the add-winners mark-to-market R
// check right here, once, at the entry-day-close boundary, non-destructively (this does
// NOT resolve the trade -- it's informational only, same as the original).
const ADD_WINNERS_THRESHOLD_R = 0.5, ADD_WINNERS_MULT = 1.5;
function checkAddWinners(trade, bars) {
  const entryDay = ptDateOf(trade.barTime);
  const entryDayBars = bars.filter(b => ptDateOf(b.time) === entryDay && b.time >= trade.barTime);
  if (!entryDayBars.length) return null;
  const lastClose = entryDayBars[entryDayBars.length - 1].close;
  const R = trade.side === 'long' ? (trade.entryPrice - trade.stopPrice) / trade.entryPrice : (trade.stopPrice - trade.entryPrice) / trade.entryPrice;
  if (R <= 0) return null;
  const ret = trade.side === 'long' ? (lastClose - trade.entryPrice) / trade.entryPrice : (trade.entryPrice - lastClose) / trade.entryPrice;
  const liveR = +(ret / R).toFixed(2);
  if (liveR < ADD_WINNERS_THRESHOLD_R) return null;
  return { liveR };
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
  return bars;
}

async function run() {
  const history = loadHistory();
  const todayStr = ptDateOf(Date.now() / 1000);
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
  let resolvedCount = 0, closedByCpCount = 0;
  symbols.forEach((sym, i) => {
    if (!results[i].ok) return;
    const bars = results[i].value;
    for (const { trade } of pendingBySymbol[sym]) {
      // Close-position gets first refusal, but ONLY once its own entry day has actually
      // closed -- otherwise we'd be judging an unfinished day's range.
      if (entryDaySessionClosed(trade.barTime, todayStr)) {
        const cp = checkClosePosition(trade, bars);
        if (cp) {
          trade.resolved = true;
          trade.rMultiple = cp.rMultiple;
          trade.liveR = cp.rMultiple;
          trade.closedByClosePosRule = true;
          resolvedCount++; closedByCpCount++;
          const entryDay = ptDateOf(trade.barTime);
          history[entryDay] = history[entryDay] || {};
          history[entryDay].closeAdjustments = history[entryDay].closeAdjustments || [];
          history[entryDay].closeAdjustments.push({ type: 'closed', symbol: trade.symbol, side: trade.side, entryPrice: trade.entryPrice, barTime: trade.barTime, rMultiple: cp.rMultiple, closePos: cp.closePos });
          continue;
        }
        if (!trade.addWinnersChecked) {
          trade.addWinnersChecked = true;
          const aw = checkAddWinners(trade, bars);
          if (aw) {
            const entryDay = ptDateOf(trade.barTime);
            history[entryDay] = history[entryDay] || {};
            history[entryDay].closeAdjustments = history[entryDay].closeAdjustments || [];
            history[entryDay].closeAdjustments.push({ type: 'sized_up', symbol: trade.symbol, side: trade.side, entryPrice: trade.entryPrice, barTime: trade.barTime, liveR: aw.liveR, addMult: ADD_WINNERS_MULT });
          }
        }
      }
      const r = simulateExit(trade.side, trade.entryPrice, trade.stopPrice, trade.barTime, bars, trade.tf);
      trade.liveR = r.liveR;
      if (r.resolved) { trade.resolved = true; trade.rMultiple = r.rMultiple; trade.gapped = r.gapped || false; resolvedCount++; }
    }
  });

  saveHistory(history);
  console.log(`Resolved ${resolvedCount} previously-pending trade(s) across ${symbols.length} symbol(s) (${closedByCpCount} by close-position rule).`);
}

module.exports = { run };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
