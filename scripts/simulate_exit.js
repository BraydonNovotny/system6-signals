// Live exit simulation -- ported from ll_backtest/engine.js's simulateTradeConfig /
// simulateShortTradeConfig blended exit (25% fixed 2R target + 75% chandelier trail,
// arm=1.5R, trail=2.0R), applied to whatever forward bars are actually available. A
// signal entered recently may not have enough future bars yet to resolve -- returns
// { resolved: false } in that case, and the caller should re-check it on a later run.
//
// GAP-THROUGH-STOP: if a bar's OPEN has already gapped past the stop (a real overnight
// or fast-market gap), the fill happens at that worse open price, not the idealized
// stop level -- same fix applied to the main backtest after discovering it always
// assumed a perfect -1.00R fill, which understated real tail risk. So yes, this CAN
// show worse than -1R now when a real gap happens.
function simulateHalf(bars, entryIdx, side, entryPrice, R, mode) {
  const highs = bars.map(b => b.high), lows = bars.map(b => b.low), closes = bars.map(b => b.close), opens = bars.map(b => b.open);
  const stopPrice = side === 'long' ? entryPrice * (1 - R) : entryPrice * (1 + R);
  const scanEnd = bars.length - 1;
  let lastJ = entryIdx;

  function stopHitPrice(j) {
    const hit = side === 'long' ? lows[j] <= stopPrice : highs[j] >= stopPrice;
    if (!hit) return null;
    const gapped = side === 'long' ? opens[j] <= stopPrice : opens[j] >= stopPrice;
    return gapped ? opens[j] : stopPrice;
  }

  if (mode === 'fixed') {
    const targetR = 2.0;
    const targetPrice = side === 'long' ? entryPrice * (1 + targetR * R) : entryPrice * (1 - targetR * R);
    for (let j = entryIdx + 1; j <= scanEnd; j++) {
      lastJ = j;
      const stopPx = stopHitPrice(j);
      if (stopPx != null) { const ret = side === 'long' ? (stopPx - entryPrice) / entryPrice : (entryPrice - stopPx) / entryPrice; return { ret, resolved: true }; }
      const targetHit = side === 'long' ? highs[j] >= targetPrice : lows[j] <= targetPrice;
      if (targetHit) return { ret: targetR * R, resolved: true };
    }
    return { resolved: false }; // ran out of bars before resolving
  }

  // chandelier
  const armR = 1.5, trailR = 2.0;
  let armedTrail = false;
  let extreme = entryPrice; // highest close (long) or lowest close (short) since entry
  for (let j = entryIdx + 1; j <= scanEnd; j++) {
    lastJ = j;
    const stopPx = stopHitPrice(j);
    if (stopPx != null) { const ret = side === 'long' ? (stopPx - entryPrice) / entryPrice : (entryPrice - stopPx) / entryPrice; return { ret, resolved: true }; }
    if (side === 'long') { if (closes[j] > extreme) extreme = closes[j]; } else { if (closes[j] < extreme) extreme = closes[j]; }
    if (!armedTrail) {
      const armed = side === 'long' ? closes[j] >= entryPrice * (1 + armR * R) : closes[j] <= entryPrice * (1 - armR * R);
      if (armed) armedTrail = true;
    }
    if (armedTrail) {
      const trailHit = side === 'long' ? closes[j] < extreme * (1 - trailR * R) : closes[j] > extreme * (1 + trailR * R);
      if (trailHit) {
        const ret = side === 'long' ? (closes[j] - entryPrice) / entryPrice : (entryPrice - closes[j]) / entryPrice;
        return { ret, resolved: true };
      }
    }
  }
  return { resolved: false };
}

// bars: 30m bars array covering from before entryTime through "now" (as much forward
// data as currently exists). Returns { resolved, rMultiple, liveR } -- rMultiple only
// valid if resolved; liveR is always computed (mark-to-market R using the latest
// available close) so an open trade can show "how much it's up/down right now."
function simulateExit(side, entryPrice, stopPrice, entryTime, bars) {
  const entryIdx = bars.findIndex(b => b.time === entryTime);
  if (entryIdx === -1) return { resolved: false, liveR: null };
  const R = side === 'long' ? (entryPrice - stopPrice) / entryPrice : (stopPrice - entryPrice) / entryPrice;
  if (R <= 0) return { resolved: false, liveR: null };

  const lastClose = bars[bars.length - 1].close;
  const liveRet = side === 'long' ? (lastClose - entryPrice) / entryPrice : (entryPrice - lastClose) / entryPrice;
  const liveR = +(liveRet / R).toFixed(2);

  const half1 = simulateHalf(bars, entryIdx, side, entryPrice, R, 'fixed');
  const half2 = simulateHalf(bars, entryIdx, side, entryPrice, R, 'chandelier');
  if (!half1.resolved || !half2.resolved) return { resolved: false, liveR };
  const ret = 0.25 * half1.ret + 0.75 * half2.ret;
  return { resolved: true, rMultiple: +(ret / R).toFixed(2), liveR };
}

module.exports = { simulateExit };
