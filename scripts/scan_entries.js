// Live intraday entry-trigger detection -- the actual "what should I be doing right now"
// signal, not just the roster. Checks the MOST RECENTLY COMPLETED 30m bar for each
// roster-qualifying ticker against the exact same pattern/qual/tightness rules as the
// locked backtest (ll_backtest/website_stats_final.js buildCombinedSignals). EP and
// Parabolic overlays are NOT included yet -- core pattern signals only, phase 1.
const { emaSeries, computeAdrSeries, rsiSeries } = require('./indicators');
const { evalPatterns, evalShortPatterns, COMPRESSION_TIGHT_MAX, COMPRESSION_WINDOW, compRange, slForAdr } = require('./patterns');
const { fetchChart, pool, loadData, saveData, ptDateString, dropIncompleteBars } = require('./lib');

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

// Ported verbatim from website_stats_final.js's regimeSizeMult -- only need the 1.3-bucket
// check for the 9:30 open-bar restriction, not the full multiplier.
function regimeMultFromSpread(spread, side) {
  if (spread == null) return 1.0;
  if (side === 'long') { if (spread >= 0.4 && spread < 1.9) return 1.3; if (spread < 0 || spread >= 2.5) return 0.7; return 1.0; }
  if (spread <= -0.6 && spread > -3.4) return 1.3; if (spread > -0.2 || spread <= -5.0) return 0.7; return 1.0;
}

function ptDateOf(ts) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(ts * 1000));
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
  // LOCKED (2026-07-27): QQQ RSI14 overbought sizing, longs only -- always-on in the backtest
  // (not previously ported here). Threshold/mult loosened from 70/0.5x to 75/0.7x this session,
  // confirmed via full component sweep + permutation test (0/30 beat it).
  const qqqRsi14Series = rsiSeries(qqqCloses, 14);
  const qqqRsi14 = qqqRsi14Series[qLast];
  const QQQ_RSI_SIZE_THRESH = 75, QQQ_RSI_SIZE_MULT = 0.7;
  const rsiSizeMult = (qqqRsi14 != null && qqqRsi14 >= QQQ_RSI_SIZE_THRESH) ? QQQ_RSI_SIZE_MULT : 1.0;
  // LOCKED (2026-07-29, "4-Combo" in ll_backtest): two NEW sizing levers, longs only, both
  // using QQQ's PRIOR-DAY (qLast, already-closed session) values -- causal, no hindsight.
  // (a) RS-BOOST: size UP 1.5x when the stock's own 3-week RS vs QQQ is >=+5 while QQQ's
  // 2D RSI is oversold (<=15) -- lean into leadership names during a market pullback.
  // (b) OVERBOUGHT-SIZE-DOWN: size DOWN 0.5x when QQQ's 14D RSI is >=80 -- STACKS
  // multiplicatively with the existing 75/0.7x cut above (both fire together at RSI>=80,
  // giving 0.35x combined) -- this is exactly how it was tested in ll_backtest (the 75/0.7
  // rule was never disabled during any of that testing), not a replacement for it.
  const qqqRsi2Series = rsiSeries(qqqCloses, 2);
  const qqqRsi2 = qqqRsi2Series[qLast];
  const RS_BOOST_QQQ_RSI2_MAX = 15, RS_BOOST_RS_MIN = 5, RS_BOOST_MULT = 1.5;
  const OB_SIZE_DOWN_THRESH = 80, OB_SIZE_DOWN_MULT = 0.5;
  const obSizeDownMult = (qqqRsi14 != null && qqqRsi14 >= OB_SIZE_DOWN_THRESH) ? OB_SIZE_DOWN_MULT : 1.0;
  // LOCKED (2026-07-29): the 7/28 entry-block needs QQQ's OWN intraday move today (from
  // yesterday's close to the current entry bar) -- fetch QQQ's own 30m bars alongside the
  // stock universe. Real trigger example: 2026-07-28, QQQ 2D RSI closed 7.79 the day before,
  // then fell another ~1.9% intraday by 7:00am PT while ACHR/JOBY/ORCL/QCOM/QS were each
  // already down 3.8-5%+ before the entry bar even printed.
  const qqqIntraday = await fetch30m('QQQ');
  const qqqPrevClose = qqqCloses[qLast];
  function qqqMoveAtOrBefore(targetTime) {
    let best = null;
    for (const b of qqqIntraday) { if (b.time <= targetTime) best = b; else break; }
    if (!best) return null;
    return (best.close - qqqPrevClose) / qqqPrevClose * 100;
  }
  const RULE728_QQQ_RSI2_MAX = 15, RULE728_QQQ_MOVE_MAX = -1.0, RULE728_STOCK_ADR_MAX = -0.65;

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
    // LOCKED (2026-07-27): 20-day avg $ volume, for the combined first-trade-of-day +
    // liquidity sizing lever (see account_filter.js) -- IS/OOS confirmed both together with
    // the existing first-trade rule.
    let avgDollarVol20 = null;
    if (dLast - 19 >= 0) {
      let sum = 0;
      for (let k = dLast - 19; k <= dLast; k++) sum += daily[k].volume * daily[k].close;
      avgDollarVol20 = sum / 20;
    }
    // LOCKED (2026-07-27): 3-week RS vs QQQ, long-only entry filter -- IS/OOS confirmed
    // requiring the stock to have outperformed QQQ over the trailing 15 trading days
    // (rsVsQqq3w >= 0) before taking a long, moved CAGR/Sharpe up together on both IS and
    // OOS (OOS CAGR 472.2%->511.5%, Sharpe 4.005->4.103, maxDD unchanged). Short side untested/unfiltered.
    let rsVsQqq3w = null;
    if (dLast - 15 >= 0 && qLast - 15 >= 0) {
      const stockRet = (dCloses[dLast] / dCloses[dLast - 15] - 1) * 100;
      const qqqRet = (qqqCloses[qLast] / qqqCloses[qLast - 15] - 1) * 100;
      rsVsQqq3w = stockRet - qqqRet;
    }

    const highs = bars.map(b => b.high), lows = bars.map(b => b.low), closes = bars.map(b => b.close), opens = bars.map(b => b.open), volumes = bars.map(b => b.volume);
    const dayOf = bars.map(b => Math.floor(b.time / 86400));
    const ema20 = emaSeries(closes, 20);
    const ema8 = emaSeries(closes, 8);

    // Check EVERY bar of TODAY (not just the most recent), so a run always self-heals any
    // gap since the last check -- a signal earlier today never gets silently missed just
    // because this particular run happened to fire late or a prior trigger was skipped.
    const lastIdx = bars.length - 1;
    if (lastIdx < 20) continue;
    // BUG FIX: the last fetched bar isn't necessarily FROM today -- if this symbol's data
    // feed hasn't posted today's bars yet (lag, or ran before/right at the open), bars[lastIdx]
    // can still be a prior trading day's (e.g. Friday's) last bar. Evaluating that as if it
    // were "today" and then having the caller stamp it with the real wall-clock date (in
    // run.js) mislabels an old, already-resolved signal as a brand-new one. Skip this symbol
    // entirely this run if the last bar isn't actually dated today.
    if (ptDateOf(bars[lastIdx].time) !== ptDateString()) continue;
    const todayDayNum = dayOf[lastIdx];
    let todayStart = lastIdx;
    while (todayStart > 0 && dayOf[todayStart - 1] === todayDayNum) todayStart--;
    todayStart = Math.max(todayStart, 20);

    const isLongRoster = rosterLong.includes(symbol);
    const isShortRoster = rosterShort.includes(symbol);
    let firedLong = false, firedShort = false; // only alert once per symbol+side per day --
    // the first bar a setup becomes true, not every subsequent bar it remains true.

    for (let i = todayStart; i <= lastIdx; i++) {
    const barTime = bars[i].time;
    const { slot, weekday } = etSlot(barTime);
    if (weekday === 'Sat' || weekday === 'Sun') continue;

    const barRangePct = (highs[i] - lows[i]) / closes[i] * 100;
    const tightnessRatio = adrPct > 0 ? barRangePct / adrPct : null;

    if (isLongRoster && !firedLong) {
      const reclaim = closes[i - 1] < ema20[i - 1] && closes[i] > ema20[i];
      const pat = evalPatterns(highs, lows, closes, opens, volumes, dayOf, i);
      if (pat) {
        pat.reclaim = reclaim;
        const isSurfBase = closes[i] > ema20[i] && (closes[i] - ema20[i]) / ema20[i] < 0.04;
        const st = aboveEma50 && aboveEma200;
        // Confluence tier (q0.5): 8ema reclaim + 2-bar volume decay + tight bar -- additive
        // only, fires when nothing else matched. Highest win% (75.6%) / avgR (0.500) of any
        // tier in the locked backtest. Ported from ll_backtest's buildCombinedSignals.
        const reclaim8 = i >= 1 && ema8[i - 1] != null && closes[i - 1] < ema8[i - 1] && closes[i] > ema8[i];
        const volDecay2Long = i >= 2 && volumes[i - 2] > volumes[i - 1];
        const tightNowLong = tightnessRatio != null && tightnessRatio <= 0.6;
        let qual = 0;
        if (pat.dryUpBreakout3 && st) qual = 4; else if (pat.reclaim && st) qual = 3; else if (pat.looseTier2 && st) qual = 2; else if (isSurfBase) qual = 1; else if (reclaim8 && volDecay2Long && tightNowLong && st) qual = 0.5;
        if (qual === 1 && !(dist200Pct > 0)) qual = 0;
        if (qual > 0 && rsVsQqq3w != null && rsVsQqq3w < 0) qual = 0; // RS3w exclude filter
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
            // RS-BOOST (see declaration above): stock's own 3-week RS >=+5 AND QQQ oversold
            // (2D RSI<=15) the prior day -- both already-known, causal values.
            const rsBoostMult = (qqqRsi2 != null && qqqRsi2 <= RS_BOOST_QQQ_RSI2_MAX && rsVsQqq3w != null && rsVsQqq3w >= RS_BOOST_RS_MIN) ? RS_BOOST_MULT : 1.0;
            signals.push({ symbol, side: 'long', qual, entryPrice: +entryPrice.toFixed(2), stopPrice: +stopPrice.toFixed(2), barTime, patternTier: qual === 4 ? 'dryUpBreakout3' : qual === 3 ? 'reclaim' : qual === 2 ? 'looseTier2' : qual === 1 ? 'surfBase' : 'confluence8ema', tf: '30m', rsVsQqq3w: rsVsQqq3w != null ? +rsVsQqq3w.toFixed(2) : null, avgDollarVol20, qqqRsi14: qqqRsi14 != null ? +qqqRsi14.toFixed(1) : null, rsiSizeMult, rsBoostMult, obSizeDownMult });
            firedLong = true;
          }
        }
      }
    }

    if (isShortRoster && !firedShort) {
      const sp = evalShortPatterns(highs, lows, closes, volumes, i, ema20);
      if (sp) {
        const st = !aboveEma50 && !aboveEma200;
        // Short mirror of the q0.5 confluence tier: 8ema rejection + 2-bar volume decay +
        // tight bar. Ported from ll_backtest's buildCombinedSignals.
        const bounce8 = i >= 1 && ema8[i - 1] != null && closes[i - 1] > ema8[i - 1] && closes[i] < ema8[i];
        const volDecay2Short = i >= 2 && volumes[i - 2] > volumes[i - 1];
        const tightNowShort = tightnessRatio != null && tightnessRatio <= 0.6;
        let qual = 0;
        if (sp.dryDownBreakdown3 && st) qual = 3; else if (sp.rejection && st) qual = 2; else if (sp.looseTier2Short && st) qual = 1; else if (bounce8 && volDecay2Short && tightNowShort && st) qual = 0.4;
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
            // 7/28 RULE (entry block, see declaration above): skip this short entirely when
            // QQQ was already oversold the prior day AND is still falling intraday AND the
            // stock itself has already moved hard before we'd even enter -- a 3-way AND,
            // all causal (prior-day RSI, today's-so-far QQQ move, today's-so-far stock move).
            const stockPreEntryMove = adrPct > 0 ? (entryPrice - dCloses[dLast]) / dCloses[dLast] * 100 / adrPct : null;
            const qqqMoveNow = qqqMoveAtOrBefore(barTime);
            const rule728Active = qqqRsi2 != null && qqqRsi2 <= RULE728_QQQ_RSI2_MAX &&
              qqqMoveNow != null && qqqMoveNow <= RULE728_QQQ_MOVE_MAX &&
              stockPreEntryMove != null && stockPreEntryMove <= RULE728_STOCK_ADR_MAX;
            if (rule728Active) { firedShort = true; continue; } // treat as fired (don't re-check later bars today) but emit no signal
            signals.push({ symbol, side: 'short', qual, entryPrice: +entryPrice.toFixed(2), stopPrice: +stopPrice.toFixed(2), barTime, patternTier: qual === 3 ? 'dryDownBreakdown3' : qual === 2 ? 'rejection' : qual === 1 ? 'looseTier2Short' : 'confluence8ema', tf: '30m', avgDollarVol20 });
            firedShort = true;
          }
        }
      }
    }
    } // end of today's-bars loop
  }

  // Spacing cap, ported from the locked backtest's SPACING = { maxNewPerWindow: 5,
  // windowSec: 1800 }: at most 5 new signals per 30-min window, highest qual kept first.
  // NOTE: this does NOT replicate the backtest's -1R daily loss cap or max-10-positions
  // limit (those require knowing realized outcomes / open-position state, which a live
  // forward-looking scanner can't know in advance) -- so this list is still closer to the
  // backtest's raw "signals seen" pool than its filtered "taken" trades. Treat qual tier
  // as your priority ranking; don't take everything on the list every day.
  signals.sort((a, b) => a.barTime - b.barTime || b.qual - a.qual);
  const spaced = [];
  const windowEntries = [];
  for (const s of signals) {
    while (windowEntries.length && s.barTime - windowEntries[0] > 1800) windowEntries.shift();
    if (windowEntries.length >= 5) continue;
    windowEntries.push(s.barTime);
    spaced.push(s);
  }

  console.log(`Entry scan: ${spaced.length} signal(s) after spacing (${signals.length} before), ${tickers.length} roster tickers checked.`);
  return spaced.map(s => ({ ...s, source: 'CORE' }));
}

module.exports = { run };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
