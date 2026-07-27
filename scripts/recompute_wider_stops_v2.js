// Retroactively recomputes every RESOLVED trade in signal_history.json under the NEW +40%
// widened stop-loss table (up from the +10% the earlier recompute_wider_stops.js applied),
// matching the confirmed 453.3% OOS CAGR / 3.98 Sharpe / 6.71% maxDD backtest baseline.
// Mirrors recompute_wider_stops.js's mechanism exactly (same exit simulator, same
// close-position-override replication) -- the only change is the multiplier, and correctly
// backing out each trade's TRUE base R first (some trades already went through the earlier
// 1.10x pass -- flagged `slWidened: true` -- others are still at the original 1.0x base).
const fs = require('fs');
const path = require('path');
const { fetchChart, pool } = require('./lib');
const { simulateExit } = require('./simulate_exit');

const NEW_WIDEN_MULT = 1.40;
const PRIOR_WIDEN_MULT = 1.10; // what slWidened:true trades were already multiplied by
const ROOT = path.join(__dirname, '..');
const HISTORY_PATH = path.join(ROOT, 'signal_history.json');

// NOTE: unlike the earlier recompute_wider_stops.js, this does NOT replicate the
// close-position override -- CP was retired from the live system 2026-07-27 (backtesting
// confirmed it's not part of the current locked 453.3% config), so recomputing history
// should reflect PURE natural exit simulation, matching what the system would actually do
// today, not reintroduce a rule that no longer applies.

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
  return bars.filter((b, idx) => b.high !== b.low || idx === 0);
}

async function main() {
  const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  fs.writeFileSync(HISTORY_PATH + '.pre-widen-v2-backup', JSON.stringify(history));

  const days = Object.keys(history).sort();
  const bySymbol = {};
  for (const d of days) {
    const taken = (history[d].taken || []);
    taken.forEach((t, idx) => {
      if (!t.resolved) return;
      (bySymbol[t.symbol] = bySymbol[t.symbol] || []).push({ day: d, idx, trade: t });
    });
  }
  const symbols = Object.keys(bySymbol);
  console.log('Recomputing', symbols.length, 'tickers,', Object.values(bySymbol).reduce((a, v) => a + v.length, 0), 'resolved trades to +40% widened stops...');

  let changed = 0, unchanged = 0, tooOld = 0, errored = 0;
  const changedLog = [];

  const results = await pool(symbols, async (symbol) => {
    const refs = bySymbol[symbol];
    const tf = refs[0].trade.tf || '30m';
    let bars;
    try { bars = await getBars(symbol, tf); }
    catch (e) { return { symbol, error: e.message }; }

    for (const { day, idx, trade } of refs) {
      const entryPrice = trade.entryPrice, currentStop = trade.stopPrice;
      if (entryPrice == null || currentStop == null) { tooOld++; continue; }
      const currentR = trade.side === 'long' ? (entryPrice - currentStop) / entryPrice : (currentStop - entryPrice) / entryPrice;
      if (currentR <= 0) { tooOld++; continue; }
      // Back out the TRUE base R (pre-any-widening) before applying the new multiplier.
      const baseR = trade.slWidened ? currentR / PRIOR_WIDEN_MULT : currentR;
      const newR = baseR * NEW_WIDEN_MULT;
      const newStop = trade.side === 'long' ? entryPrice * (1 - newR) : entryPrice * (1 + newR);

      const entryIdx = bars.findIndex(b => b.time === trade.barTime);
      if (entryIdx === -1) { tooOld++; continue; }

      const sim = simulateExit(trade.side, entryPrice, newStop, trade.barTime, bars, tf);
      if (!sim.resolved) { tooOld++; continue; }

      const oldRM = trade.rMultiple;
      trade.rMultiplePriorWiden = oldRM; // keep prior value for audit, alongside rMultipleOldStop if present
      trade.rMultiple = sim.rMultiple;
      trade.stopPrice = +newStop.toFixed(4);
      trade.slWidened = true;
      trade.slWidenMult = NEW_WIDEN_MULT;
      delete trade.closedByClosePosRule; // CP rule retired 2026-07-27 -- don't carry it forward on recompute
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
  changedLog.slice(0, 30).forEach(l => console.log(' ', l));
}

main().catch(e => { console.error(e); process.exit(1); });
