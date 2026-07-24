// Retroactively recomputes every RESOLVED trade in signal_history.json under the new
// +10%-wider stop-loss table, using the exact same data source (Yahoo Finance, via lib.js)
// and exact same blended-exit simulator (simulate_exit.js) the live system already uses --
// not an approximation, a real re-simulation with real forward bars.
//
// Mechanism: each trade's ORIGINAL stopPrice encodes its R (risk distance). We back out
// that R, widen it 10%, derive the new stopPrice, then re-run simulateExit with the same
// forward bars to see where the trade actually would have exited under the wider stop.
//
// Yahoo's 30m-interval history is capped at 60 calendar days back, so trades older than
// that can't be exactly re-simulated (left untouched, flagged in the summary).
// IMPORTANT: this replicates BOTH layers the live pipeline actually uses, not just the
// natural stop/target/chandelier exit -- resolve_pending.js's simulateExit() AND
// eod_close_position_check.js's same-day EOD closePos override (checked in the same
// order the live system checks them: natural exit first; if still open at the end of the
// entry day, the close-position rule can force-close it instead of letting it run on).
// An earlier version of this script only replicated the natural exit and produced wrong
// results for every close-position-filtered trade -- caught before it was saved, see the
// backup at signal_history.json.pre-widen-backup.
const fs = require('fs');
const path = require('path');
const { fetchChart, pool } = require('./lib');
const { simulateExit } = require('./simulate_exit');

const CLOSEPOS_MIN = 0.20;
const ROOT = path.join(__dirname, '..');
const HISTORY_PATH = path.join(ROOT, 'signal_history.json');

function dayKeyPT(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(ts * 1000));
}

// Re-simulates one trade under a given stop, applying the close-position override if the
// natural exit hasn't resolved it by the end of its own entry day.
function simulateWithClosePos(side, entryPrice, stopPrice, barTime, bars, tf) {
  const entryDay = dayKeyPT(barTime);
  const entryDayBars = bars.filter(b => dayKeyPT(b.time) === entryDay && b.time >= barTime);
  if (entryDayBars.length) {
    // Would the natural exit already resolve it WITHIN the entry day? Simulate against
    // just the entry-day bars first to check.
    const sameDayBars = bars.filter(b => b.time <= entryDayBars[entryDayBars.length - 1].time);
    const sameDaySim = simulateExit(side, entryPrice, stopPrice, barTime, sameDayBars, tf);
    if (sameDaySim.resolved) return sameDaySim; // stop/target/trail hit intraday -- close-pos never gets a chance to run

    // Still open at end of entry day -- apply the same-day closePos override.
    const high = Math.max(...entryDayBars.map(b => b.high));
    const low = Math.min(...entryDayBars.map(b => b.low));
    const lastClose = entryDayBars[entryDayBars.length - 1].close;
    const range = high - low;
    const closePos = range > 0 ? (lastClose - low) / range : 0.5;
    const failed = side === 'long' ? closePos < CLOSEPOS_MIN : closePos > (1 - CLOSEPOS_MIN);
    if (failed) {
      const R = side === 'long' ? (entryPrice - stopPrice) / entryPrice : (stopPrice - entryPrice) / entryPrice;
      const ret = side === 'long' ? (lastClose - entryPrice) / entryPrice : (entryPrice - lastClose) / entryPrice;
      return { resolved: true, rMultiple: R > 0 ? +(ret / R).toFixed(2) : 0, closedByClosePosRule: true };
    }
  }
  // Not caught by either same-day check -- let it run the full multi-day natural simulation.
  return simulateExit(side, entryPrice, stopPrice, barTime, bars, tf);
}

async function getBars(symbol, tf) {
  const interval = tf === '1h' ? '60m' : '30m';
  const range = tf === '1h' ? '2y' : '60d';
  const r = await fetchChart(symbol, `range=${range}&interval=${interval}`);
  const ts = r.timestamp, q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue; // Yahoo pads non-trading minutes with nulls
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] });
  }
  return bars;
}

async function main() {
  const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  fs.writeFileSync(HISTORY_PATH + '.pre-widen-backup', JSON.stringify(history));

  const days = Object.keys(history).sort();
  // Collect every resolved trade across the whole history, grouped by symbol so each
  // ticker only needs ONE bar fetch covering all its trades.
  const bySymbol = {};
  for (const d of days) {
    const taken = (history[d].taken || []);
    taken.forEach((t, idx) => {
      if (!t.resolved) return;
      (bySymbol[t.symbol] = bySymbol[t.symbol] || []).push({ day: d, idx, trade: t });
    });
  }
  const symbols = Object.keys(bySymbol);
  console.log('Recomputing', symbols.length, 'tickers,', Object.values(bySymbol).reduce((a, v) => a + v.length, 0), 'resolved trades...');

  let changed = 0, unchanged = 0, tooOld = 0, errored = 0;
  const changedLog = [];

  const results = await pool(symbols, async (symbol) => {
    const refs = bySymbol[symbol];
    const tf = refs[0].trade.tf || '30m';
    let bars;
    try { bars = await getBars(symbol, tf); }
    catch (e) { return { symbol, error: e.message }; }

    for (const { day, idx, trade } of refs) {
      const entryPrice = trade.entryPrice, oldStop = trade.stopPrice;
      if (entryPrice == null || oldStop == null) { tooOld++; continue; }
      const oldR = trade.side === 'long' ? (entryPrice - oldStop) / entryPrice : (oldStop - entryPrice) / entryPrice;
      if (oldR <= 0) { tooOld++; continue; }
      const newR = oldR * 1.10;
      const newStop = trade.side === 'long' ? entryPrice * (1 - newR) : entryPrice * (1 + newR);

      const entryIdx = bars.findIndex(b => b.time === trade.barTime);
      if (entryIdx === -1) { tooOld++; continue; } // bar history doesn't reach this far back (>60d)

      const sim = simulateWithClosePos(trade.side, entryPrice, newStop, trade.barTime, bars, tf);
      if (!sim.resolved) { tooOld++; continue; } // not enough forward bars yet to resolve under the wider stop

      const oldRM = trade.rMultiple;
      trade.rMultipleOldStop = oldRM;
      trade.rMultiple = sim.rMultiple;
      trade.stopPrice = +newStop.toFixed(4);
      trade.slWidened = true;
      if (sim.closedByClosePosRule) trade.closedByClosePosRule = true;
      if (Math.abs(sim.rMultiple - oldRM) > 0.005) {
        changed++;
        changedLog.push(`${day} ${symbol} ${trade.side}: ${oldRM.toFixed(2)}R -> ${sim.rMultiple.toFixed(2)}R`);
      } else unchanged++;
    }
    return { symbol, ok: true };
  }, 6);

  results.forEach(r => { if (r.value && r.value.error) { errored++; console.log('  ERROR', r.value.symbol, r.value.error); } });

  if (process.env.DRY_RUN !== '1') fs.writeFileSync(HISTORY_PATH, JSON.stringify(history));
  else console.log('[DRY RUN -- signal_history.json NOT written]');
  console.log('\nDone. Changed:', changed, 'Unchanged:', unchanged, 'Too old / unresolved under new bars:', tooOld, 'Fetch errors:', errored);
  console.log('\nSample of changed trades:');
  changedLog.slice(0, 25).forEach(l => console.log(' ', l));
}

main().catch(e => { console.error(e); process.exit(1); });
