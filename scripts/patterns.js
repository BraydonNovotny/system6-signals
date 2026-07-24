// Ported VERBATIM from ll_backtest/engine.js's evalPatterns() -- keep byte-identical to
// the backtest source. If the backtest's pattern logic ever changes, this needs a manual
// re-port (this repo is a separate codebase, it does not auto-sync).
function evalPatterns(highs, lows, closes, opens, volumes, dayOf, i) {
  if (i < 4) return null;
  const isInside1 = highs[i - 1] <= highs[i - 2] && lows[i - 1] >= lows[i - 2];
  const isInside2 = highs[i - 2] <= highs[i - 3] && lows[i - 2] >= lows[i - 3];
  const compression = isInside1 && isInside2;
  const compBreakout = compression && highs[i] > Math.max(highs[i - 2], highs[i - 1]);
  const volDecay3 = volumes[i - 3] > volumes[i - 2] && volumes[i - 2] > volumes[i - 1];
  const dryUpBreakout3 = volDecay3 && isInside1 && highs[i] > Math.max(highs[i - 2], highs[i - 1]);

  function allInsideAnchor(anchorIdx, untilIdx) {
    if (anchorIdx < 0) return false;
    for (let k = anchorIdx + 1; k <= untilIdx; k++) {
      if (!(highs[k] <= highs[anchorIdx] && lows[k] >= lows[anchorIdx])) return false;
    }
    return true;
  }
  const looseTier2 = i - 3 >= 0 && allInsideAnchor(i - 3, i - 1) && highs[i] > highs[i - 3];
  const looseTier3 = i - 4 >= 0 && allInsideAnchor(i - 4, i - 1) && highs[i] > highs[i - 4];

  const openIdx = i - 3;
  const isOpeningBarUp = openIdx >= 0 && (openIdx === 0 || dayOf[openIdx] !== dayOf[openIdx - 1]) && closes[openIdx] > opens[openIdx];
  const openingPunch = isOpeningBarUp && allInsideAnchor(openIdx, i - 1) && highs[i] > highs[openIdx];

  return { compression, compBreakout, volDecay3, dryUpBreakout3, looseTier2, looseTier3, openingPunch, isInside1, isInside2 };
}

// Ported from website_stats_final.js's evalShortPatterns (mirror of the long-side eval).
function allInsideAnchor(highs, lows, a, u) {
  if (a < 0) return false;
  for (let k = a + 1; k <= u; k++) if (!(highs[k] <= highs[a] && lows[k] >= lows[a])) return false;
  return true;
}
function evalShortPatterns(highs, lows, closes, volumes, i, ema20) {
  if (i < 4) return null;
  const isInside1 = highs[i - 1] <= highs[i - 2] && lows[i - 1] >= lows[i - 2];
  const volDecay3 = volumes[i - 3] > volumes[i - 2] && volumes[i - 2] > volumes[i - 1];
  const dryDownBreakdown3 = volDecay3 && isInside1 && lows[i] < Math.min(lows[i - 2], lows[i - 1]);
  const looseTier2Short = i - 3 >= 0 && allInsideAnchor(highs, lows, i - 3, i - 1) && lows[i] < lows[i - 3];
  const rejection = closes[i - 1] > ema20[i - 1] && closes[i] < ema20[i];
  return { dryDownBreakdown3, looseTier2Short, rejection };
}

// LOCKED thresholds, ported from website_stats_final.js: compression tightness = 0.8,
// measured over 3 bars before breakout. Extension/EMA400/slope/regime-hold modes are all
// 'off' in the locked config -- not implemented here since they're not active.
const COMPRESSION_TIGHT_MAX = 0.8;
const COMPRESSION_WINDOW = 3;

function compRange(highsArr, lowsArr, i, window) {
  let hi = -Infinity, lo = Infinity;
  for (let k = 1; k <= window; k++) { hi = Math.max(hi, highsArr[i - k]); lo = Math.min(lo, lowsArr[i - k]); }
  return { hi, lo };
}

// Ported verbatim from ll_backtest/engine.js's SL_BUCKETS/slForAdr -- ADR-scaled stop
// distance as a % of price.
const SL_BUCKETS = [
  [0, 2.5, 1.25, 1.25], [2.5, 3, 1.25, 1.5], [3, 4, 1.5, 2.0], [4, 5, 2.0, 2.25],
  [5, 6, 2.25, 2.5], [6, 7, 2.5, 2.75], [7, 8, 2.75, 3.0], [8, 9, 3.0, 3.25],
  [9, 10, 3.25, 3.5], [10, 11, 3.5, 3.75],
];
// Widened 10% off the original tiered table -- OOS-confirmed to beat the un-widened
// version on every metric at once (CAGR, Sharpe, win rate, and even max drawdown).
const SL_WIDEN_MULT = 1.10;
function slForAdr(adrPct) {
  let base;
  if (adrPct > 11) base = 0.33 * adrPct;
  else {
    base = 1.25;
    for (const [lo, hi, sLo, sHi] of SL_BUCKETS) {
      if (adrPct >= lo && adrPct < hi) { base = hi === lo ? sLo : sLo + (adrPct - lo) / (hi - lo) * (sHi - sLo); break; }
    }
  }
  return base * SL_WIDEN_MULT;
}

module.exports = { evalPatterns, evalShortPatterns, COMPRESSION_TIGHT_MAX, COMPRESSION_WINDOW, compRange, slForAdr };
