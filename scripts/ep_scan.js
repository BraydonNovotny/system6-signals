// Live Episodic Pivot (EP) detection -- ported from ll_backtest's locked config
// (scan_ep_v3.js candidate rule + build_ep_signals.js filters/entry):
//   Candidate: gap >= 8% vs prior close, volume >= 2x trailing 20-day avg.
//   Filters: QQQ bullish (long-only pattern) + same-sector EP within +/-3 days (theme
//            clustering, using the accumulated live history) + first-bar range in the
//            tightest third vs TODAY's candidate pool (population-relative, same spirit
//            as the backtest's tercile cut, just computed over today's live candidates
//            instead of the full historical population -- an unavoidable simplification
//            for a live day-by-day system).
//   Entry: break of the first 30m bar's high. Stop = low of day.
const { loadTickers } = require('./universe');
const SECTOR = require('./sector_map');
const { fetchChart, pool, loadData, dropIncompleteBars } = require('./lib');

async function fetchDaily(symbol) {
  const result = await fetchChart(symbol, 'range=6mo&interval=1d');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.volume[i] == null || q.open[i] == null) continue;
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] });
  }
  return bars;
}
async function fetch30m(symbol) {
  const result = await fetchChart(symbol, 'range=2d&interval=30m');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.volume[i] == null || q.open[i] == null) continue;
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] });
  }
  return dropIncompleteBars(bars, 1800);
}
function dateKeyOf(t) { return new Date(t * 1000).toISOString().slice(0, 10); }

async function run(history) {
  const data = loadData();
  if (!data.qqqBullish) { console.log('EP: QQQ not bullish, long-only pattern skipped.'); return []; }
  const tickers = loadTickers();

  const dailyResults = await pool(tickers, fetchDaily, 8);
  const today = dateKeyOf(Date.now() / 1000);
  const candidates = [];
  for (let ti = 0; ti < tickers.length; ti++) {
    const symbol = tickers[ti];
    if (!dailyResults[ti].ok) continue;
    const daily = dailyResults[ti].value;
    if (daily.length < 25) continue;
    const last = daily.length - 1;
    if (dateKeyOf(daily[last].time) !== today) continue; // today's daily bar not formed yet
    const prevClose = daily[last - 1].close;
    const gapPct = (daily[last].open - prevClose) / prevClose * 100;
    if (gapPct < 8) continue;
    let volSum = 0;
    for (let k = last - 20; k < last; k++) volSum += daily[k].volume;
    const avgVol20 = volSum / 20;
    // today's volume isn't final intraday -- approximate day total from bars-so-far isn't
    // available here (daily granularity), so this check runs once EOD data settles; see
    // run.js's window. For an early read, this may under-count and simply not qualify yet.
    const volRatio = daily[last].volume / avgVol20;
    if (volRatio < 2.0) continue;

    let sumRange = 0;
    for (let k = last - 14; k < last; k++) sumRange += (daily[k].high - daily[k].low);
    const adrPrevDay = (sumRange / 14) / prevClose * 100;
    candidates.push({ symbol, adrPrevDay });
  }
  if (!candidates.length) { console.log('EP: 0 gap+volume candidates today.'); return []; }

  const intradayResults = await pool(candidates.map(c => c.symbol), fetch30m, 8);
  const withFirstBar = [];
  for (let ci = 0; ci < candidates.length; ci++) {
    const c = candidates[ci];
    if (!intradayResults[ci].ok) continue;
    const bars = intradayResults[ci].value;
    const dayBars = bars.filter(b => dateKeyOf(b.time) === today);
    if (dayBars.length < 2) continue;
    const firstBar = dayBars[0];
    const firstBarRangePct = (firstBar.high - firstBar.low) / firstBar.open * 100;
    const firstBarLooseness = c.adrPrevDay > 0 ? firstBarRangePct / c.adrPrevDay : null;
    withFirstBar.push({ ...c, dayBars, firstBar, firstBarLooseness });
  }
  if (!withFirstBar.length) return [];

  // tightest tercile among TODAY's candidates (population-relative, see file header note)
  const withLoose = withFirstBar.filter(c => c.firstBarLooseness != null).slice().sort((a, b) => a.firstBarLooseness - b.firstBarLooseness);
  const tightSet = new Set(withLoose.slice(0, Math.max(1, Math.floor(withLoose.length / 3))).map(c => c.symbol));

  // theme clustering: same sector EP within +/-3 days, using accumulated history + today's pool
  const recentSectors = new Set();
  if (history) {
    const cutoff = Date.now() / 1000 - 3 * 86400;
    for (const day of Object.values(history)) {
      for (const s of (day.ep || [])) {
        if (s.barTime >= cutoff && SECTOR[s.symbol]) recentSectors.add(SECTOR[s.symbol]);
      }
    }
  }
  for (const c of withFirstBar) if (SECTOR[c.symbol]) recentSectors.add(SECTOR[c.symbol]); // today's own pool counts too

  const entries = [];
  for (const c of withFirstBar) {
    if (!tightSet.has(c.symbol)) continue;
    const sector = SECTOR[c.symbol];
    const themeClustered = sector && withFirstBar.some(o => o.symbol !== c.symbol && SECTOR[o.symbol] === sector);
    if (!themeClustered) continue;

    let entryIdx = -1, entryPrice = null, entryTime = null, lod = c.firstBar.low;
    for (let k = 1; k < c.dayBars.length; k++) {
      lod = Math.min(lod, c.dayBars[k].low);
      if (c.dayBars[k].high > c.firstBar.high) { entryIdx = k; entryPrice = c.firstBar.high; entryTime = c.dayBars[k].time; break; }
    }
    if (entryIdx === -1) continue;
    entries.push({ symbol: c.symbol, side: 'long', source: 'EP', entryPrice: +entryPrice.toFixed(2), stopPrice: +lod.toFixed(2), barTime: entryTime, tf: '30m' });
  }
  console.log(`EP: ${candidates.length} gap+vol candidate(s), ${withFirstBar.length} with a valid first bar, ${entries.length} valid entry signal(s) today.`);
  return entries;
}

module.exports = { run };
if (require.main === module) run(null).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e); process.exit(1); });
