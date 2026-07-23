// Live intraday entry-trigger detection -- the actual "what should I be doing right now"
// signal, not just the roster. Checks the MOST RECENTLY COMPLETED 30m bar for each
// roster-qualifying ticker against the exact same pattern/qual/tightness rules as the
// locked backtest (ll_backtest/website_stats_final.js buildCombinedSignals). EP and
// Parabolic overlays are NOT included yet -- core pattern signals only, phase 1.
const { emaSeries, computeAdrSeries } = require('./indicators');
const { evalPatterns, evalShortPatterns, COMPRESSION_TIGHT_MAX, COMPRESSION_WINDOW, compRange, slForAdr } = require('./patterns');
const { fetchChart, pool, loadData, saveData, ptDateString } = require('./lib');

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
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] });
  }
  return bars;
}

// Ported verbatim from website_stats_final.js's regimeSizeMult -- only need the 1.3-bucket
// check for the 9:30 open-bar restriction, not the full multiplier.
function regimeMultFromSpread(spread, side) {
  if (spread == null) return 1.0;
  if (side === 'long') { if (spread >= 0.4 && spread < 1.9) return 1.3; if (spread < 0 || spread >= 2.5) return 0.7; return 1.0; }
  if (spread <= -0.6 && spread > -3.4) return 1.3; if (spread > -0.2 || spread <= -5.0) return 0.7; return 1.0;
}

const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
function etSlot(unixSec) {
  const parts = etFmt.formatToParts(new Date(unixSec * 1000));
  const get = t => parts.find(p => p.type === t).value;
  let hh = get('hour'); if (hh === '24') hh = '00';
  return { slot: hh + ':' + get('minute'), weekday: get('weekday') };
}

async function run() {
  const data = loadData();
  const rosterLong = data.rosterLong || [];
  const rosterShort = data.rosterShort || [];
  const tickers = [...new Set([...rosterLong, ...rosterShort])];
  if (!tickers.length) { console.log('No roster tickers to scan (roster empty).'); return; }

  const qqqDaily = await fetchDaily('QQQ');
  const qqqCloses = qqqDaily.map(b => b.close);
  const qqqEma8 = emaSeries(qqqCloses, 8), qqqEma20 = emaSeries(qqqCloses, 20);
  const qLast = qqqDaily.length - 1;
  const spread8_20 = (qqqEma8[qLast] - qqqEma20[qLast]) / qqqEma20[qLast] * 100;

  const dailyResults = await pool(tickers, fetchDaily, 8);
  const intradayResults = await pool(tickers, fetch30m, 8);

  const signals = [];
  for (let ti = 0; ti < tickers.length; ti++) {
    const symbol = tickers[ti];
    if (!dailyResults[ti].ok || !intradayResults[ti].ok) continue;
    const daily = dailyResults[ti].value;
    const bars = intradayResults[ti].value;
    if (daily.length < 210 || bars.length < 10) continue;

    const dCloses = daily.map(b => b.close);
    const dEma50 = emaSeries(dCloses, 50), dEma200 = emaSeries(dCloses, 200);
    const dLast = daily.length - 1;
    const aboveEma50 = dCloses[dLast] > dEma50[dLast];
    const aboveEma200 = dCloses[dLast] > dEma200[dLast];
    const dist200Pct = (dCloses[dLast] - dEma200[dLast]) / dEma200[dLast] * 100;
    const adrPct = computeAdrSeries(daily)[dLast];
    if (adrPct == null) continue;

    const highs = bars.map(b => b.high), lows = bars.map(b => b.low), closes = bars.map(b => b.close), opens = bars.map(b => b.open), volumes = bars.map(b => b.volume);
    const dayOf = bars.map(b => Math.floor(b.time / 86400));
    const ema20 = emaSeries(closes, 20);
    const i = bars.length - 1; // most recently completed bar
    if (i < 20) continue;

    const barTime = bars[i].time;
    const { slot, weekday } = etSlot(barTime);
    if (weekday === 'Sat' || weekday === 'Sun') continue;

    const barRangePct = (highs[i] - lows[i]) / closes[i] * 100;
    const tightnessRatio = adrPct > 0 ? barRangePct / adrPct : null;

    const isLongRoster = rosterLong.includes(symbol);
    const isShortRoster = rosterShort.includes(symbol);

    if (isLongRoster) {
      const reclaim = closes[i - 1] < ema20[i - 1] && closes[i] > ema20[i];
      const pat = evalPatterns(highs, lows, closes, opens, volumes, dayOf, i);
      if (pat) {
        pat.reclaim = reclaim;
        const isSurfBase = closes[i] > ema20[i] && (closes[i] - ema20[i]) / ema20[i] < 0.04;
        const st = aboveEma50 && aboveEma200;
        let qual = 0;
        if (pat.dryUpBreakout3 && st) qual = 4; else if (pat.reclaim && st) qual = 3; else if (pat.looseTier2 && st) qual = 2; else if (isSurfBase) qual = 1;
        if (qual === 1 && !(dist200Pct > 0)) qual = 0;
        if (qual > 0) {
          const regimeMult = regimeMultFromSpread(spread8_20, 'long');
          const openOk = !(slot === '09:30' && (qual < 3 || regimeMult !== 1.3));
          let tightPass;
          if (qual === 4 && i >= COMPRESSION_WINDOW) {
            const { hi, lo } = compRange(highs, lows, i, COMPRESSION_WINDOW);
            const compRangePct = (hi - lo) / closes[i - 1] * 100;
            const compTightness = adrPct > 0 ? compRangePct / adrPct : null;
            tightPass = compTightness != null && compTightness <= COMPRESSION_TIGHT_MAX;
          } else {
            tightPass = tightnessRatio != null && tightnessRatio <= 0.6;
          }
          if (openOk && tightPass) {
            const R = slForAdr(adrPct) / 100;
            const entryPrice = closes[i], stopPrice = entryPrice * (1 - R);
            signals.push({ symbol, side: 'long', qual, entryPrice: +entryPrice.toFixed(2), stopPrice: +stopPrice.toFixed(2), barTime, patternTier: qual === 4 ? 'dryUpBreakout3' : qual === 3 ? 'reclaim' : qual === 2 ? 'looseTier2' : 'surfBase' });
          }
        }
      }
    }

    if (isShortRoster) {
      const sp = evalShortPatterns(highs, lows, closes, volumes, i, ema20);
      if (sp) {
        const st = !aboveEma50 && !aboveEma200;
        let qual = 0;
        if (sp.dryDownBreakdown3 && st) qual = 3; else if (sp.rejection && st) qual = 2; else if (sp.looseTier2Short && st) qual = 1;
        if (qual > 0) {
          const regimeMult = regimeMultFromSpread(spread8_20, 'short');
          const openOk = !(slot === '09:30' && (qual < 2 || regimeMult !== 1.3));
          let tightPass;
          if (qual === 3 && i >= COMPRESSION_WINDOW) {
            const { hi, lo } = compRange(highs, lows, i, COMPRESSION_WINDOW);
            const compRangePct = (hi - lo) / closes[i - 1] * 100;
            const compTightness = adrPct > 0 ? compRangePct / adrPct : null;
            tightPass = compTightness != null && compTightness <= COMPRESSION_TIGHT_MAX;
          } else {
            tightPass = tightnessRatio != null && tightnessRatio <= 0.6;
          }
          if (openOk && tightPass) {
            const R = slForAdr(adrPct) / 100;
            const entryPrice = closes[i], stopPrice = entryPrice * (1 + R);
            signals.push({ symbol, side: 'short', qual, entryPrice: +entryPrice.toFixed(2), stopPrice: +stopPrice.toFixed(2), barTime, patternTier: qual === 3 ? 'dryDownBreakdown3' : qual === 2 ? 'rejection' : 'looseTier2Short' });
          }
        }
      }
    }
  }

  data.liveSignals = signals;
  data.updated = data.updated || {};
  data.updated.entries = new Date().toISOString();
  saveData(data);
  console.log(`Entry scan: ${signals.length} signal(s) on the latest completed 30m bar, across ${tickers.length} roster tickers checked.`);
}

module.exports = { run };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
