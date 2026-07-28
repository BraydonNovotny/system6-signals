// Entry point invoked by the GitHub Actions workflow (triggered every 30 min by an
// external cron-job.org ping). Self-gates on real America/Los_Angeles time.
const { ptNowDecimalHour, ptDateString, loadData, saveData, fetchChart, pool } = require('./lib');
const scanRoster = require('./scan_roster');
const scanEntries = require('./scan_entries');
const epScan = require('./ep_scan');
const perScan = require('./per_scan');
const { loadHistory, saveHistory, recordCandidates, recordTaken } = require('./history');
const { runAccountFilter } = require('./account_filter');
const resolvePending = require('./resolve_pending');
const eodAddWinners = require('./eod_add_winners');
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

// LOCKED (2026-07-27): 0.7x sizing for the week following a losing week (loosened from the
// backtest's original 0.5x -- full component sweep + permutation test confirmed 0.7x is
// better). Mirrors the backtest's Math.floor(dayKey/7) week bucketing.
function dayKeyOf(dateStr) { return Math.floor(new Date(dateStr + 'T12:00:00Z').getTime() / 1000 / 86400); }
function wasLastWeekLosing(history, todayStr) {
  const todayWk = Math.floor(dayKeyOf(todayStr) / 7);
  let sum = 0, found = false;
  for (const [day, val] of Object.entries(history)) {
    if (Math.floor(dayKeyOf(day) / 7) !== todayWk - 1) continue;
    for (const t of (val.taken || [])) { if (t.resolved) { sum += t.rMultiple; found = true; } }
  }
  return found && sum < 0;
}

async function runEntryScans() {
  const history = loadHistory();
  const today = ptDateString();
  const carriedOpenCount = countCarriedOpenPositions(history, today);
  const losingWeek = wasLastWeekLosing(history, today);

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

  // Already-decided candidates from an earlier run today -- passed through so the account
  // filter NEVER re-decides or erases them (see account_filter.js for the bug this fixes).
  const todayHistory = history[today] || { taken: [], rejected: [] };
  const previousDecisions = {};
  for (const t of (todayHistory.taken || [])) previousDecisions[t.symbol + '|' + t.side + '|' + t.barTime + '|' + t.source] = { taken: true, trade: t };
  for (const r of (todayHistory.rejected || [])) previousDecisions[r.symbol + '|' + r.side + '|' + r.barTime + '|' + r.source] = { taken: false, trade: r };

  const { taken, rejected } = runAccountFilter(allCandidatesToday, barsBySymbol, carriedOpenCount, {}, losingWeek, previousDecisions);
  recordTaken(today, taken, rejected);
  console.log(`Carried-open from prior days: ${carriedOpenCount} | Candidates today: ${allCandidatesToday.length} | Taken: ${taken.length} | Rejected (capital/position limit): ${rejected.length} | Losing-week sizing active: ${losingWeek}`);
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

  // BUG FIX (2026-07-27, found by direct user question: liveR on an open ONDS position was
  // stuck at a stale mark from hours earlier despite the cron running fine every 30 min).
  // `didWork` used to only flip true when the once-per-day roster/addWinners tasks actually
  // executed -- so once those were marked done for today (typically the FIRST eod-window
  // tick), every LATER tick in the 13.15-15.00 window did nothing at all: no resolvePending
  // (which refreshes liveR for every still-open position), no rebuild. The window itself
  // being active is reason enough to keep refreshing; the once-daily tasks are a separate,
  // independent concern from "should we resolve pending trades and rebuild the site now."
  let didWork = inMarketHours || inEodWindow;

  if (inEodWindow) {
    const data = loadData();
    const today = ptDateString();
    if (data.updated?.roster !== today) {
      await scanRoster.run();
    } else {
      console.log(`Roster already updated today (${today}) - skipping roster scan.`);
    }
    if (data.updated?.addWinners !== today) {
      const history = loadHistory();
      // Close-position rule REMOVED (2026-07-27) -- backtesting confirmed it's not part of
      // the current locked config (Core+EP+Parabolic, no CP, SL=1.40 + confluence tiers +
      // first-trade 0.5x sizing). Add-winners still runs on its own.
      const addWinners = await eodAddWinners.run(history).catch(e => { console.error('add-winners check failed:', e.message); return []; });
      saveHistory(history);
      data.updated = data.updated || {};
      data.updated.addWinners = today;
      saveData(data);
      console.log(`Add-winners check: ${addWinners.length} qualifying position(s) today.`);
    }
  }

  if (inMarketHours) {
    await runEntryScans();
  }

  // resolve pending trades from recent days whenever we're in an active window, regardless
  // of whether the once-daily roster/addWinners tasks specifically ran this tick.
  if (didWork) await resolvePending.run().catch(e => console.error('resolvePending failed:', e.message));

  if (!didWork) { console.log(`PT hour ${decimalHour.toFixed(2)} outside all active windows - no-op.`); return; }
  build();
}

main().catch(e => { console.error(e); process.exit(1); });
