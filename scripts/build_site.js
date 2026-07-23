const fs = require('fs');
const path = require('path');

function build() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  const historyPath = path.join(__dirname, '..', 'signal_history.json');
  const history = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : {};
  const rosterLong = data.rosterLong || [];
  const rosterShort = data.rosterShort || [];
  const rosterUpdated = data.updated?.roster || 'never';

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>System 6 — Live Signals</title>
<style>
  :root { --paper:#EEF1EE; --surface:#FFFFFF; --text:#171E1A; --text-mute:#4B564E; --text-faint:#7C877D; --rail:#C7CDC5; --rail-strong:#9AA398; --signal:#1B7A6C; --signal-soft:#1B7A6C1a; --long:#2E7D4F; --short:#A8502E; --win:#2E7D4F; --loss:#A8502E; }
  @media (prefers-color-scheme: dark) { :root { --paper:#0C1210; --surface:#101613; --text:#E9EDE8; --text-mute:#A3AEA1; --text-faint:#6C776B; --rail:#2B342F; --rail-strong:#3D4941; --signal:#3FD6BE; --signal-soft:#3FD6BE22; --long:#4FB47A; --short:#D97E5C; --win:#4FB47A; --loss:#D97E5C; } }
  * { box-sizing: border-box; }
  body { background: var(--paper); color: var(--text); font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 40px 24px 80px; }
  .wrap { max-width: 780px; margin: 0 auto; }
  .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-variant-numeric: tabular-nums; }
  h1 { font-size: 24px; font-weight: 600; margin: 0 0 6px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 4px; color: var(--text-mute); }
  .sub { color: var(--text-mute); font-size: 13px; margin: 0 0 4px; }
  .regime { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; margin: 12px 0 0; }
  .regime.bull { background: color-mix(in srgb, var(--long) 18%, transparent); color: var(--long); }
  .regime.bear { background: color-mix(in srgb, var(--short) 18%, transparent); color: var(--short); }

  .signals-block { margin-top: 28px; border: 2px solid var(--signal); background: var(--surface); }
  .signals-block .head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--rail); flex-wrap: wrap; gap: 10px; }
  .signals-block .head h2 { margin: 0; color: var(--signal); font-size: 14px; }
  .controls { display: flex; align-items: center; gap: 8px; }
  input[type="date"] { font-family: inherit; font-size: 13px; padding: 5px 8px; border-radius: 4px; border: 1px solid var(--rail-strong); background: var(--paper); color: var(--text); }
  button.nav { appearance: none; border: 1px solid var(--rail-strong); background: var(--paper); color: var(--text); font-size: 12.5px; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-family: inherit; }
  button.nav:hover:not(:disabled) { background: var(--signal-soft); border-color: var(--signal); }
  button.nav:disabled { opacity: 0.35; cursor: not-allowed; }

  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { padding: 10px 16px; text-align: left; border-bottom: 1px solid var(--rail); }
  th { font-size: 10.5px; text-transform: uppercase; color: var(--text-faint); }
  tbody tr:last-child td { border-bottom: none; }
  .long { color: var(--long); font-weight: 600; } .short { color: var(--short); font-weight: 600; }
  .r-pos { color: var(--win); font-weight: 700; } .r-neg { color: var(--loss); font-weight: 700; } .r-pending { color: var(--text-faint); font-style: italic; }
  .gap-badge { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 9.5px; font-weight: 800; letter-spacing: 0.03em; background: color-mix(in srgb, var(--loss) 20%, transparent); color: var(--loss); vertical-align: middle; cursor: help; }
  .empty { padding: 32px 20px; text-align: center; color: var(--text-faint); font-size: 14px; }
  .empty b { display: block; color: var(--text-mute); font-size: 15px; margin-bottom: 4px; }

  details.roster { margin-top: 24px; border: 1px solid var(--rail); background: var(--surface); }
  details.roster summary { padding: 12px 16px; cursor: pointer; font-size: 13px; color: var(--text-mute); list-style: none; display: flex; align-items: center; gap: 8px; }
  details.roster summary::-webkit-details-marker { display: none; }
  details.roster summary::before { content: '▸'; color: var(--text-faint); transition: transform 0.15s; }
  details.roster[open] summary::before { transform: rotate(90deg); }
  details.roster .note { font-size: 12px; color: var(--text-faint); padding: 0 16px 12px; margin: 0; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 0 16px 16px; }
  @media (max-width: 600px) { .cols { grid-template-columns: 1fr; } }
  .panel h3 { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 8px; }
  .panel.long h3 { color: var(--long); } .panel.short h3 { color: var(--short); }
  .ticker-list { display: flex; flex-wrap: wrap; gap: 5px; }
  .ticker { font-size: 12px; padding: 2px 7px; border-radius: 4px; background: var(--paper); border: 1px solid var(--rail); }

  footer { margin-top: 28px; font-size: 12px; color: var(--text-faint); }
</style>
</head><body><div class="wrap">
  <h1>System 6 — Live Signals</h1>
  <p class="sub mono">Roster last checked: ${rosterUpdated}</p>
  <span class="regime ${data.qqqBullish ? 'bull' : 'bear'}">QQQ: ${data.qqqBullish ? 'BULLISH' : 'BEARISH'}</span>

  <div class="signals-block">
    <div class="head">
      <div>
        <h2 id="section-title">Triggered &amp; taken</h2>
        <p id="day-stats" class="sub mono" style="margin:2px 0 0;"></p>
      </div>
      <div class="controls">
        <input type="date" id="date-input" />
        <button class="nav" id="prev-btn">&larr;</button>
        <button class="nav" id="next-btn">&rarr;</button>
        <button class="nav" id="today-btn">Today</button>
      </div>
    </div>
    <div id="signal-container"></div>
  </div>

  <details class="roster">
    <summary>Eligible universe (roster) — ${rosterLong.length} long / ${rosterShort.length} short — not signals, just what qualifies to be watched</summary>
    <p class="note">Passing the roster gate means a ticker is in-play for a pattern to fire — it is NOT a buy/sell signal by itself.</p>
    <div class="cols">
      <div class="panel long">
        <h3>Long roster</h3>
        <div class="ticker-list mono">${rosterLong.map(t => `<span class="ticker">${t}</span>`).join('') || '<span style="color:var(--text-faint)">none</span>'}</div>
      </div>
      <div class="panel short">
        <h3>Short roster</h3>
        <div class="ticker-list mono">${rosterShort.map(t => `<span class="ticker">${t}</span>`).join('') || '<span style="color:var(--text-faint)">none</span>'}</div>
      </div>
    </div>
  </details>

  <footer>MAX + EP + Parabolic. "Taken" = passed the same -1R daily loss cap (-2R for EP-30m) and 10-position limit the backtest uses, computed chronologically as the day unfolds. Trades still in progress show as Pending until enough bars exist to resolve them (updates automatically on a later refresh). History starts from whenever this system first ran. Not investment advice -- verify before acting.</footer>
</div>

<script>
const HISTORY = ${JSON.stringify(history)};
const days = Object.keys(HISTORY).sort();
const todayStr = ${JSON.stringify(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date()))};

const dateInput = document.getElementById('date-input');
const container = document.getElementById('signal-container');
const titleEl = document.getElementById('section-title');
const dayStatsEl = document.getElementById('day-stats');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
if (days.length) { dateInput.min = days[0]; dateInput.max = days[days.length - 1] > todayStr ? days[days.length - 1] : todayStr; }

function fmtTime(barTime) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' }).format(new Date(barTime * 1000));
}
function humanDate(dateStr) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(dateStr + 'T12:00:00'));
}
function render(dateStr) {
  dateInput.value = dateStr;
  titleEl.textContent = (dateStr === todayStr ? "Today's" : humanDate(dateStr)) + ' triggered & taken';
  const day = HISTORY[dateStr];
  const taken = (day && day.taken ? day.taken.slice() : []).sort((a, b) => a.barTime - b.barTime);

  const idx = days.indexOf(dateStr);
  prevBtn.disabled = !(idx > 0);
  nextBtn.disabled = !(idx >= 0 && idx < days.length - 1);

  if (!taken.length) {
    dayStatsEl.textContent = '';
    container.innerHTML = '<div class="empty"><b>No trades taken</b>' + (day ? 'Checked ' + humanDate(dateStr) + ' — nothing passed the filters.' : 'No data recorded for this day yet.') + '</div>';
    return;
  }
  const resolvedTrades = taken.filter(t => t.resolved);
  const wins = resolvedTrades.filter(t => t.rMultiple > 0);
  const allResolved = resolvedTrades.length === taken.length;
  const hitRateText = resolvedTrades.length
    ? wins.length + '/' + resolvedTrades.length + ' (' + (wins.length / resolvedTrades.length * 100).toFixed(0) + '%)' + (allResolved ? '' : ' so far (TBD)')
    : 'no results yet (TBD)';
  const avgR = resolvedTrades.length ? resolvedTrades.reduce((a, t) => a + t.rMultiple, 0) / resolvedTrades.length : null;
  dayStatsEl.textContent = hitRateText + ' · ' + taken.length + ' trade' + (taken.length === 1 ? '' : 's') + (avgR != null ? ' · avg ' + (avgR >= 0 ? '+' : '') + avgR.toFixed(2) + 'R' : '');
  const rows = taken.map(s => {
    let resultHtml;
    if (!s.resolved) {
      const lr = s.liveR;
      const lrText = lr == null ? '' : ' (' + (lr >= 0 ? '+' : '') + lr.toFixed(2) + 'R)';
      const cls = lr == null ? 'r-pending' : (lr >= 0 ? 'r-pos' : 'r-neg');
      resultHtml = '<span class="r-pending">LIVE</span><span class="' + cls + '">' + lrText + '</span>';
    } else {
      resultHtml = '<span class="' + (s.rMultiple >= 0 ? 'r-pos' : 'r-neg') + '">' + (s.rMultiple >= 0 ? '+' : '') + s.rMultiple.toFixed(2) + 'R</span>';
      if (s.gapped) resultHtml += ' <span class="gap-badge" title="Exit price gapped past the stop -- filled at the actual open, not the idealized stop level">GAP</span>';
    }
    const tf = s.tf || '30m';
    const closeOffset = tf === '1h' ? 3600 : 1800;
    return '<tr><td class="mono" style="font-weight:600;">' + s.symbol + '</td><td>' + fmtTime(s.barTime + closeOffset) + ' PT <span style="color:var(--text-faint);">(' + tf + ')</span></td>' +
      '<td class="' + s.side + '">' + s.side.toUpperCase() + '</td><td>' + resultHtml + '</td></tr>';
  }).join('');
  container.innerHTML = '<table><thead><tr><th>Ticker</th><th>Time</th><th>Side</th><th>Result</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function goTo(dir) {
  const cur = dateInput.value;
  let idx = days.indexOf(cur);
  if (idx === -1) return;
  idx += dir;
  if (idx >= 0 && idx < days.length) render(days[idx]);
}
dateInput.addEventListener('change', () => render(dateInput.value));
prevBtn.addEventListener('click', () => goTo(-1));
nextBtn.addEventListener('click', () => goTo(1));
document.getElementById('today-btn').addEventListener('click', () => render(todayStr));

render(days.length && days[days.length - 1] >= todayStr ? days[days.length - 1] : (days.includes(todayStr) ? todayStr : (days[days.length - 1] || todayStr)));
</script>
</body></html>`;

  fs.writeFileSync(path.join(__dirname, '..', 'index.html'), html);
  console.log('Built index.html');
}

module.exports = { build };
if (require.main === module) build();
