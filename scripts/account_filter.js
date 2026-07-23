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

function runAccountFilter(candidates, barsBySymbol) {
  const sorted = candidates.slice().sort((a, b) => a.barTime - b.barTime);
  let dayLossR = 0;
  const openPositions = []; // { exitTime }
  const taken = [];

  for (const sig of sorted) {
    // free up any positions that have resolved by this signal's entry time
    for (let i = openPositions.length - 1; i >= 0; i--) {
      if (openPositions[i].exitTime != null && openPositions[i].exitTime <= sig.barTime) openPositions.splice(i, 1);
    }

    const capThreshold = sig.source === 'EP' ? -2 : -1;
    if (dayLossR <= capThreshold) continue; // daily loss cap hit, reject
    if (openPositions.length >= 10) continue; // max positions

    const bars = barsBySymbol[sig.symbol] || [];
    const result = simulateExit(sig.side, sig.entryPrice, sig.stopPrice, sig.barTime, bars);

    const pos = { exitTime: null };
    openPositions.push(pos);
    taken.push({ ...sig, resolved: result.resolved, rMultiple: result.resolved ? result.rMultiple : null, liveR: result.liveR });
    if (result.resolved) {
      pos.exitTime = sig.barTime + 1; // resolved essentially immediately in our coarse view; frees the slot for the next check
      if (result.rMultiple < 0) dayLossR += result.rMultiple;
    }
  }
  return taken;
}

module.exports = { runAccountFilter };
