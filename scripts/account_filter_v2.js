// Position management matching the ACTUAL 1065.2% locked system (ll_backtest/final_production_
// system.js), replacing the old System 6 account_filter.js entirely -- that file's -1R/-2R caps,
// 10-position limit, first-trade sizing, RS-boost, OB-size-down, and losing-week multipliers
// are ALL specific to the old, different architecture and don't apply here.
//
// Real rules: MAX_POS concurrent positions (10 for MAX, 15 for SAFE) + RESERVED_SLOTS (5) beyond
// that cap, shared by shelf/3x-inside/EP only -- base never competes for reserved slots. Base is
// ALSO separately capped at BASE_DAILY_CAP (5) new entries/day and blocked entirely for the rest
// of the day once base's own realized R hits BASE_BREAKER_R (-1) -- both handled upstream in
// scan_base_reclaim.js's applyDailyThrottle, not here; this file only handles the shared
// main-pool/reserved-pool capacity mechanics.
const { simulateExit } = require('./simulate_exit_v2');

const MAX_POS = 10, RESERVED_SLOTS = 5;

function runAccountFilter(candidates, barsBySymbol, carriedOpenCount = 0, previousDecisions = {}) {
  const sorted = candidates.slice().sort((a, b) => a.barTime - b.barTime || (a.symbol > b.symbol ? 1 : -1));
  const main = Array.from({ length: 0 }, () => ({}));
  const extra = [];
  // carried-open positions occupy main-pool slots first (matches the backtest's FIFO admission)
  for (let i = 0; i < carriedOpenCount; i++) main.push({ exitTime: null });
  const taken = [];
  const rejected = [];

  function settle(uptoTime) {
    for (const arr of [main, extra]) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].exitTime != null && arr[i].exitTime <= uptoTime) arr.splice(i, 1);
      }
    }
  }

  for (const sig of sorted) {
    settle(sig.barTime);
    const isPriority = sig.source !== 'CORE' || sig.patternTier !== 'base_4h_reclaim'; // shelf/3x-inside/EP = priority; base = not
    const prevKey = sig.symbol + '|' + sig.side + '|' + sig.barTime + '|' + sig.source;
    const prev = previousDecisions[prevKey];
    if (prev) {
      if (prev.taken) {
        taken.push(prev.trade);
        (isPriority && main.length >= MAX_POS ? extra : main).push({ exitTime: prev.trade.resolved ? sig.barTime + 1 : null });
      } else {
        rejected.push(prev.trade);
      }
      continue;
    }

    let admitted = false;
    if (main.length < MAX_POS) { main.push({ exitTime: null }); admitted = true; }
    else if (isPriority && extra.length < RESERVED_SLOTS) { extra.push({ exitTime: null }); admitted = true; }

    if (!admitted) { rejected.push({ ...sig, rejectReason: main.length >= MAX_POS && (!isPriority || extra.length >= RESERVED_SLOTS) ? 'max positions' : 'reserved slots full' }); continue; }

    const bars = barsBySymbol[sig.symbol] || [];
    const result = simulateExit(sig.side, sig.entryPrice, sig.stopPrice, sig.barTime, bars, sig.tf);
    const pos = (isPriority && main.length > MAX_POS ? extra : main)[(isPriority && main.length > MAX_POS ? extra : main).length - 1];
    taken.push({ ...sig, resolved: result.resolved, rMultiple: result.resolved ? result.rMultiple : null, liveR: result.liveR, gapped: result.gapped || false });
    if (result.resolved) pos.exitTime = sig.barTime + 1;
  }
  return { taken, rejected };
}

module.exports = { runAccountFilter };
