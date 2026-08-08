// Entry point for the ACTUAL 1065.2% locked system -- replaces run.js's old System 6
// orchestration entirely. No roster dependency (fixed 233-ticker universe instead), no
// add-winners/cap-trigger-reaction/7-24-rule/dist-top-rule overlays (none apply to this
// system -- it only ever exits via stop-or-EOD-close, nothing else touches an open position).
//
// KNOWN GAP: shelf long/short is NOT included here. Its exact original live-detection
// parameters (touch tolerance, volume-spike multiple, lookback window) couldn't be reverse-
// engineered from the existing validated backtest output despite several attempts -- rather
// than guess and risk silently wrong shelf signals, it's left out until those parameters are
// recovered or shelf is re-derived from scratch. Base, 3x-inside, and EP are real and complete.
const { ptNowDecimalHour, ptDateString, fetchChart, pool, dropIncompleteBars } = require('./lib');
const scanBase = require('./scan_base_reclaim');
const scan3xInside = require('./scan_3x_inside');
const scanEP = require('./scan_ep_loosened');
const { loadHistory, saveHistory, recordCandidates, recordTaken } = require('./history');
const { runAccountFilter } = require('./account_filter_v2');
const resolvePending = require('./resolve_pending_v2');
const { build } = require('./build_site.js');

async function fetch30m(symbol) {
  const result = await fetchChart(symbol, 'range=10d&interval=30m');
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.volume[i] == null || q.open[i] == null) continue;
    bars.push({ time: ts[i], open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] });
  }
  return dropIncompleteBars(bars, 1800);
}

function countCarriedOpenPositions(history, todayStr) {
  let count = 0;
  for (const [day, val] of Object.entries(history)) {
    if (day >= todayStr) continue;
    for (const t of (val.taken || [])) if (!t.resolved) count++;
  }
  return count;
}

function todaysTakenByPattern(history, todayStr, patternTier) {
  const day = history[todayStr];
  if (!day) return [];
  return (day.taken || []).filter(t => t.patternTier === patternTier);
}

async function runEntryScans() {
  const history = loadHistory();
  const today = ptDateString();
  const carriedOpenCount = countCarriedOpenPositions(history, today);

  const todayBaseTaken = todaysTakenByPattern(history, today, 'base_4h_reclaim');
  const [base, threeX, ep] = await Promise.all([
    scanBase.run(todayBaseTaken).catch(e => { console.error('Base scan failed:', e.message); return []; }),
    scan3xInside.run().catch(e => { console.error('3x-inside scan failed:', e.message); return []; }),
    scanEP.run().catch(e => { console.error('EP scan failed:', e.message); return []; }),
  ]);
  const allNew = [...base, ...threeX, ...ep];
  const allCandidatesToday = recordCandidates(today, allNew);

  const symbols = [...new Set(allCandidatesToday.map(c => c.symbol))];
  const barResults = await pool(symbols, fetch30m, 8);
  const barsBySymbol = {};
  symbols.forEach((sym, i) => { if (barResults[i].ok) barsBySymbol[sym] = barResults[i].value; });

  const todayHistory = history[today] || { taken: [], rejected: [] };
  const previousDecisions = {};
  for (const t of (todayHistory.taken || [])) previousDecisions[t.symbol + '|' + t.side + '|' + t.barTime + '|' + t.source] = { taken: true, trade: t };
  for (const r of (todayHistory.rejected || [])) previousDecisions[r.symbol + '|' + r.side + '|' + r.barTime + '|' + r.source] = { taken: false, trade: r };

  const { taken, rejected } = runAccountFilter(allCandidatesToday, barsBySymbol, carriedOpenCount, previousDecisions);
  recordTaken(today, taken, rejected);
  console.log(`[1065.2% system] Carried-open: ${carriedOpenCount} | Candidates: ${allCandidatesToday.length} (base=${base.length}, 3x-inside=${threeX.length}, EP=${ep.length}) | Taken: ${taken.length} | Rejected: ${rejected.length}`);
  return taken;
}

async function main() {
  const force = process.argv.includes('--force');

  if (force) {
    console.log('Force: running entry scans (base + 3x-inside + EP; shelf pending).');
    await runEntryScans();
    await resolvePending.run().catch(e => console.error('resolvePending failed:', e.message));
    build();
    return;
  }

  const { decimalHour, weekday } = ptNowDecimalHour();
  const isWeekday = !['Sat', 'Sun'].includes(weekday);
  if (!isWeekday) { console.log(`Skip: ${weekday} is a weekend.`); return; }

  const inMarketHours = decimalHour >= 6.5 && decimalHour <= 13.0;
  const inEodWindow = decimalHour >= 13.15 && decimalHour <= 15.0;
  const didWork = inMarketHours || inEodWindow;

  if (inMarketHours) await runEntryScans();
  if (didWork) await resolvePending.run().catch(e => console.error('resolvePending failed:', e.message));

  if (!didWork) { console.log(`PT hour ${decimalHour.toFixed(2)} outside active windows - no-op.`); return; }
  build();
}

main().catch(e => { console.error(e); process.exit(1); });
