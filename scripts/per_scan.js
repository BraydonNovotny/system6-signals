// Live Parabolic Exhaustion Reversal (PER) detection -- ported from ll_backtest's LOCKED
// config (build_parabolic_both_strict_signals.js): strict entry (first move off the
// opening 30m bar must be the reversal itself, or no trade), roster-gated both sides.
//   LONG (capitulation bounce): must be on the SHORT roster, runup <= -50% over 60 days,
//                                 gap <= -1%, hold up to 2 days.
//   SHORT (blow-off fade): must be on the LONG roster, runup >= 50% over 60 days,
//                           gap >= 3%, hold up to 1 day.
const { loadTickers } = require('./universe');
const { fetchChart, pool, loadData, dropIncompleteBars } = require('./lib');

const LOOKBACK = 60;
const CONFIG = {
  long: { runupMin: 50, gapMin: 1, rosterSide: 'short' },
  short: { runupMin: 50, gapMin: 3, rosterSide: 'long' },
};

async function fetchDaily(symbol) {
  const result = await fetchChart(symbol, 'range=1y&interval=1d');
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
  const result = await fetchChart(symbol, 'range=3d&interval=30m');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.volume[i] == null || q.open[i] == null) continue;
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] });
  }
  return dropIncompleteBars(bars, 1800);
}

function dateKeyOf(t) { return new Date(t * 1000).toISOString().slice(0, 10); }

async function run() {
  const data = loadData();
  const rosterLong = new Set(data.rosterLong || []);
  const rosterShort = new Set(data.rosterShort || []);
  const tickers = loadTickers();

  const dailyResults = await pool(tickers, fetchDaily, 8);
  const signals = [];

  for (let ti = 0; ti < tickers.length; ti++) {
    const symbol = tickers[ti];
    if (!dailyResults[ti].ok) continue;
    const daily = dailyResults[ti].value;
    if (daily.length < LOOKBACK + 25) continue;
    const last = daily.length - 1;
    const prevClose = daily[last - 1].close;
    const backClose = daily[last - 1 - LOOKBACK] ? daily[last - 1 - LOOKBACK].close : null;
    if (!backClose) continue;
    const runupPct = (prevClose - backClose) / backClose * 100;
    let sumDv = 0;
    for (let k = last - 21; k < last - 1; k++) sumDv += daily[k].close * daily[k].volume;
    const avgDollarVol = sumDv / 20;
    if (prevClose < 1 || avgDollarVol < 5e6) continue;
    const gapPct = (daily[last].open - prevClose) / prevClose * 100;

    // LOCKED config uses flat absolute thresholds (not dollar-volume-tiered) -- roster
    // membership itself is what carries the liquidity/quality gate.
    let side = null;
    if (runupPct >= CONFIG.short.runupMin && gapPct >= CONFIG.short.gapMin && rosterLong.has(symbol)) side = 'short';
    if (runupPct <= -CONFIG.long.runupMin && gapPct <= -CONFIG.long.gapMin && rosterShort.has(symbol)) side = 'long';
    if (!side) continue;

    signals.push({ symbol, side, runupPct: +runupPct.toFixed(1), gapPct: +gapPct.toFixed(2), avgDollarVol: Math.round(avgDollarVol), _needsEntry: true });
  }

  if (!signals.length) { console.log('PER: 0 candidates today.'); return []; }

  // strict entry check on today's 30m bars
  const intradayResults = await pool(signals.map(s => s.symbol), fetch30m, 8);
  const today = dateKeyOf(Date.now() / 1000);
  const entries = [];
  for (let si = 0; si < signals.length; si++) {
    const s = signals[si];
    if (!intradayResults[si].ok) continue;
    const bars = intradayResults[si].value;
    const dayBars = bars.filter(b => dateKeyOf(b.time) === today);
    if (dayBars.length < 2) continue;
    const firstBar = dayBars[0];
    let entryIdx = -1, entryPrice = null, entryTime = null, stopPrice = null, invalidated = false;
    if (s.side === 'short') {
      for (let k = 1; k < dayBars.length; k++) {
        if (dayBars[k].high > firstBar.high) { invalidated = true; break; }
        if (dayBars[k].low < firstBar.low) { entryIdx = k; entryPrice = firstBar.low; entryTime = dayBars[k].time; stopPrice = firstBar.high; break; }
      }
    } else {
      for (let k = 1; k < dayBars.length; k++) {
        if (dayBars[k].low < firstBar.low) { invalidated = true; break; }
        if (dayBars[k].high > firstBar.high) { entryIdx = k; entryPrice = firstBar.high; entryTime = dayBars[k].time; stopPrice = firstBar.low; break; }
      }
    }
    if (invalidated || entryIdx === -1) continue;
    entries.push({
      symbol: s.symbol, side: s.side, source: 'PER', entryPrice: +entryPrice.toFixed(2),
      stopPrice: +stopPrice.toFixed(2), barTime: entryTime, runupPct: s.runupPct, gapPct: s.gapPct, tf: '30m',
    });
  }
  console.log(`PER: ${signals.length} candidate(s), ${entries.length} valid strict-entry signal(s) today.`);
  return entries;
}

module.exports = { run };
if (require.main === module) run().then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e); process.exit(1); });
