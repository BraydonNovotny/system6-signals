// EOD roster scan -- the portable, low-risk piece of System 6's live pipeline.
// Ported from ll_backtest/build_combined_qualify_map.js + build_short_qualify_map.js.
// Determines, as of the latest completed daily close, which tickers are on the LONG
// roster (quality uptrend names, QQQ-bullish-gated) and SHORT roster (quality downtrend
// names, QQQ-bearish-gated), including the trailing-252-day count gate (>=70 long, >=20
// short) -- these are the SAME gates the backtest uses before it'll even consider a
// pattern signal on a ticker. This does NOT yet detect the intraday 30m entry trigger
// itself (that's a separate, not-yet-built phase) -- this tells you which names are
// "in play" for tomorrow, not the exact minute a signal fires.
const { loadTickers } = require('./universe');
const { emaSeries, computeAdrSeries } = require('./indicators');
const { fetchChart, pool, saveData, loadData, ptDateString } = require('./lib');

const SCANS = [
  { minPrice: 24.25, minVol: 7.5e6, minAdr: 3.5 },
  { minPrice: 100, minVol: 5e6, minAdr: 3.5 },
  { minPrice: 15, minVol: 12.5e6, minAdr: 2.5 },
  { minPrice: 2.5, minVol: 25e6, minAdr: 5.0 },
  { minPrice: 250, minVol: 4.5e6, minAdr: 5.0 },
];
function passesTiers(cp, v, adr) { for (const s of SCANS) if (cp >= s.minPrice && v >= s.minVol && adr >= s.minAdr) return true; return false; }

async function fetchDaily(symbol) {
  const result = await fetchChart(symbol, 'range=2y&interval=1d');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.volume[i] == null) continue;
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] });
  }
  return bars;
}

async function run() {
  const tickers = loadTickers();
  const symbols = ['QQQ', ...tickers];
  const results = await pool(symbols, fetchDaily, 8);

  const barsBySymbol = {};
  symbols.forEach((sym, i) => { if (results[i].ok) barsBySymbol[sym] = results[i].value; });

  const qqqBars = barsBySymbol.QQQ;
  if (!qqqBars || qqqBars.length < 60) { console.error('FATAL: QQQ fetch failed.'); process.exit(1); }
  const qqqCloses = qqqBars.map(b => b.close);
  const qqqEma8 = emaSeries(qqqCloses, 8), qqqEma20 = emaSeries(qqqCloses, 20);
  const qqqBullishToday = qqqEma8[qqqEma8.length - 1] > qqqEma20[qqqEma20.length - 1];

  const rosterLong = [], rosterShort = [];
  const details = {};
  for (const sym of tickers) {
    const bars = barsBySymbol[sym];
    if (!bars || bars.length < 260) continue; // need ~252 trading days + 50ema warmup
    const closes = bars.map(b => b.close);
    const ema50 = emaSeries(closes, 50);
    const adrSeries = computeAdrSeries(bars);
    const last = bars.length - 1;
    const adrPct = adrSeries[last];
    if (adrPct == null) continue;

    const passesTierNow = passesTiers(closes[last], bars[last].volume, adrPct);
    const aboveEma50 = closes[last] > ema50[last];
    const belowEma50 = closes[last] < ema50[last];

    // trailing-252 count: how many of the last 252 sessions passed the FULL long/short gate
    let longCount = 0, shortCount = 0;
    const start = Math.max(50, bars.length - 252);
    for (let i = start; i < bars.length; i++) {
      const adr = adrSeries[i]; if (adr == null) continue;
      const pass = passesTiers(closes[i], bars[i].volume, adr);
      if (closes[i] > ema50[i] && pass) longCount++;
      if (closes[i] < ema50[i] && pass) shortCount++;
    }

    const onLongRoster = aboveEma50 && passesTierNow && qqqBullishToday && longCount >= 70;
    const onShortRoster = belowEma50 && passesTierNow && !qqqBullishToday && shortCount >= 20;

    details[sym] = {
      price: +closes[last].toFixed(2), adrPct: +adrPct.toFixed(2),
      aboveEma50, passesTierNow, longTrailing252: longCount, shortTrailing252: shortCount,
      onLongRoster, onShortRoster,
    };
    if (onLongRoster) rosterLong.push(sym);
    if (onShortRoster) rosterShort.push(sym);
  }

  const data = loadData();
  data.updated = data.updated || {};
  data.updated.roster = ptDateString();
  data.qqqBullish = qqqBullishToday;
  data.rosterLong = rosterLong.sort();
  data.rosterShort = rosterShort.sort();
  data.tickerDetail = details;
  saveData(data);
  console.log(`Roster updated (${ptDateString()}): QQQ ${qqqBullishToday ? 'BULLISH' : 'BEARISH'}, ${rosterLong.length} long-roster, ${rosterShort.length} short-roster.`);
}

module.exports = { run };
if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
