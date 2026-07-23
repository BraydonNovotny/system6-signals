// Entry point invoked by the GitHub Actions workflow (triggered every 30 min by an
// external cron-job.org ping, same pattern as the RS Screener). Self-gates on real
// America/Los_Angeles time so the trigger cadence doesn't need to match the actual
// work cadence -- v1 only refreshes the EOD roster (daily bars only change once a day),
// so it just runs once per weekday after close and no-ops the rest of the time.
const { ptNowDecimalHour, ptDateString, loadData } = require('./lib');
const scanRoster = require('./scan_roster');
const { build } = require('./build_site.js');

async function main() {
  const force = process.argv.includes('--force');

  if (force) {
    console.log('Force: running scan_roster.');
    await scanRoster.run();
    build();
    return;
  }

  const { decimalHour, weekday } = ptNowDecimalHour();
  const isWeekday = !['Sat', 'Sun'].includes(weekday);
  if (!isWeekday) { console.log(`Skip: ${weekday} is a weekend.`); return; }

  // EOD window: market closes 1pm PT, give it some buffer for data to settle.
  const inEodWindow = decimalHour >= 13.15 && decimalHour <= 15.0;
  if (!inEodWindow) { console.log(`PT hour ${decimalHour.toFixed(2)} outside EOD window - no-op.`); return; }

  const data = loadData();
  const today = ptDateString();
  if (data.updated?.roster === today) { console.log(`Roster already updated today (${today}) - skipping.`); return; }

  await scanRoster.run();
  build();
}

main().catch(e => { console.error(e); process.exit(1); });
