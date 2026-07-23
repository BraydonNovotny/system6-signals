// Persistent day-by-day signal history. Each entry is keyed by date (YYYY-MM-DD, Pacific)
// so the site can show "what fired today," and you can page back to any previous day
// since this system went live. History only starts accumulating from whenever this was
// first run -- it is NOT retroactive to the 2019-2026 backtest.
const fs = require('fs');
const path = require('path');
const HISTORY_FILE = path.join(__dirname, '..', 'signal_history.json');

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return {};
  return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
}
function saveHistory(h) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2));
}

function ptDateStringOf(unixSec) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(unixSec * 1000));
}

// Merge today's freshly-detected signals into history, deduped by symbol+side+source+barTime
// (safe to call every 30 min -- re-detecting the same still-current signal won't duplicate it).
function recordDay(dateStr, core, ep, per) {
  const h = loadHistory();
  if (!h[dateStr]) h[dateStr] = { core: [], ep: [], per: [] };
  const day = h[dateStr];

  function mergeInto(list, incoming) {
    const seen = new Set(list.map(s => s.symbol + '|' + s.side + '|' + s.barTime));
    for (const s of incoming) {
      const key = s.symbol + '|' + s.side + '|' + s.barTime;
      if (!seen.has(key)) { list.push(s); seen.add(key); }
    }
  }
  mergeInto(day.core, core);
  mergeInto(day.ep, ep);
  mergeInto(day.per, per);

  saveHistory(h);
  return h;
}

module.exports = { loadHistory, saveHistory, recordDay, ptDateStringOf };
