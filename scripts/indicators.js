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

function rsiSeries(vals, span) {
  const out = new Array(vals.length).fill(null);
  if (vals.length <= span) return out;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= span; i++) {
    const diff = vals[i] - vals[i - 1];
    if (diff >= 0) gainSum += diff; else lossSum -= diff;
  }
  let avgGain = gainSum / span, avgLoss = lossSum / span;
  out[span] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = span + 1; i < vals.length; i++) {
    const diff = vals[i] - vals[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (span - 1) + gain) / span;
    avgLoss = (avgLoss * (span - 1) + loss) / span;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

module.exports = { emaSeries, computeAdrSeries, rsiSeries };
