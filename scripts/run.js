// Entry point invoked by the GitHub Actions workflow (triggered every 30 min by an
// external cron-job.org ping). Self-gates on real America/Los_Angeles time.
//   - Roster (daily bars, changes once a day): runs once in the EOD window.
//   - Entries (core + EP + Parabolic, 30m bars): runs every trigger during market hours,
//     merged and recorded into the persistent day-by-day history.
const { ptNowDecimalHour, ptDateString, loadData, saveData } = require('./lib');
const scanRoster = require('./scan_roster');
const scanEntries = require('./scan_entries');
const epScan = require('./ep_scan');
const perScan = require('./per_scan');
const { recordDay, loadHistory } = require('./history');
const { build } = require('./build_site.js');

async function runEntryScans() {
  const history = loadHistory();
  const [core, ep, per] = await Promise.all([
    scanEntries.run(),
    epScan.run(history).catch(e => { console.error('EP scan failed:', e.message); return []; }),
    perScan.run().catch(e => { console.error('PER scan failed:', e.message); return []; }),
  ]);
  const today = ptDateString();
  recordDay(today, core, ep, per);
  return { core, ep, per };
}

async function main() {
  const force = process.argv.includes('--force');

  if (force) {
    console.log('Force: running scan_roster + all entry scans.');
    await scanRoster.run();
    await runEntryScans();
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

  if (!didWork) { console.log(`PT hour ${decimalHour.toFixed(2)} outside all active windows - no-op.`); return; }
  build();
}

main().catch(e => { console.error(e); process.exit(1); });
