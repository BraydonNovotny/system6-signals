// Applies the account-simulation rules the backtest actually uses to decide which
// candidate signals get TAKEN, processed in chronological order (matching runFullTable):
//   - Daily loss cap: -1R (or -2R specifically for EP-30m, the locked override), reset
//     each new trading day. Only counts REALIZED (resolved) losses -- a still-open trade
//     doesn't count against the cap yet, since its outcome isn't known.
//   - Max 10 concurrent open positions (tracked via each trade's resolved/estimated exit).
//   - Spacing: max 5 new entries per 30-min window (applied earlier, upstream, per source).
// This is a best-effort LIVE approximation -- unlike the backtest, a forward-looking
// scanner can't know a trade's outcome before it happens, so an open trade is provisionally
// treated as R=0 for the cap check until it resolves on a later run (which may occasionally
// mean a later same-day signal gets taken that the full-hindsight backtest would have
// rejected, or vice versa). Documented, not hidden.
const { simulateExit } = require('./simulate_exit');

// carriedOpenCount: how many positions from PREVIOUS days are still genuinely open (not yet
// resolved) as of right now. These occupy real slots against the max-10-position limit even
// though they're not in today's candidate list -- BUG FIX: this was previously always 0,
// meaning every day started counting from a clean slate and ignored whatever capital was
// still tied up in yesterday's still-open trades. Their exitTime is unknown (we can't know
// the future), so they occupy a slot for the rest of today's run and never free up within it.
function runAccountFilter(candidates, barsBySymbol, carriedOpenCount = 0) {
  const sorted = candidates.slice().sort((a, b) => a.barTime - b.barTime);
  let dayLossR = 0;
  const openPositions = Array.from({ length: carriedOpenCount }, () => ({ exitTime: null })); // { exitTime }
  const taken = [];
  const rejected = []; // { ...sig, rejectReason }

  for (const sig of sorted) {
    // free up any positions that have resolved by this signal's entry time
    for (let i = openPositions.length - 1; i >= 0; i--) {
      if (openPositions[i].exitTime != null && openPositions[i].exitTime <= sig.barTime) openPositions.splice(i, 1);
    }

    const capThreshold = sig.source === 'EP' ? -2 : -1;
    if (dayLossR <= capThreshold) { rejected.push({ ...sig, rejectReason: 'daily loss cap' }); continue; }
    if (openPositions.length >= 10) { rejected.push({ ...sig, rejectReason: 'max positions (10)' }); continue; }

    const bars = barsBySymbol[sig.symbol] || [];
    const result = simulateExit(sig.side, sig.entryPrice, sig.stopPrice, sig.barTime, bars, sig.tf);

    const pos = { exitTime: null };
    openPositions.push(pos);
    taken.push({ ...sig, resolved: result.resolved, rMultiple: result.resolved ? result.rMultiple : null, liveR: result.liveR, gapped: result.gapped || false });
    if (result.resolved) {
      pos.exitTime = sig.barTime + 1; // resolved essentially immediately in our coarse view; frees the slot for the next check
      if (result.rMultiple < 0) dayLossR += result.rMultiple;
    }
  }
  return { taken, rejected };
}

module.exports = { runAccountFilter };
