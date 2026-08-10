// Live shelf-break scanner -- exact port of ll_backtest/build_intraday_shelf_signals.js with the
// RECOVERED validated params (previously unrecoverable; found in this session's own tool-call
// history from 2026-08-05, verified by reproducing the exact original OOS trade counts to <0.5%):
//   SHORT: MIN_TOUCHES=5, ENTRY_MODE=asap, SHELF_TOL=0.001, VOL_MIN_MULT=1.5, WINDOW_DAYS=2,
//          BREAK_VOL_MULT=2, LOOKBACK_BARS=8
//   LONG:  same + TREND_FILTER=1 (price above prior-day 1D 50EMA)
// Detects N recent 30m bars (within a rolling lookback, up to WINDOW_DAYS calendar days) whose
// lows (support, for shorts) or highs (resistance, for longs) cluster within SHELF_TOL of each
// other with volume >= VOL_MIN_MULT of the window average, then a break bar with volume >= 2x a
// wider 20-bar baseline. Entry is ASAP (at the shelf level itself, not waiting for a close past
// it). Stop = far side of the window/break bar, floored at 1.40x the ADR-tiered SL table.
const { emaSeries, computeAdrSeries, slForAdr } = require('./indicators');
const { fetchChart, pool, ptDateString, dropIncompleteBars } = require('./lib');
const UNIVERSE_233 = require('./universe_233.js');

const MIN_TOUCHES = 5, LOOKBACK_BARS = 8, WINDOW_DAYS = 2, SHELF_TOL = 0.001;
const VOL_MIN_MULT = 1.5, BREAK_VOL_MULT = 2;

const etDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
function etDate(unixSec) { return etDateFmt.format(new Date(unixSec * 1000)); }

async function fetchDaily(symbol) {
  const result = await fetchChart(symbol, 'range=2y&interval=1d');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.volume[i] == null) continue;
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
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.volume[i] == null || q.open[i] == null) continue;
    // ZERO-VOLUME ARTIFACT FIX (2026-08-08): Yahoo sometimes appends a spurious closing-print bar
    // at exactly market close with vol=0 -- not a real tradeable bar. Same fix as the backtest
    // builder (build_intraday_shelf_signals.js), keeps shelf from "entering" on it.
    if (q.volume[i] === 0) continue;
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] });
  }
  return dropIncompleteBars(bars, 1800);
}

// Per-symbol, per-side detection against TODAY's bars only.
function scanSymbolSide(symbol, side, daily, bars30) {
  if (bars30.length < LOOKBACK_BARS + 10 || daily.length < 55) return [];
  const dailyDateIdx = new Map();
  for (let d = 0; d < daily.length; d++) dailyDateIdx.set(etDate(daily[d].time), d);
  const adrSeries = computeAdrSeries(daily);
  const ema50Series = side === 'long' ? emaSeries(daily.map(b => b.close), 50) : null;
  const todayStr = ptDateString();
  const signals = [];

  for (let i = LOOKBACK_BARS + 5; i < bars30.length; i++) {
    const bar = bars30[i];
    if (etDate(bar.time) !== todayStr) continue; // only report today's break bar as a new signal

    let badTick = false;
    for (let k = Math.max(0, i - LOOKBACK_BARS - 1); k < i; k++) {
      if (bars30[k + 1] && bars30[k].close > 0 && Math.abs(bars30[k + 1].open - bars30[k].close) / bars30[k].close > 0.25) { badTick = true; break; }
    }
    if (badTick) continue;

    const dayKey = etDate(bar.time);
    const window = []; const seenDays = new Set();
    for (let k = i - 1; k >= Math.max(0, i - LOOKBACK_BARS); k--) {
      const dk = etDate(bars30[k].time); seenDays.add(dk);
      if (seenDays.size > WINDOW_DAYS) break;
      window.unshift(bars30[k]);
    }
    if (window.length < MIN_TOUCHES) continue;

    const tol = SHELF_TOL;
    const levels = side === 'short' ? window.map(b => b.low) : window.map(b => b.high);
    let bestShelf = null, bestTouches = 0;
    for (const p of levels) {
      const cluster = levels.filter(q => Math.abs(q - p) / p <= tol);
      if (cluster.length >= MIN_TOUCHES && cluster.length > bestTouches) { bestTouches = cluster.length; bestShelf = cluster.reduce((s, x) => s + x, 0) / cluster.length; }
    }
    if (bestShelf == null) continue;

    if (side === 'long') {
      const dIdx = dailyDateIdx.get(dayKey);
      if (dIdx == null || dIdx < 51) continue;
      const pIdx = dIdx - 1;
      if (!(daily[pIdx].close > ema50Series[pIdx])) continue;
    }

    let entryPrice, stopPrice;
    if (side === 'short') {
      if (!(bar.low < bestShelf)) continue;
      entryPrice = bestShelf;
      stopPrice = Math.max(...window.map(b => b.high), bar.high);
    } else {
      if (!(bar.high > bestShelf)) continue;
      entryPrice = bestShelf;
      stopPrice = Math.min(...window.map(b => b.low), bar.low);
    }

    const avgVol = window.reduce((s, b) => s + (b.volume || 0), 0) / window.length;
    if (avgVol <= 0 || (bar.volume || 0) < VOL_MIN_MULT * avgVol) continue;

    const baseStart = Math.max(0, i - LOOKBACK_BARS - 20), baseEnd = Math.max(0, i - LOOKBACK_BARS);
    const baseBars = bars30.slice(baseStart, baseEnd);
    const baseAvgVol = baseBars.length ? baseBars.reduce((s, b) => s + (b.volume || 0), 0) / baseBars.length : 0;
    if (baseAvgVol <= 0 || (bar.volume || 0) < BREAK_VOL_MULT * baseAvgVol) continue;

    const rRaw = side === 'short' ? (stopPrice - entryPrice) / entryPrice : (entryPrice - stopPrice) / entryPrice;
    if (rRaw <= 0 || rRaw > 0.15) continue;
    const dIdxForFloor = dailyDateIdx.get(dayKey);
    const adrPctForFloor = dIdxForFloor != null && dIdxForFloor > 0 ? adrSeries[dIdxForFloor - 1] : null;
    if (adrPctForFloor == null || adrPctForFloor <= 0) continue;
    const floorDist = slForAdr(adrPctForFloor) / 100 * 1.40;
    if (rRaw < floorDist) {
      stopPrice = side === 'short' ? entryPrice * (1 + floorDist) : entryPrice * (1 - floorDist);
    }
    const R = Math.max(rRaw, floorDist);
    if (R > 0.25) continue;

    const entryIdx = i + 1;
    if (entryIdx >= bars30.length) continue; // entry confirms on the NEXT bar's open, not yet available
    const entryBar = bars30[entryIdx];

    signals.push({
      symbol, side, entryPrice: +entryPrice.toFixed(4), stopPrice: +stopPrice.toFixed(4),
      barTime: entryBar.time, patternTier: side === 'short' ? 'shelf_short' : 'shelf_long',
      tf: '30m', source: 'CORE', qual: null, shelfTouches: bestTouches, sizeMult: 1.0,
    });
  }
  const seen = new Set(); const deduped = [];
  for (const s of signals.sort((a, b) => a.barTime - b.barTime)) {
    const k = s.symbol + '|' + s.side + '|' + s.barTime;
    if (seen.has(k)) continue;
    seen.add(k); deduped.push(s);
  }
  return deduped;
}

async function run() {
  const dailyResults = await pool(UNIVERSE_233, fetchDaily, 8);
  const intradayResults = await pool(UNIVERSE_233, fetch30m, 8);

  let allSignals = [];
  for (let ti = 0; ti < UNIVERSE_233.length; ti++) {
    if (!dailyResults[ti].ok || !intradayResults[ti].ok) continue;
    const daily = dailyResults[ti].value, bars30 = intradayResults[ti].value;
    allSignals = allSignals.concat(scanSymbolSide(UNIVERSE_233[ti], 'short', daily, bars30));
    allSignals = allSignals.concat(scanSymbolSide(UNIVERSE_233[ti], 'long', daily, bars30));
  }
  allSignals.sort((a, b) => a.barTime - b.barTime || a.symbol.localeCompare(b.symbol));
  const shorts = allSignals.filter(s => s.side === 'short').length;
  console.log(`Shelf scan: ${allSignals.length} signal(s) today (${shorts} short, ${allSignals.length - shorts} long).`);
  return allSignals;
}

module.exports = { run, scanSymbolSide };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
