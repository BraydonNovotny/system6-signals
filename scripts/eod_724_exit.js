// LOCKED strategy rule (2026-07-29, "7/24 rule" in ll_backtest): at end of day, if QQQ's OWN
// 2D RSI closes <=10 while QQQ is STILL above its 200ema and is >=5x its 14-day ADR off its own
// 52-week high, force-close any currently open SHORT position -- a genuine oversold-bounce-risk
// day (extended pullback within an intact longer-term uptrend), not a loose "still above the
// ema" filter. Uses only TODAY's own now-known daily close -- no future data, no hindsight,
// decided at EOD exactly like the already-live eod_cap_trigger_reaction.js.
//
// Traced directly to the real 2026-07-24 loss cluster on this site: SOFI/PLTR/HIMS/IONQ/RKLB
// were all short positions caught in a bounce off a 6x+ ADR pullback while QQQ's 2D RSI had
// cratered to ~9.7 -- exactly the scenario this rule targets. Passed the full 4-step
// overfitting check in ll_backtest: IS/OOS on both the fixed and extended windows, a parameter
// sweep across every threshold tested (smooth, no cliffs), lumpiness (broad-based across 100+
// tickers, 37-51 months, top-10 trades <10% of total R), and a 30-seed permutation test (p=0/30
// on IS Sharpe, IS CAGR, OOS Sharpe, OOS CAGR).
const { fetchChart, ptDateString } = require('./lib');

const RSI2_MAX = 10;
const DIST_52W_ADR_MIN = 5.0;
const LOOKBACK_DAYS = 10; // same window resolve_pending.js/eod_cap_trigger_reaction.js use for "still open" positions

function rsiSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gains += d; else losses -= d; }
  gains /= period; losses /= period;
  out[period] = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]; const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    gains = (gains * (period - 1) + g) / period; losses = (losses * (period - 1) + l) / period;
    out[i] = losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
  }
  return out;
}
function emaSeries(closes, period) {
  const k = 2 / (period + 1); let e = closes[0]; const out = [e];
  for (let i = 1; i < closes.length; i++) { e = closes[i] * k + e * (1 - k); out.push(e); }
  return out;
}

async function fetchQqqDaily() {
  const result = await fetchChart('QQQ', 'range=2y&interval=1d');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null) continue;
    bars.push({ time: ts[i], high: q.high[i], low: q.low[i], close: q.close[i] });
  }
  return bars;
}

async function fetch30m(symbol) {
  const result = await fetchChart(symbol, 'range=10d&interval=30m');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    bars.push({ time: ts[i], close: q.close[i] });
  }
  return bars;
}

// Is TODAY (QQQ's own last daily bar) a 7/24-style oversold-extended day? Checked using
// QQQ's OWN daily bar -- since this runs at EOD, today's close is already fully known.
async function isRule724Day() {
  const bars = await fetchQqqDaily();
  if (bars.length < 260) return false;
  const closes = bars.map(b => b.close);
  const last = closes.length - 1;
  const rsi2 = rsiSeries(closes, 2)[last];
  if (rsi2 == null || rsi2 > RSI2_MAX) return false;
  const ema200 = emaSeries(closes, 200)[last];
  if (!(closes[last] > ema200)) return false;
  let hi52 = -Infinity;
  for (let k = Math.max(0, last - 251); k <= last; k++) hi52 = Math.max(hi52, bars[k].high);
  let adrSum = 0;
  for (let k = last - 13; k <= last; k++) adrSum += (bars[k].high - bars[k].low);
  const adr14 = adrSum / 14;
  if (adr14 <= 0) return false;
  const distAdr = (hi52 - closes[last]) / adr14;
  return distAdr >= DIST_52W_ADR_MIN;
}

// Runs once, near market close (same EOD window as eod_cap_trigger_reaction.js). Closes ALL
// currently open SHORT positions across recent days if today is a rule-724 day.
async function run(history) {
  const today = ptDateString();
  const todayDay = history[today];
  if (!todayDay) return [];

  if (!(await isRule724Day())) return [];

  const days = Object.keys(history).sort().slice(-LOOKBACK_DAYS);
  const openShorts = [];
  for (const d of days) {
    for (const t of (history[d].taken || [])) {
      if (!t.resolved && t.side === 'short') openShorts.push({ day: d, trade: t });
    }
  }
  if (!openShorts.length) return [];

  const symbols = [...new Set(openShorts.map(p => p.trade.symbol))];
  const barsBySymbol = {};
  for (const sym of symbols) {
    try { barsBySymbol[sym] = await fetch30m(sym); } catch (e) { console.error(`724-exit fetch failed for ${sym}:`, e.message); }
  }

  const closedOut = [];
  for (const { day, trade } of openShorts) {
    const bars = barsBySymbol[trade.symbol];
    if (!bars || !bars.length) continue;
    const todaysBars = bars.filter(b => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(b.time * 1000)) === today);
    if (!todaysBars.length) continue;
    const todaysClose = todaysBars[todaysBars.length - 1].close;

    const R = (trade.stopPrice - trade.entryPrice) / trade.entryPrice;
    if (R <= 0) continue;
    const ret = (trade.entryPrice - todaysClose) / trade.entryPrice;
    const rMultiple = ret / R;

    trade.resolved = true;
    trade.rMultiple = +rMultiple.toFixed(2);
    trade.liveR = trade.rMultiple;
    trade.closedByRule724 = true;
    closedOut.push({ symbol: trade.symbol, side: trade.side, entryDay: day, entryPrice: trade.entryPrice, rMultiple: trade.rMultiple, barTime: trade.barTime });
  }

  if (closedOut.length) {
    todayDay.closeAdjustments = todayDay.closeAdjustments || [];
    for (const c of closedOut) {
      todayDay.closeAdjustments.push({ type: 'closed_724_rule', symbol: c.symbol, side: c.side, entryPrice: c.entryPrice, rMultiple: c.rMultiple, barTime: c.barTime });
    }
  }
  return closedOut;
}

module.exports = { run };
