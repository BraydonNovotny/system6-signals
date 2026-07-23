// Entry point invoked by the GitHub Actions workflow (triggered every 30 min by an
// external cron-job.org ping). Self-gates on real America/Los_Angeles time.
const { ptNowDecimalHour, ptDateString, loadData, fetchChart, pool } = require('./lib');
const scanRoster = require('./scan_roster');
const scanEntries = require('./scan_entries');
const epScan = require('./ep_scan');
const perScan = require('./per_scan');
const { loadHistory, recordCandidates, recordTaken } = require('./history');
const { runAccountFilter } = require('./account_filter');
const resolvePending = require('./resolve_pending');
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
  return bars;
}

// How many positions from days BEFORE today are still genuinely open (not yet resolved).
// These occupy real slots against the max-10-position limit even though they aren't in
// today's candidate list -- this is the fix for the cross-day capacity bug (previously
// every day started counting from a clean slate, ignoring whatever was still open from
// prior days). Looks back the same window resolve_pending.js uses.
function countCarriedOpenPositions(history, todayStr) {
  let count = 0;
  for (const [day, val] of Object.entries(history)) {
    if (day >= todayStr) continue; // only days strictly before today
    for (const t of (val.taken || [])) if (!t.resolved) count++;
  }
  return count;
}

async function runEntryScans() {
  const history = loadHistory();
  const today = ptDateString();
  const carriedOpenCount = countCarriedOpenPositions(history, today);

  const [core, ep, per] = await Promise.all([
    scanEntries.run(),
    epScan.run(history).catch(e => { console.error('EP scan failed:', e.message); return []; }),
    perScan.run().catch(e => { console.error('PER scan failed:', e.message); return []; }),
  ]);
  const allNew = [...core, ...ep, ...per];
  const allCandidatesToday = recordCandidates(today, allNew);

  // fetch fresh bars for every symbol involved (for exit simulation)
  const symbols = [...new Set(allCandidatesToday.map(c => c.symbol))];
  const barResults = await pool(symbols, fetch30m, 8);
  const barsBySymbol = {};
  symbols.forEach((sym, i) => { if (barResults[i].ok) barsBySymbol[sym] = barResults[i].value; });

  const { taken, rejected } = runAccountFilter(allCandidatesToday, barsBySymbol, carriedOpenCount);
  recordTaken(today, taken, rejected);
  console.log(`Carried-open from prior days: ${carriedOpenCount} | Candidates today: ${allCandidatesToday.length} | Taken: ${taken.length} | Rejected (capital/position limit): ${rejected.length}`);
  return taken;
}

async function main() {
  const force = process.argv.includes('--force');

  if (force) {
    console.log('Force: running scan_roster + all entry scans.');
    await scanRoster.run();
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

  let didWork = false;

  if (inEodWindow) {
    const data = loadData();
    const today = ptDateString();
    if (data.updated?.roster !== today) {
      await scanRoster.run();
      didWork = true;
    } else {
      console.log(`Roster already updated today (${today}) - skipping roster scan.`);
    }
  }

  if (inMarketHours) {
    await runEntryScans();
    didWork = true;
  }

  // resolve pending trades from recent days whenever we do any other work this run
  if (didWork) await resolvePending.run().catch(e => console.error('resolvePending failed:', e.message));

  if (!didWork) { console.log(`PT hour ${decimalHour.toFixed(2)} outside all active windows - no-op.`); return; }
  build();
}

main().catch(e => { console.error(e); process.exit(1); });
