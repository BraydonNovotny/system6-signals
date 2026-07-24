// Backfills day.closeAdjustments across the ENTIRE history -- the earlier recompute
// (recompute_wider_stops.js) fixed each trade's own rMultiple/stopPrice under the wider
// stop and close-position rule, but never populated the closeAdjustments feed itself
// (only today's ORCL got a one-off manual backfill). This fills in both halves for every
// resolved trade, historically:
//   - 'closed': trade.closedByClosePosRule is already set on the trade from the recompute
//   - 'sized_up': trade was still open at its own entry-day close AND mark-to-market R
//     at that boundary was >= 0.5 -- doesn't matter what happened to the trade afterward
//     (whether it went on to win big or come back down), the add-winners rule only cares
//     about the state AT the entry-day close.
const fs = require('fs');
const path = require('path');
const { fetchChart, pool } = require('./lib');
const { simulateExit } = require('./simulate_exit');

const ROOT = path.join(__dirname, '..');
const HISTORY_PATH = path.join(ROOT, 'signal_history.json');
const ADD_WINNERS_THRESHOLD_R = 0.5, ADD_WINNERS_MULT = 1.5;

function ptDateOf(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(ts * 1000));
}

async function getBars(symbol, tf) {
  const interval = tf === '1h' ? '60m' : '30m';
  const range = tf === '1h' ? '2y' : '60d';
  const r = await fetchChart(symbol, `range=${range}&interval=${interval}`);
  const ts = r.timestamp, q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] });
  }
  return bars;
}

async function main() {
  const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  const days = Object.keys(history).sort();

  const bySymbol = {};
  for (const d of days) {
    for (const t of (history[d].taken || [])) {
      if (!t.resolved) continue;
      (bySymbol[t.symbol] = bySymbol[t.symbol] || []).push({ day: d, trade: t });
    }
  }
  const symbols = Object.keys(bySymbol);
  console.log('Checking', symbols.length, 'tickers,', Object.values(bySymbol).reduce((a, v) => a + v.length, 0), 'resolved trades for missed close-adjustments...');

  let closedAdded = 0, sizedUpAdded = 0, tooOld = 0, errored = 0;

  const results = await pool(symbols, async (symbol) => {
    const refs = bySymbol[symbol];
    const tf = refs[0].trade.tf || '30m';
    let bars;
    try { bars = await getBars(symbol, tf); }
    catch (e) { return { symbol, error: e.message }; }

    for (const { day, trade } of refs) {
      const entryDay = ptDateOf(trade.barTime);
      const entryDayBars = bars.filter(b => ptDateOf(b.time) === entryDay && b.time >= trade.barTime);
      if (!entryDayBars.length) { tooOld++; continue; } // outside Yahoo's 60d window

      const already = (history[entryDay].closeAdjustments || []).some(a => a.symbol === trade.symbol && a.side === trade.side && a.barTime === trade.barTime);
      if (already) continue;

      if (trade.closedByClosePosRule) {
        history[entryDay].closeAdjustments = history[entryDay].closeAdjustments || [];
        history[entryDay].closeAdjustments.push({ type: 'closed', symbol: trade.symbol, side: trade.side, entryPrice: trade.entryPrice, barTime: trade.barTime, rMultiple: trade.rMultiple, closePos: null });
        closedAdded++;
        continue;
      }

      // Was it still open at the end of its own entry day? Simulate against just that
      // day's bars -- if the natural exit already resolved it intraday, add-winners
      // never applies (it specifically requires "still open at the close").
      const sameDayBars = bars.filter(b => b.time <= entryDayBars[entryDayBars.length - 1].time);
      const sameDaySim = simulateExit(trade.side, trade.entryPrice, trade.stopPrice, trade.barTime, sameDayBars, tf);
      if (sameDaySim.resolved) continue; // resolved same-day via stop/target/trail -- not eligible

      const lastClose = entryDayBars[entryDayBars.length - 1].close;
      const R = trade.side === 'long' ? (trade.entryPrice - trade.stopPrice) / trade.entryPrice : (trade.stopPrice - trade.entryPrice) / trade.entryPrice;
      if (R <= 0) continue;
      const ret = trade.side === 'long' ? (lastClose - trade.entryPrice) / trade.entryPrice : (trade.entryPrice - lastClose) / trade.entryPrice;
      const liveR = +(ret / R).toFixed(2);
      if (liveR >= ADD_WINNERS_THRESHOLD_R) {
        history[entryDay].closeAdjustments = history[entryDay].closeAdjustments || [];
        history[entryDay].closeAdjustments.push({ type: 'sized_up', symbol: trade.symbol, side: trade.side, entryPrice: trade.entryPrice, barTime: trade.barTime, liveR, addMult: ADD_WINNERS_MULT });
        sizedUpAdded++;
      }
    }
    return { symbol, ok: true };
  }, 6);

  results.forEach(r => { if (r.value && r.value.error) { errored++; console.log('  ERROR', r.value.symbol, r.value.error); } });

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history));
  console.log('\nDone. Closed-position entries added:', closedAdded, '| Sized-up entries added:', sizedUpAdded, '| Too old (outside 60d):', tooOld, '| Fetch errors:', errored);
}

main().catch(e => { console.error(e); process.exit(1); });
