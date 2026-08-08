// Live exit simulation matching the ACTUAL 1065.2% locked system's real exit rule -- stop hit
// intraday, OR forced close at the end of the ENTRY DAY (same calendar day, ET), whichever
// comes first. NOT the old System 6 chandelier-trail/fixed-target exit (simulate_exit.js) --
// that system doesn't apply here at all; this system never holds past its own entry day.
const etDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
function etDate(unixSec) { return etDateFmt.format(new Date(unixSec * 1000)); }

function simulateExit(side, entryPrice, stopPrice, entryTime, bars, tf) {
  bars = bars.filter(b => (b.high - b.low) > b.close * 0.0001 || b.time === entryTime);
  const entryIdx = bars.findIndex(b => b.time === entryTime);
  if (entryIdx === -1) return { resolved: false, liveR: null };
  const R = side === 'long' ? (entryPrice - stopPrice) / entryPrice : (stopPrice - entryPrice) / entryPrice;
  if (R <= 0) return { resolved: false, liveR: null };

  const lastClose = bars[bars.length - 1].close;
  const liveRet = side === 'long' ? (lastClose - entryPrice) / entryPrice : (entryPrice - lastClose) / entryPrice;
  const liveR = +(liveRet / R).toFixed(2);

  const entryDay = etDate(entryTime);
  let exitPrice = null, exitTime = null, ranOutOfBars = true;
  for (let k = entryIdx + 1; k < bars.length; k++) {
    const b = bars[k];
    if (etDate(b.time) !== entryDay) { exitPrice = bars[k - 1].close; exitTime = bars[k - 1].time; ranOutOfBars = false; break; }
    const gapped = side === 'long' ? b.open <= stopPrice : b.open >= stopPrice;
    const stopHit = side === 'long' ? b.low <= stopPrice : b.high >= stopPrice;
    if (stopHit) { exitPrice = gapped ? b.open : stopPrice; exitTime = b.time; ranOutOfBars = false; break; }
    if (k === bars.length - 1) { exitPrice = b.close; exitTime = b.time; } // still same day, haven't seen next-day bar yet -- tentative, may still resolve on a later run
  }
  if (exitPrice == null) return { resolved: false, liveR }; // no bars yet past entry at all
  if (ranOutOfBars) return { resolved: false, liveR }; // still within entry day, haven't confirmed EOD close yet -- keep waiting for the next-day bar to appear

  const ret = side === 'long' ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
  return { resolved: true, rMultiple: +(ret / R).toFixed(3), liveR, gapped: false };
}

module.exports = { simulateExit };
