// Ported directly from ll_backtest/engine.js -- must stay in sync if the backtest's
// definitions ever change (emaSeries, computeAdrSeries).
function emaSeries(vals, span) {
  const k = 2 / (span + 1);
  const out = new Array(vals.length);
  out[0] = vals[0];
  for (let i = 1; i < vals.length; i++) out[i] = vals[i] * k + out[i - 1] * (1 - k);
  return out;
}

function computeAdrSeries(dailyBars) {
  const adr = new Array(dailyBars.length).fill(null);
  for (let i = 13; i < dailyBars.length; i++) {
    let sumRange = 0;
    for (let k = i - 13; k <= i; k++) sumRange += (dailyBars[k].high - dailyBars[k].low);
    const avgRange = sumRange / 14;
    adr[i] = avgRange / dailyBars[i].close * 100;
  }
  return adr;
}

module.exports = { emaSeries, computeAdrSeries };
