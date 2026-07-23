// Persistent day-by-day signal history. Each day stores the raw detected candidates
// (deduped) AND the account-filtered "taken" list with resolved results, recomputed
// fresh from the full candidate pool each run (so results stay consistent as more of the
// day's bars resolve open trades). History only starts accumulating from whenever this
// system first ran -- it is NOT retroactive to the 2019-2026 backtest.
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

function mergeCandidates(existing, incoming) {
  const seen = new Set(existing.map(s => s.symbol + '|' + s.side + '|' + s.barTime + '|' + s.source));
  for (const s of incoming) {
    const key = s.symbol + '|' + s.side + '|' + s.barTime + '|' + s.source;
    if (!seen.has(key)) { existing.push(s); seen.add(key); }
  }
  return existing;
}

// Merge freshly-detected raw candidates into the day's stored pool, then return the
// full updated candidate list for that day (caller re-runs the account filter on it).
function recordCandidates(dateStr, allNewCandidates) {
  const h = loadHistory();
  if (!h[dateStr]) h[dateStr] = { candidates: [], taken: [] };
  mergeCandidates(h[dateStr].candidates, allNewCandidates);
  saveHistory(h);
  return h[dateStr].candidates;
}

function recordTaken(dateStr, taken) {
  const h = loadHistory();
  if (!h[dateStr]) h[dateStr] = { candidates: [], taken: [] };
  h[dateStr].taken = taken;
  saveHistory(h);
}

module.exports = { loadHistory, saveHistory, recordCandidates, recordTaken };
