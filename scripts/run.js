// Entry point invoked by the GitHub Actions workflow (triggered every 30 min by an
// external cron-job.org ping, same pattern as the RS Screener). Self-gates on real
// America/Los_Angeles time so the trigger cadence doesn't need to match the actual
// work cadence.
//   - Roster (daily bars, changes once a day): runs once in the EOD window.
//   - Entries (30m bars, changes every bar): runs every trigger during market hours,
//     using WHATEVER roster is currently on file (yesterday's roster until today's
//     EOD scan updates it -- fine, since the roster gate itself is prior-day-based
//     in the backtest too).
const { ptNowDecimalHour, ptDateString, loadData } = require('./lib');
const scanRoster = require('./scan_roster');
const scanEntries = require('./scan_entries');
const { build } = require('./build_site.js');

async function main() {
  const force = process.argv.includes('--force');

  if (force) {
    console.log('Force: running scan_roster + scan_entries.');
    await scanRoster.run();
    await scanEntries.run();
    build();
    return;
  }

  const { decimalHour, weekday } = ptNowDecimalHour();
  const isWeekday = !['Sat', 'Sun'].includes(weekday);
  if (!isWeekday) { console.log(`Skip: ${weekday} is a weekend.`); return; }

  // Market hours: 6:30am-1:00pm PT (9:30am-4:00pm ET). Entry scan runs any trigger in
  // this window; roster scan runs once, in a short window right after close.
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
    await scanEntries.run();
    didWork = true;
  }

  if (!didWork) { console.log(`PT hour ${decimalHour.toFixed(2)} outside all active windows - no-op.`); return; }
  build();
}

main().catch(e => { console.error(e); process.exit(1); });
