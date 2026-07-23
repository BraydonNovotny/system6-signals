// Live exit simulation -- ported from ll_backtest/engine.js's simulateTradeConfig /
// simulateShortTradeConfig blended exit (25% fixed 2R target + 75% chandelier trail,
// arm=1.5R, trail=2.0R), applied to whatever forward bars are actually available. A
// signal entered recently may not have enough future bars yet to resolve -- returns
// { resolved: false } in that case, and the caller should re-check it on a later run.
//
// MAX-HOLD CAP: the backtest's engine.js caps every trade's scan window at maxScan bars
// (13 for 30m ~= one trading day, 7 for 1h ~= one trading day) and FORCE-CLOSES at that
// bar's close if nothing else triggered first -- it never lets the simulation run forever
// looking for a nicer exit. This file originally had no such cap, so a strong-trending
// trade could sit "LIVE" for days waiting for a stop/target/trail that might not come for
// a while, which doesn't match how the actual (backtested, locked) strategy behaves.
//
// GAP-THROUGH-STOP: if a bar's OPEN has already gapped past the stop (a real overnight
// or fast-market gap), the fill happens at that worse open price, not the idealized
// stop level -- same fix applied to the main backtest after discovering it always
// assumed a perfect -1.00R fill, which understated real tail risk. So yes, this CAN
// show worse than -1R now when a real gap happens.
function simulateHalf(bars, entryIdx, side, entryPrice, R, mode, maxScan) {
  const highs = bars.map(b => b.high), lows = bars.map(b => b.low), closes = bars.map(b => b.close), opens = bars.map(b => b.open);
  const stopPrice = side === 'long' ? entryPrice * (1 - R) : entryPrice * (1 + R);
  const scanEnd = Math.min(bars.length - 1, entryIdx + maxScan);
  const ranOutOfBars = scanEnd < entryIdx + maxScan; // fewer bars fetched than the hold window needs
  let lastJ = entryIdx;

  function stopHitPrice(j) {
    const hit = side === 'long' ? lows[j] <= stopPrice : highs[j] >= stopPrice;
    if (!hit) return null;
    const gapped = side === 'long' ? opens[j] <= stopPrice : opens[j] >= stopPrice;
    return { price: gapped ? opens[j] : stopPrice, gapped };
  }

  if (mode === 'fixed') {
    const targetR = 2.0;
    const targetPrice = side === 'long' ? entryPrice * (1 + targetR * R) : entryPrice * (1 - targetR * R);
    for (let j = entryIdx + 1; j <= scanEnd; j++) {
      lastJ = j;
      const stopHit = stopHitPrice(j);
      if (stopHit) { const ret = side === 'long' ? (stopHit.price - entryPrice) / entryPrice : (entryPrice - stopHit.price) / entryPrice; return { ret, resolved: true, gapped: stopHit.gapped }; }
      const targetHit = side === 'long' ? highs[j] >= targetPrice : lows[j] <= targetPrice;
      if (targetHit) return { ret: targetR * R, resolved: true, gapped: false };
    }
    if (ranOutOfBars) return { resolved: false }; // haven't reached the hold cap yet -- keep waiting
    const ret = side === 'long' ? (closes[lastJ] - entryPrice) / entryPrice : (entryPrice - closes[lastJ]) / entryPrice;
    return { ret, resolved: true, gapped: false }; // hit the max-hold cap -- force-close at that bar's close
  }

  // chandelier
  const armR = 1.5, trailR = 2.0;
  let armedTrail = false;
  let extreme = entryPrice; // highest close (long) or lowest close (short) since entry
  for (let j = entryIdx + 1; j <= scanEnd; j++) {
    lastJ = j;
    const stopHit = stopHitPrice(j);
    if (stopHit) { const ret = side === 'long' ? (stopHit.price - entryPrice) / entryPrice : (entryPrice - stopHit.price) / entryPrice; return { ret, resolved: true, gapped: stopHit.gapped }; }
    if (side === 'long') { if (closes[j] > extreme) extreme = closes[j]; } else { if (closes[j] < extreme) extreme = closes[j]; }
    if (!armedTrail) {
      const armed = side === 'long' ? closes[j] >= entryPrice * (1 + armR * R) : closes[j] <= entryPrice * (1 - armR * R);
      if (armed) armedTrail = true;
    }
    if (armedTrail) {
      const trailHit = side === 'long' ? closes[j] < extreme * (1 - trailR * R) : closes[j] > extreme * (1 + trailR * R);
      if (trailHit) {
        const ret = side === 'long' ? (closes[j] - entryPrice) / entryPrice : (entryPrice - closes[j]) / entryPrice;
        return { ret, resolved: true, gapped: false };
      }
    }
  }
  if (ranOutOfBars) return { resolved: false }; // haven't reached the hold cap yet -- keep waiting
  const ret = side === 'long' ? (closes[lastJ] - entryPrice) / entryPrice : (entryPrice - closes[lastJ]) / entryPrice;
  return { ret, resolved: true, gapped: false }; // hit the max-hold cap -- force-close at that bar's close
}

// bars: 30m/1h bars array covering from before entryTime through "now" (as much forward
// data as currently exists). Returns { resolved, rMultiple, liveR } -- rMultiple only
// valid if resolved; liveR is always computed (mark-to-market R using the latest
// available close) so an open trade can show "how much it's up/down right now."
// tf: '30m' (default, maxScan=13 bars ~= 1 trading day) or '1h' (maxScan=7 bars).
function simulateExit(side, entryPrice, stopPrice, entryTime, bars, tf) {
  const entryIdx = bars.findIndex(b => b.time === entryTime);
  if (entryIdx === -1) return { resolved: false, liveR: null };
  const R = side === 'long' ? (entryPrice - stopPrice) / entryPrice : (stopPrice - entryPrice) / entryPrice;
  if (R <= 0) return { resolved: false, liveR: null };
  const maxScan = tf === '1h' ? 7 : 13;

  const lastClose = bars[bars.length - 1].close;
  const liveRet = side === 'long' ? (lastClose - entryPrice) / entryPrice : (entryPrice - lastClose) / entryPrice;
  const liveR = +(liveRet / R).toFixed(2);

  const half1 = simulateHalf(bars, entryIdx, side, entryPrice, R, 'fixed', maxScan);
  const half2 = simulateHalf(bars, entryIdx, side, entryPrice, R, 'chandelier', maxScan);
  if (!half1.resolved || !half2.resolved) return { resolved: false, liveR };
  const ret = 0.25 * half1.ret + 0.75 * half2.ret;
  return { resolved: true, rMultiple: +(ret / R).toFixed(2), liveR, gapped: half1.gapped || half2.gapped };
}

module.exports = { simulateExit };
