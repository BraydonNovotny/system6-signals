// Live EP (episodic pivot) scanner -- CONSOLIDATED 2026-08-08 per the curve-fit audit: "h3"
// was found to be a near-total subset of "Loosened" (118/119 signals overlapped) while also
// failing its own lumpiness check -- dropped. This implements "Loosened" only, matching
// ll_backtest/build_ep_signals.js + build_ep_loosened_signals.js (tercile 1/2, i.e. LOOSER
// than the original tightest-third cut -- top TWO-THIRDS of first-bar looseness qualify).
//
// Candidate definition (matches ll_backtest/scan_ep_v3.js): gap >= 8% from prior close,
// volume >= 2x the trailing 20-day average. LIVE ADAPTATION: the backtest's volume filter
// uses the FULL day's total volume (only knowable at close), but the entry itself fires
// intraday on breaking the first bar's high -- so this uses a run-rate projection (volume
// so far / fraction of the session elapsed) as the real-time equivalent, not a full-day
// value. This is an operational necessity for live entry timing, not a rule simplification.
const { emaSeries } = require('./indicators');
const { fetchChart, pool, ptDateString, ptNowDecimalHour, dropIncompleteBars } = require('./lib');
const UNIVERSE_233 = require('./universe_233.js');

const GAP_MIN_PCT = 8, VOL_RATIO_MIN = 2.0;
const TERCILE_FRAC = 2 / 3; // "Loosened": top two-thirds of first-bar looseness qualify

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

// Fraction of the regular session (9:30-16:00 ET, 6.5h) elapsed as of a given bar's close.
function sessionFractionElapsed(barTimeSec) {
  const etParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(barTimeSec * 1000));
  const get = t => etParts.find(p => p.type === t).value;
  let hh = parseInt(get('hour'), 10); if (hh === 24) hh = 0;
  const mm = parseInt(get('minute'), 10);
  const minutesSinceOpen = (hh - 9.5) * 60 + mm;
  return Math.max(0.05, Math.min(1, minutesSinceOpen / 390));
}

function isGapCandidate(daily, i) {
  if (i < 21) return null;
  const b = daily[i], prev = daily[i - 1];
  const gapPct = (b.open - prev.close) / prev.close * 100;
  if (gapPct < GAP_MIN_PCT) return null;
  let volSum = 0;
  for (let k = i - 20; k < i; k++) volSum += daily[k].volume;
  const avgVol20 = volSum / 20;
  return { gapPct, avgVol20, prevClose: prev.close };
}

async function scanSymbol(symbol, daily, bars30, qqqBullishToday) {
  if (daily.length < 260 || !qqqBullishToday) return null;
  const todayStr = ptDateString();
  const dLast = daily.length - 1;
  if (etDate(daily[dLast].time) !== todayStr) return null; // today's daily bar not posted yet

  const cand = isGapCandidate(daily, dLast);
  if (!cand) return null;

  const dayBars = bars30.filter(b => etDate(b.time) === todayStr);
  if (dayBars.length < 2) return null;
  const firstBar = dayBars[0];
  let entryIdx = -1, entryPrice = null, entryTime = null;
  for (let k = 1; k < dayBars.length; k++) {
    if (dayBars[k].high > firstBar.high) { entryIdx = k; entryPrice = firstBar.high; entryTime = dayBars[k].time; break; }
  }
  if (entryIdx === -1) return null;

  // volume run-rate check as of the entry bar (real-time equivalent of the full-day filter)
  const volSoFar = dayBars.slice(0, entryIdx + 1).reduce((s, b) => s + b.volume, 0);
  const frac = sessionFractionElapsed(dayBars[entryIdx].time);
  const projectedFullDayVol = volSoFar / frac;
  const volRatio = projectedFullDayVol / cand.avgVol20;
  if (volRatio < VOL_RATIO_MIN) return null;

  let lod = firstBar.low;
  for (let k = 1; k <= entryIdx; k++) lod = Math.min(lod, dayBars[k].low);
  const stopPrice = lod;
  const R = (entryPrice - stopPrice) / entryPrice;
  if (R <= 0 || R > 0.25) return null;

  // 14d ADR-based first-bar looseness, for the tercile-vs-history tightness check
  let sumRange = 0;
  for (let k = dLast - 14; k < dLast; k++) sumRange += (daily[k].high - daily[k].low);
  const adrPrevDay = (sumRange / 14) / daily[dLast - 1].close * 100;
  const firstBarRangePct = (firstBar.high - firstBar.low) / firstBar.open * 100;
  const firstBarLooseness = adrPrevDay > 0 ? firstBarRangePct / adrPrevDay : null;

  return {
    symbol, side: 'long', qual: 4, entryPrice: +entryPrice.toFixed(4), stopPrice: +stopPrice.toFixed(4),
    barTime: entryTime, patternTier: 'ep_loosened', tf: '30m', source: 'EP', firstBarLooseness,
  };
}

// Builds the historical looseness population (trailing ~1yr of daily bars, same candidate
// definition) to compute the tercile threshold today's candidates get judged against --
// same statistical basis as the backtest, just computed live instead of from a cached pool.
function historicalLoosenessThreshold(daily) {
  const looseVals = [];
  for (let i = 260; i < daily.length - 1; i++) { // stop before today, causal
    const cand = isGapCandidate(daily, i);
    if (!cand) continue;
    let sumRange = 0;
    for (let k = i - 14; k < i; k++) sumRange += (daily[k].high - daily[k].low);
    const adrPrevDay = (sumRange / 14) / daily[i - 1].close * 100;
    const rangePct = (daily[i].high - daily[i].low) / daily[i].open * 100; // approx using daily range as proxy
    if (adrPrevDay > 0) looseVals.push(rangePct / adrPrevDay);
  }
  if (!looseVals.length) return null;
  looseVals.sort((a, b) => a - b);
  return looseVals[Math.floor(looseVals.length * TERCILE_FRAC)];
}

async function run() {
  const qqqDaily = await fetchDaily('QQQ');
  const qqqCloses = qqqDaily.map(b => b.close);
  const qqqEma8 = emaSeries(qqqCloses, 8), qqqEma20 = emaSeries(qqqCloses, 20);
  const qLast = qqqDaily.length - 1;
  // causal: use PRIOR day's QQQ bullish state, not today's still-forming one
  const qqqBullishToday = qqqEma8[qLast - 1] != null && qqqEma20[qLast - 1] != null && qqqEma8[qLast - 1] > qqqEma20[qLast - 1];

  if (!qqqBullishToday) { console.log('EP scan: QQQ not bullish (prior day) -- skipping (EP is long-only, gated on regime).'); return []; }

  const dailyResults = await pool(UNIVERSE_233, fetchDaily, 8);
  const bars30Results = await pool(UNIVERSE_233, fetch30m, 8);

  const raw = [];
  for (let ti = 0; ti < UNIVERSE_233.length; ti++) {
    if (!dailyResults[ti].ok || !bars30Results[ti].ok) continue;
    const sig = await scanSymbol(UNIVERSE_233[ti], dailyResults[ti].value, bars30Results[ti].value, qqqBullishToday);
    if (sig) raw.push({ sig, daily: dailyResults[ti].value });
  }

  const signals = [];
  for (const { sig, daily } of raw) {
    if (sig.firstBarLooseness == null) continue;
    const threshold = historicalLoosenessThreshold(daily);
    if (threshold == null || sig.firstBarLooseness > threshold) continue; // must be in the loose (top 2/3 tightest) bucket
    delete sig.firstBarLooseness;
    signals.push(sig);
  }
  console.log(`EP scan: ${raw.length} gap+volume candidate(s), ${signals.length} passing the looseness tercile.`);
  return signals;
}

module.exports = { run, scanSymbol };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
