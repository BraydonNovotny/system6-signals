// Live "base" (4H reclaim) entry scanner -- exact port of the locked backtest logic from
// ll_backtest/build_htf_reclaim_breakout_signals.js (the real, validated pipeline behind the
// 1065.2% system), not the old System 6 core-scan logic. Checks the FIXED 233-ticker universe
// (not the dynamic roster), resamples live 30m bars into 4H bars the same way the backtest's
// cache does, and detects touch+reclaim of the 4H 10/20/50EMA -> confirm-bar entry (including
// the early-entry bug fix: the very first bar after a touch can qualify directly, not just
// bars found by the later strict scan) -> stop floored at 27.5% of prior-day ADR14.
const { emaSeries, computeAdrSeries } = require('./indicators');
const { fetchChart, pool, ptDateString, dropIncompleteBars } = require('./lib');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UNIVERSE_233 = require('./universe_233.js');

const HTF_CONFIGS = [ { period: 10 }, { period: 20 }, { period: 50 } ];
const STRONG_BODY_RATIO = 0.60, STRONG_CLOSE_POS = 0.75, CONFIRM_WINDOW_BARS = 8;
const EARLY_BODY_RATIO = 0.30, EARLY_CLOSE_POS = 0.55;
const SL_FLOOR_ADR_FRAC = 0.275;
const BASE_DAILY_CAP = 5, BASE_BREAKER_R = -1;

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

const etDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
function etDate(unixSec) { return etDateFmt.format(new Date(unixSec * 1000)); }
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
function etHHMM(unixSec) {
  const parts = etFmt.formatToParts(new Date(unixSec * 1000));
  const get = t => parts.find(p => p.type === t).value;
  let hh = get('hour'); if (hh === '24') hh = '00';
  return hh + ':' + get('minute');
}

// Resample 30m bars into 4H bars, same convention as resample_1h_4h.js (groupSize=8, resets
// at each new ET calendar day so a session's partial last group never bleeds into the next day).
function resampleTo4h(bars30) {
  const out = [];
  let curDay = null, group = [];
  function flush() {
    if (!group.length) return;
    const o = group[0].open, c = group[group.length - 1].close;
    let h = -Infinity, l = Infinity;
    for (const b of group) { h = Math.max(h, b.high); l = Math.min(l, b.low); }
    out.push({ time: group[0].time, open: o, high: h, low: l, close: c });
    group = [];
  }
  for (const b of bars30) {
    const d = etDate(b.time);
    if (d !== curDay) { flush(); curDay = d; }
    group.push(b);
    if (group.length >= 8) flush();
  }
  flush();
  return out;
}

// Per-symbol detection: replays the exact touch+reclaim / confirm-bar / early-entry-fix logic
// against TODAY's bars only (the live scanner's job is "did a NEW signal fire today", not a
// full historical replay -- callers should track which barTimes have already been reported).
async function scanSymbol(symbol, daily, bars30) {
  if (daily.length < 210 || bars30.length < 20) return [];
  const dailyCloses = daily.map(b => b.close);
  const dailyEma50 = emaSeries(dailyCloses, 50);
  const dailyDateIdx = new Map();
  for (let i = 0; i < daily.length; i++) dailyDateIdx.set(etDate(daily[i].time), i);
  const adrSeries = computeAdrSeries(daily);

  const htfBars = resampleTo4h(bars30);
  if (htfBars.length < 55) return [];
  const htfCloses = htfBars.map(b => b.close);

  const todayStr = ptDateString();
  const signals = [];

  for (const { period } of HTF_CONFIGS) {
    const htfEma = emaSeries(htfCloses, period);
    for (let i = period + 5; i < htfBars.length; i++) {
      const e = htfEma[i], ePrev = htfEma[i - 1];
      if (e == null || ePrev == null) continue;
      const bar = htfBars[i];
      const wasAbove = htfBars[i - 1].close > ePrev;
      const touchedAndReclaimed = bar.low <= e && bar.close > e;
      if (!wasAbove || !touchedAndReclaimed) continue;
      const dKey = etDate(bar.time);
      const dIdx = dailyDateIdx.get(dKey);
      if (dIdx == null || dIdx < 56) continue;
      const pIdx = dIdx - 1;
      if (pIdx < 0 || !(daily[pIdx].close > dailyEma50[pIdx])) continue;
      const adrPct = adrSeries[pIdx];
      if (adrPct == null || adrPct <= 0) continue;

      let startIdx30 = bars30.findIndex(b => b.time >= bar.time);
      if (startIdx30 === -1) continue;

      let confirmIdx = -1;
      if (startIdx30 >= 1) {
        const b0 = bars30[startIdx30], range0 = b0.high - b0.low;
        if (range0 > 0) {
          const bodyRatio0 = Math.abs(b0.close - b0.open) / range0, closePos0 = (b0.close - b0.low) / range0;
          if (b0.close > b0.open && bodyRatio0 >= EARLY_BODY_RATIO && closePos0 >= EARLY_CLOSE_POS) confirmIdx = startIdx30;
        }
      }
      if (confirmIdx === -1) {
        for (let k = startIdx30 + 1; k < Math.min(bars30.length - 1, startIdx30 + 1 + CONFIRM_WINDOW_BARS); k++) {
          const b = bars30[k], pb = bars30[k - 1];
          const range = b.high - b.low;
          if (range <= 0) continue;
          const bodyRatio = Math.abs(b.close - b.open) / range, closePos = (b.close - b.low) / range;
          if (b.close > b.open && bodyRatio >= STRONG_BODY_RATIO && closePos >= STRONG_CLOSE_POS && b.high > pb.high) { confirmIdx = k; break; }
        }
      }
      if (confirmIdx === -1) continue;
      const confirmBar = bars30[confirmIdx];
      const entryIdx = confirmIdx + 1;
      if (entryIdx >= bars30.length) continue;
      const entryBar = bars30[entryIdx];
      if (entryBar.high <= confirmBar.high) continue;
      // Only report signals whose ENTRY bar is TODAY -- older confirmed touches are
      // already-resolved history, not a new live signal.
      if (etDate(entryBar.time) !== todayStr) continue;
      if (etHHMM(entryBar.time) === '09:30') continue; // locked: exclude 9:30 ET entries

      const entryPrice = confirmBar.high, chartStopPrice = confirmBar.low;
      const rRaw = (entryPrice - chartStopPrice) / entryPrice;
      if (rRaw <= 0) continue;
      const floorDist = SL_FLOOR_ADR_FRAC * adrPct / 100;
      const R = Math.max(rRaw, floorDist);
      if (R > 0.25) continue;
      const stopPrice = rRaw < floorDist ? entryPrice * (1 - floorDist) : chartStopPrice;

      signals.push({
        symbol, side: 'long', qual: 1, entryPrice: +entryPrice.toFixed(4), stopPrice: +stopPrice.toFixed(4),
        barTime: entryBar.time, patternTier: 'base_4h_reclaim', tf: '30m', source: 'CORE',
      });
    }
  }
  // Dedup: multiple HTF period configs (10/20/50) can independently fire on the identical
  // (symbol, barTime) -- keep the first occurrence only, same convention as the backtest.
  const seen = new Set(); const deduped = [];
  for (const s of signals.sort((a, b) => a.barTime - b.barTime)) {
    const k = s.symbol + '|' + s.barTime;
    if (seen.has(k)) continue;
    seen.add(k); deduped.push(s);
  }
  return deduped;
}

// Daily throttle: cap at BASE_DAILY_CAP new base entries/day, block entirely once today's
// REALIZED (resolved) R hits BASE_BREAKER_R. Needs today's already-taken base trades so far
// (with resolved rMultiple) to know where the day currently stands.
function applyDailyThrottle(candidates, todayTakenBaseTrades) {
  let admittedSoFar = todayTakenBaseTrades.length;
  const realizedR = todayTakenBaseTrades.filter(t => t.resolved).reduce((s, t) => s + t.rMultiple, 0);
  if (realizedR <= BASE_BREAKER_R) return []; // day already tripped the block
  if (admittedSoFar >= BASE_DAILY_CAP) return []; // day already at the cap
  const room = BASE_DAILY_CAP - admittedSoFar;
  return candidates.slice(0, room);
}

async function run(todayTakenBaseTrades = []) {
  const dailyResults = await pool(UNIVERSE_233, fetchDaily, 8);
  const intradayResults = await pool(UNIVERSE_233, fetch30m, 8);

  let allSignals = [];
  for (let ti = 0; ti < UNIVERSE_233.length; ti++) {
    if (!dailyResults[ti].ok || !intradayResults[ti].ok) continue;
    const sigs = await scanSymbol(UNIVERSE_233[ti], dailyResults[ti].value, intradayResults[ti].value);
    allSignals = allSignals.concat(sigs);
  }
  allSignals.sort((a, b) => a.barTime - b.barTime || a.symbol.localeCompare(b.symbol));
  const throttled = applyDailyThrottle(allSignals, todayTakenBaseTrades);
  console.log(`Base scan: ${allSignals.length} raw signal(s) today, ${throttled.length} after cap=${BASE_DAILY_CAP}/day + block-at-${BASE_BREAKER_R}R throttle.`);
  return throttled;
}

module.exports = { run, scanSymbol, resampleTo4h };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
