// Retroactively applies BOTH new locked-in changes (2026-07-27) to signal_history.json so the
// live site's trade log and week/month/3m stats read as if this system had ALWAYS been running:
//   1. Exit: 100% chandelier (dropped the old 25%-fixed/75%-chandelier blend) -- re-simulate
//      every resolved trade's exit using the current simulate_exit.js (already edited to pure
//      chandelier), same entry/stop, just different exit dynamics.
//   2. Entry: 3-week RS-vs-QQQ long-only exclude filter (rsVsQqq3w >= 0 required) -- core
//      pattern LONG trades only (source undefined, i.e. not EP/PER, matching the backtest lever
//      which only touched the core signal pool). Any long trade that fails this check gets
//      REMOVED from history entirely, as if it had never fired.
const fs = require('fs');
const path = require('path');
const { fetchChart, pool } = require('./lib');
const { simulateExit } = require('./simulate_exit');

const ROOT = path.join(__dirname, '..');
const HISTORY_PATH = path.join(ROOT, 'signal_history.json');

async function getIntradayBars(symbol, tf) {
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

const dailyCache = {};
async function getDaily(symbol) {
  if (dailyCache[symbol]) return dailyCache[symbol];
  const r = await fetchChart(symbol, 'range=3y&interval=1d');
  const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    bars.push({ time: ts[i], close: q.close[i] });
  }
  dailyCache[symbol] = bars;
  return bars;
}

// Index of the last daily bar strictly BEFORE the given intraday entry time.
function dailyIdxAsOf(dailyBars, entryTime) {
  const dayKey = Math.floor(entryTime / 86400);
  let ans = -1;
  for (let i = 0; i < dailyBars.length; i++) {
    if (Math.floor(dailyBars[i].time / 86400) < dayKey) ans = i; else break;
  }
  return ans;
}

async function main() {
  const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  fs.writeFileSync(HISTORY_PATH + '.pre-v3-backup', JSON.stringify(history));

  const qqqDaily = await getDaily('QQQ');

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
  console.log('Recomputing', symbols.length, 'tickers,', Object.values(bySymbol).reduce((a, v) => a + v.length, 0), 'resolved trades (chandelier exit + RS3w long filter)...');

  let exitChanged = 0, exitUnchanged = 0, tooOld = 0, errored = 0, removedByRs3w = 0;
  const removeSet = new Set(); // `${day}|${symbol}|${barTime}` for trades to strip out entirely
  const changedLog = [], removedLog = [];

  await pool(symbols, async (symbol) => {
    const refs = bySymbol[symbol];
    const tf = refs[0].trade.tf || '30m';
    let bars, daily;
    try {
      bars = await getIntradayBars(symbol, tf);
      daily = await getDaily(symbol);
    } catch (e) { errored++; console.log('  ERROR', symbol, e.message); return; }

    for (const { day, idx, trade } of refs) {
      const entryPrice = trade.entryPrice, stopPrice = trade.stopPrice;
      if (entryPrice == null || stopPrice == null) { tooOld++; continue; }

      // --- (2) RS3w long-only exclude filter, core signals only ---
      const isCore = trade.source !== 'EP' && trade.source !== 'PER';
      if (trade.side === 'long' && isCore) {
        const dIdx = dailyIdxAsOf(daily, trade.barTime);
        const qIdx = dailyIdxAsOf(qqqDaily, trade.barTime);
        if (dIdx - 15 >= 0 && qIdx - 15 >= 0) {
          const stockRet = (daily[dIdx].close / daily[dIdx - 15].close - 1) * 100;
          const qqqRet = (qqqDaily[qIdx].close / qqqDaily[qIdx - 15].close - 1) * 100;
          const rsVsQqq3w = stockRet - qqqRet;
          if (rsVsQqq3w < 0) {
            removeSet.add(day + '|' + symbol + '|' + trade.barTime);
            removedByRs3w++;
            removedLog.push(`${day} ${symbol} long: rsVsQqq3w=${rsVsQqq3w.toFixed(2)} < 0 -- removed`);
            continue; // don't bother re-simulating exit on a trade we're removing
          }
        }
      }

      // --- (1) 100% chandelier exit recompute ---
      const entryIdx = bars.findIndex(b => b.time === trade.barTime);
      if (entryIdx === -1) { tooOld++; continue; }
      const sim = simulateExit(trade.side, entryPrice, stopPrice, trade.barTime, bars, tf);
      if (!sim.resolved) { tooOld++; continue; }
      const oldRM = trade.rMultiple;
      trade.rMultiplePriorChandelierLock = oldRM;
      trade.rMultiple = sim.rMultiple;
      trade.exitConfigLocked = '100pct_chandelier';
      if (Math.abs(sim.rMultiple - oldRM) > 0.005) {
        exitChanged++;
        changedLog.push(`${day} ${symbol} ${trade.side}: ${oldRM.toFixed(2)}R -> ${sim.rMultiple.toFixed(2)}R`);
      } else exitUnchanged++;
    }
  }, 6);

  // Strip removed trades out of history.
  for (const d of days) {
    const taken = history[d].taken || [];
    history[d].taken = taken.filter(t => !removeSet.has(d + '|' + t.symbol + '|' + t.barTime));
  }

  if (process.env.DRY_RUN !== '1') fs.writeFileSync(HISTORY_PATH, JSON.stringify(history));
  else console.log('[DRY RUN -- signal_history.json NOT written]');

  console.log('\nDone.');
  console.log('Exit recompute: changed=' + exitChanged, 'unchanged=' + exitUnchanged, 'tooOld/unresolved=' + tooOld, 'fetchErrors=' + errored);
  console.log('RS3w removals: ' + removedByRs3w);
  console.log('\nSample exit changes:');
  changedLog.slice(0, 20).forEach(l => console.log(' ', l));
  console.log('\nSample RS3w removals:');
  removedLog.slice(0, 20).forEach(l => console.log(' ', l));
}

main().catch(e => { console.error(e); process.exit(1); });
