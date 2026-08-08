// Live 3x-inside scanner -- REDESIGNED 2026-08-08 per the curve-fit audit: the 4H-reclaim
// source had no real edge at any threshold (negative avgR at 2x-inside, and its apparent
// profit at 3x-inside was concentrated in a handful of trades out of only 35 total -- dropped
// entirely). This is the 1D-EMA-surf source ONLY, loosened to qual>=2 (2+ consecutive inside
// bars compressing before the confirm/break bar), matching ll_backtest/build_surfing_signals.js.
const { emaSeries, computeAdrSeries } = require('./indicators');
const { fetchChart, pool, ptDateString, dropIncompleteBars } = require('./lib');
const UNIVERSE_233 = require('./universe_233.js');

const STRONG_BODY_RATIO = 0.60, STRONG_CLOSE_POS = 0.75, CONFIRM_WINDOW_BARS = 8;
const SL_FLOOR_ADR_FRAC = 0.275;
const DAILY_EMA_PERIODS = [8, 20, 50]; // 1dCfg variants, matches build_surfing_signals.js

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
  let bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.volume[i] == null || q.open[i] == null) continue;
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] });
  }
  return dropIncompleteBars(bars, 1800);
}
async function fetch1h(symbol) {
  const result = await fetchChart(symbol, 'range=2y&interval=60m');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  let bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.volume[i] == null || q.open[i] == null) continue;
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] });
  }
  return dropIncompleteBars(bars, 3600);
}

const etDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
function etDate(unixSec) { return etDateFmt.format(new Date(unixSec * 1000)); }

async function scanSymbol(symbol, daily, bars30, bars1h) {
  if (daily.length < 210) return [];
  const dailyCloses = daily.map(b => b.close);
  const dailyEma50 = emaSeries(dailyCloses, 50);
  const dailyDateIdx = new Map();
  for (let i = 0; i < daily.length; i++) dailyDateIdx.set(etDate(daily[i].time), i);
  const adrSeries = computeAdrSeries(daily);
  const todayStr = ptDateString();
  const signals = [];

  for (const period of DAILY_EMA_PERIODS) {
    const dEma = emaSeries(dailyCloses, period);
    // find events: daily close touches+reclaims the period EMA
    const events = [];
    for (let i = 1; i < daily.length; i++) {
      const e = dEma[i - 1];
      if (e == null) continue;
      const wasAbove = daily[i - 1].close > e;
      const touched = daily[i].low <= dEma[i] && daily[i].close > dEma[i];
      if (wasAbove && touched) events.push({ touchTime: daily[i].time, dIdx: i });
    }
    if (!events.length) continue;

    for (const [entryTf, bars] of [['30m', bars30], ['1h', bars1h]]) {
      if (!bars || !bars.length) continue;
      for (const ev of events) {
        const dIdx = ev.dIdx;
        if (dIdx < 55) continue;
        if (!(daily[dIdx].close > dailyEma50[dIdx])) continue;
        const adrPct = adrSeries[dIdx];
        if (adrPct == null || adrPct <= 0) continue;

        let startIdx = bars.findIndex(b => b.time >= ev.touchTime);
        if (startIdx === -1) continue;
        let confirmIdx = -1, insideStreak = 0;
        for (let k = startIdx + 1; k < Math.min(bars.length - 1, startIdx + 1 + CONFIRM_WINDOW_BARS); k++) {
          const b = bars[k], pb = bars[k - 1];
          const range = b.high - b.low;
          if (range <= 0) continue;
          const bodyRatio = Math.abs(b.close - b.open) / range, closePos = (b.close - b.low) / range;
          const isStrong = b.close > b.open && bodyRatio >= STRONG_BODY_RATIO && closePos >= STRONG_CLOSE_POS && b.high > pb.high;
          if (isStrong) { confirmIdx = k; break; }
          const isInside = b.high <= pb.high && b.low >= pb.low;
          insideStreak = isInside ? insideStreak + 1 : 0;
        }
        if (confirmIdx === -1) continue;
        const qual = insideStreak >= 3 ? 3 : insideStreak >= 2 ? 2 : 1;
        if (qual < 2) continue; // REDESIGNED: qual>=2 only (2+ inside bars)

        const confirmBar = bars[confirmIdx];
        const entryIdx = confirmIdx + 1;
        if (entryIdx >= bars.length) continue;
        const entryBar = bars[entryIdx];
        if (entryBar.high <= confirmBar.high) continue;
        if (etDate(entryBar.time) !== todayStr) continue;

        const entryPrice = confirmBar.high, stopPrice = confirmBar.low;
        const rRaw = (entryPrice - stopPrice) / entryPrice;
        if (rRaw <= 0) continue;
        const R = Math.max(rRaw, SL_FLOOR_ADR_FRAC * adrPct / 100);
        if (R > 0.25) continue;
        const finalStop = rRaw < (SL_FLOOR_ADR_FRAC * adrPct / 100) ? entryPrice * (1 - SL_FLOOR_ADR_FRAC * adrPct / 100) : stopPrice;

        signals.push({
          symbol, side: 'long', qual, entryPrice: +entryPrice.toFixed(4), stopPrice: +finalStop.toFixed(4),
          barTime: entryBar.time, patternTier: 'three_x_inside', tf: entryTf, source: 'CORE',
        });
      }
    }
  }
  const seen = new Set(); const deduped = [];
  for (const s of signals.sort((a, b) => a.barTime - b.barTime)) {
    const k = s.symbol + '|' + s.barTime;
    if (seen.has(k)) continue;
    seen.add(k); deduped.push(s);
  }
  return deduped;
}

async function run() {
  const dailyResults = await pool(UNIVERSE_233, fetchDaily, 8);
  const bars30Results = await pool(UNIVERSE_233, fetch30m, 8);
  const bars1hResults = await pool(UNIVERSE_233, fetch1h, 6);

  let allSignals = [];
  for (let ti = 0; ti < UNIVERSE_233.length; ti++) {
    if (!dailyResults[ti].ok || !bars30Results[ti].ok) continue;
    const sigs = await scanSymbol(UNIVERSE_233[ti], dailyResults[ti].value, bars30Results[ti].value, bars1hResults[ti].ok ? bars1hResults[ti].value : null);
    allSignals = allSignals.concat(sigs);
  }
  console.log(`3x-inside scan: ${allSignals.length} signal(s) today.`);
  return allSignals;
}

module.exports = { run, scanSymbol };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
