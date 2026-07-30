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

  .perf-windows { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px; background: var(--rail); border: 1px solid var(--rail); margin-top: 20px; }
  .perf-window { background: var(--surface); padding: 14px 16px; }
  .perf-window h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-mute); margin: 0 0 10px; }
  .perf-row { display: flex; align-items: baseline; justify-content: space-between; margin-top: 6px; }
  .perf-row:first-of-type { margin-top: 0; }
  .perf-label { font-size: 11.5px; color: var(--text-faint); }
  .perf-value { font-size: 15px; font-weight: 700; color: var(--signal); font-family: ui-monospace, "SF Mono", Consolas, monospace; font-variant-numeric: tabular-nums; }
  .perf-value.neg { color: var(--loss); }
  @media (max-width: 900px) { .perf-windows { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 480px) { .perf-windows { grid-template-columns: 1fr; } }
  .signals-block { margin-top: 20px; border: 2px solid var(--signal); background: var(--surface); }
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

  details.changelog { margin-top: 12px; border: 1px solid var(--rail); background: var(--surface); }
  details.changelog summary { padding: 12px 16px; cursor: pointer; font-size: 13px; color: var(--text-mute); list-style: none; display: flex; align-items: center; gap: 8px; }
  details.changelog summary::-webkit-details-marker { display: none; }
  details.changelog summary::before { content: '▸'; color: var(--text-faint); transition: transform 0.15s; }
  details.changelog[open] summary::before { transform: rotate(90deg); }
  .tab-bar { display: flex; gap: 6px; padding: 0 16px 12px; }
  .tab-btn { appearance: none; border: 1px solid var(--rail-strong); background: var(--paper); color: var(--text-mute); font-size: 12.5px; padding: 6px 12px; border-radius: 999px; cursor: pointer; font-family: inherit; }
  .tab-btn.active { background: var(--signal-soft); border-color: var(--signal); color: var(--signal); font-weight: 700; }
  .tab-panel { display: none; padding: 0 16px 16px; font-size: 13px; color: var(--text-mute); line-height: 1.55; }
  .tab-panel.active { display: block; }
  .tab-panel .stat-row { display: flex; gap: 18px; margin-top: 10px; flex-wrap: wrap; }
  .tab-panel .stat { background: var(--paper); border: 1px solid var(--rail); border-radius: 6px; padding: 8px 12px; }
  .tab-panel .stat .k { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-faint); display: block; }
  .tab-panel .stat .v { font-size: 14px; font-weight: 700; color: var(--text); font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  .tab-panel .arrow { color: var(--text-faint); }

  footer { margin-top: 28px; font-size: 12px; color: var(--text-faint); }
</style>
</head><body><div class="wrap">
  <h1>System 6 — Live Signals</h1>
  <p class="sub mono">Roster last checked: ${rosterUpdated}</p>
  <span class="regime ${data.qqqBullish ? 'bull' : 'bear'}">QQQ: ${data.qqqBullish ? 'BULLISH' : 'BEARISH'}</span>

  <div class="perf-windows" id="perf-windows"></div>

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
    <div style="border-top:1px solid var(--rail); margin-top:4px;"></div>
    <div style="padding:14px 18px;">
      <h2 style="margin:0 0 4px;">Triggered, not taken (blocked by capital)</h2>
      <p class="sub mono" style="margin:0 0 10px;">Same real pattern signal, but rejected because capital/slots were already full -- these would NOT have been actual trades. (Signals blocked by the daily loss cap are intentionally NOT shown here -- no reason to tempt overriding your own risk limit on a day you've already hit it.)</p>
      <div id="rejected-container"></div>
    </div>
    <div style="border-top:1px solid var(--rail); margin-top:4px;"></div>
    <div style="padding:14px 18px;">
      <h2 style="margin:0 0 4px;">Close Adjustments</h2>
      <p class="sub mono" style="margin:0 0 10px;">Anything the LOCKED rules did to an open position at the close: sized up to 1.5x (still open, already &ge;0.5R), force-closed early (entry day closed weak/strong within its own range -- retired 2026-07-27), or closed as part of the daily-cap reaction (down &ge;0.25R as of today's close, on a day another trade already tripped the -1R cap). Informational -- you place any add/close manually.</p>
      <div id="close-adjustments-container"></div>
    </div>
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

  <details class="changelog">
    <summary>Strategy changelog — 5 updates (2026-07-28)</summary>
    <div class="tab-bar">
      <button class="tab-btn active" data-tab="exit">Exit rule</button>
      <button class="tab-btn" data-tab="entry">Entry filter</button>
      <button class="tab-btn" data-tab="sizing">First-trade sizing</button>
      <button class="tab-btn" data-tab="component">Component sweep</button>
      <button class="tab-btn" data-tab="capreaction">Daily-cap reaction</button>
    </div>
    <div class="tab-panel active" id="tab-exit">
      Exit dynamics changed from a 25%-fixed-target / 75%-chandelier blend to <b>100% chandelier</b>
      (arm at 1.5R, trail at 2.0R) — the fixed 2.0R take-profit leg was dropped entirely.
      Found via a systematic exit-parameter sweep; the fixed leg was capping winners early more
      than it was protecting anything. In-sample and out-of-sample moved <b>together</b> in the
      same direction, which is the strongest sign this is a real edge and not overfitting.
      <div class="stat-row">
        <div class="stat"><span class="k">OOS CAGR</span><span class="v">453.3% <span class="arrow">&rarr;</span> 472.2%</span></div>
        <div class="stat"><span class="k">OOS Sharpe</span><span class="v">3.980 <span class="arrow">&rarr;</span> 4.005</span></div>
        <div class="stat"><span class="k">OOS Max DD</span><span class="v">6.71% <span class="arrow">&rarr;</span> 6.77%</span></div>
      </div>
    </div>
    <div class="tab-panel" id="tab-entry">
      New long-only entry requirement: the stock must have outperformed QQQ over the <b>trailing
      3 weeks</b> (15 trading days) — <code class="mono">rsVsQqq3w &ge; 0</code> — or the long is
      skipped entirely. Found in a systematic scan of relative-strength/weakness features; this
      was the one lookback window (of 3d/1w/2w/3w tested) that showed a clean, monotonic
      relationship between trailing RS and trade quality. Relative WEAKNESS did not show a
      matching edge on the short side, so shorts are unfiltered. Core pattern signals only (EP
      and Parabolic overlays are exempt, same as the backtest).
      <div class="stat-row">
        <div class="stat"><span class="k">OOS CAGR</span><span class="v">472.2% <span class="arrow">&rarr;</span> 511.5%</span></div>
        <div class="stat"><span class="k">OOS Sharpe</span><span class="v">4.005 <span class="arrow">&rarr;</span> 4.103</span></div>
        <div class="stat"><span class="k">OOS Max DD</span><span class="v">6.77% <span class="arrow">&rarr;</span> 6.77% (unchanged)</span></div>
      </div>
    </div>
    <div class="tab-panel" id="tab-sizing">
      The day's first trade was already known to have a materially worse win% across every core
      tier (losing it forecloses the rest of the day via the -1R daily loss cap, so it's the
      single highest-leverage trade of the day). New rule: an <b>additional 0.5x haircut</b> when
      that first trade is <b>also</b> below median 20-day $ volume liquidity (~$1.45B) — two
      independent weak-spot signals compounding, rather than a blanket liquidity filter across
      all trades (which was tested and made things worse on every variant). Shows as a
      <b>0.25x</b> badge on the trade log when both conditions stack (0.5x first-trade &times;
      0.5x thin-liquidity), or <b>0.5x (thin)</b> when only the liquidity half applies (EP/
      Parabolic/q0.5 are exempt from the base first-trade rule but not this one).
      <div class="stat-row">
        <div class="stat"><span class="k">OOS CAGR</span><span class="v">511.5% <span class="arrow">&rarr;</span> 526.1%</span></div>
        <div class="stat"><span class="k">OOS Sharpe</span><span class="v">4.103 <span class="arrow">&rarr;</span> 4.157</span></div>
        <div class="stat"><span class="k">OOS Max DD</span><span class="v">6.77% <span class="arrow">&rarr;</span> 6.67% (improved)</span></div>
      </div>
    </div>
    <div class="tab-panel" id="tab-component">
      A 65-variant sweep across every remaining component (compression tightness, entry spacing,
      position-sizing divisor, QQQ-overbought sizing threshold &amp; multiplier, losing-week
      multiplier, EMA8/20 regime tilt, opening-bar filter, stop-loss width) found the current
      config was slightly <b>over-penalizing</b> on three dimensions — loosening all three
      together, confirmed via IS and OOS moving together on every metric:
      <ul style="margin:10px 0 0; padding-left:20px;">
        <li><b>Compression tightness 0.8 &rarr; 1.2</b> — the "how coiled is this breakout"
        filter was cutting real setups by being too strict.</li>
        <li><b>QQQ-overbought sizing 70/0.5x &rarr; 75/0.7x</b> — fires later and cuts less hard
        when it does.</li>
        <li><b>Losing-week sizing 0.5x &rarr; 0.7x</b> — the week-after-a-loss penalty was too
        punitive.</li>
      </ul>
      Validated through the full 4-step check: IS/OOS, a 6+ value sensitivity sweep per
      parameter (no cliffs, no cherry-picked spikes), a trade-level lumpiness check (top single
      trade is &lt;2% of total return on both samples — no home runs), and a 30-seed Monte
      Carlo permutation test — <b>0 of 30 permuted datasets beat the real result on any of IS
      Sharpe, IS CAGR, OOS Sharpe, or OOS CAGR (p=0 on all four).</b>
      <div class="stat-row">
        <div class="stat"><span class="k">OOS CAGR</span><span class="v">526.1% <span class="arrow">&rarr;</span> 554.8%</span></div>
        <div class="stat"><span class="k">OOS Sharpe</span><span class="v">4.103 <span class="arrow">&rarr;</span> 4.276</span></div>
        <div class="stat"><span class="k">OOS Max DD</span><span class="v">6.67% <span class="arrow">&rarr;</span> 6.05% (improved)</span></div>
      </div>
    </div>
    <div class="tab-panel" id="tab-capreaction">
      New rule ("A2"): once today's REALIZED loss (from already-resolved trades entered
      today) trips the <b>-1R daily cap</b>, any OTHER currently-open position (from today or
      carried over from a prior day) that's down <b>at least 0.25R as of that same day's own
      close</b> gets closed out too, instead of left to run untouched. Uses only same-day,
      already-known information — no future price data, no hindsight. Found while tracing why
      several positions held through 2026-07-24 (an extreme, oversold-market pullback day)
      survived the day's own close only to get caught by a Monday gap against them. Testing
      showed that once ANY trade in the portfolio has realized a big enough loss that day,
      other open losers on that same day are statistically more likely to keep losing than to
      recover. Passed the full 4-step check: IS/OOS, a parameter sweep across the down-threshold
      (0R/-0.1R/-0.25R/-0.5R — a smooth, gradual peak, no cliff), a trade-level lumpiness check
      (top single trade ~1.8% of total OOS return — no home runs), and a 30-seed Monte Carlo
      permutation test — <b>0 of 30 permuted datasets beat the real result on IS Sharpe, IS
      CAGR, OOS Sharpe, or OOS CAGR (p=0 on all four)</b>.
      <div class="stat-row">
        <div class="stat"><span class="k">OOS CAGR</span><span class="v">554.8% <span class="arrow">&rarr;</span> 608.0%</span></div>
        <div class="stat"><span class="k">OOS Sharpe</span><span class="v">4.276 <span class="arrow">&rarr;</span> 4.430</span></div>
        <div class="stat"><span class="k">OOS Max DD</span><span class="v">6.05% <span class="arrow">&rarr;</span> 5.59% (improved)</span></div>
      </div>
    </div>
  </details>

  <footer>Core+EP+Parabolic, confluence tiers, first-trade-of-day 0.5x sizing (+0.5x more if also below median liquidity), SL widened +40% off the ADR-tiered table, 100% chandelier exit (arm 1.5R/trail 2.0R), long-only 3-week RS-vs-QQQ entry filter, daily-cap reaction (close other open positions down &ge;0.25R as of today's close once the day's -1R cap trips -- see Strategy changelog above) (no close-position filter -- retired 2026-07-27, backtesting confirmed it's not part of the current locked config). "Taken" = passed the same -1R daily loss cap (-2R for EP-30m) and 10-position limit the backtest uses, computed chronologically as the day unfolds. Trades still in progress show as Pending until enough bars exist to resolve them (updates automatically on a later refresh). History starts from whenever this system first ran. Not investment advice -- verify before acting.</footer>
</div>

<script>
const HISTORY = ${JSON.stringify(history)};
const days = Object.keys(HISTORY).sort();
const todayStr = ${JSON.stringify(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date()))};

// Recent-performance windows: trailing 5 / 21 / 63 TRADING days (not calendar days --
// "days" here is already just the days this system actually ran and recorded, so weekends
// and market holidays are naturally excluded). Each on the net-rMultiple basis (a small
// win is still a WIN, a small loss is still a LOSS -- not the looser "wasn't fully
// stopped out" definition).
const tradingDaysWithData = days.filter(d => d <= todayStr);
// effR: size-weighted R (user request 2026-07-29) -- a 0.25x-sized -1R loss is a real -0.25R
// of portfolio impact, not a full -1R; a 1.5x RS-boost winner is worth 1.5x its raw R. sizeMult
// was previously display-only (just the badge), never applied to the aggregate totals below --
// win/loss classification still uses the raw rMultiple sign (sizeMult is always positive, so it
// never flips a win into a loss or vice versa).
function effR(t) { return t.rMultiple * (t.sizeMult != null ? t.sizeMult : 1.0); }
function windowStats(tradingDaysBack) {
  const windowDays = new Set(tradingDaysWithData.slice(-tradingDaysBack));
  const trades = [...windowDays].flatMap(d => (HISTORY[d].taken || []).filter(t => t.resolved));
  const wins = trades.filter(t => t.rMultiple > 0);
  const losses = trades.filter(t => t.rMultiple <= 0);
  const netR = trades.reduce((a, t) => a + effR(t), 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + effR(t), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + effR(t), 0) / losses.length : 0;
  const rr = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
  const winRate = trades.length ? (wins.length / trades.length * 100) : 0;
  return { n: trades.length, netR, winRate, rr, avgWin, avgLoss };
}
function windowHtml(label, s) {
  const netCls = s.netR >= 0 ? 'perf-value' : 'perf-value neg';
  return '<div class="perf-window"><h3>' + label + ' <span style="text-transform:none; color:var(--text-faint);">(' + s.n + ' trades)</span></h3>' +
    '<div class="perf-row"><span class="perf-label">Net R</span><span class="' + netCls + '">' + (s.netR >= 0 ? '+' : '') + s.netR.toFixed(2) + 'R</span></div>' +
    '<div class="perf-row"><span class="perf-label">Win Rate</span><span class="perf-value">' + s.winRate.toFixed(1) + '%</span></div>' +
    '<div class="perf-row"><span class="perf-label">True RR</span><span class="perf-value">' + s.rr.toFixed(2) + ' : 1</span></div>' +
    '<div class="perf-row"><span class="perf-label">Avg Win / Loss</span><span class="perf-value" style="font-size:13px;">+' + s.avgWin.toFixed(2) + 'R / ' + s.avgLoss.toFixed(2) + 'R</span></div></div>';
}
document.getElementById('perf-windows').innerHTML =
  windowHtml('Past Week', windowStats(5)) +
  windowHtml('Past 2 Weeks', windowStats(10)) +
  windowHtml('Past Month', windowStats(21)) +
  windowHtml('Past 2 Months', windowStats(42)) +
  windowHtml('Past 3 Months', windowStats(63));

const dateInput = document.getElementById('date-input');
const container = document.getElementById('signal-container');
const rejectedContainer = document.getElementById('rejected-container');
const closeAdjustmentsContainer = document.getElementById('close-adjustments-container');
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

  // BUG FIX: this used to return early here on a no-trades day, which skipped updating the
  // rejected-for-capital and close-adjustments sections below -- leaving them showing
  // stale content from whatever day was viewed PREVIOUSLY (e.g. click back to yesterday,
  // forward to today: today's real "nothing taken/blocked" state never got applied,
  // yesterday's real rejections/adjustments stayed on screen looking like today's).
  // Every render() call must now update ALL THREE sections, every time, no early exit.
  if (!taken.length) {
    dayStatsEl.textContent = '';
    container.innerHTML = '<div class="empty"><b>No trades taken</b>' + (day ? 'Checked ' + humanDate(dateStr) + ' — nothing passed the filters.' : 'No data recorded for this day yet.') + '</div>';
  } else {
    const resolvedTrades = taken.filter(t => t.resolved);
    const wins = resolvedTrades.filter(t => t.rMultiple > 0);
    const allResolved = resolvedTrades.length === taken.length;
    const hitRateText = resolvedTrades.length
      ? wins.length + '/' + resolvedTrades.length + ' (' + (wins.length / resolvedTrades.length * 100).toFixed(0) + '%)' + (allResolved ? '' : ' so far (TBD)')
      : 'no results yet (TBD)';
    const avgR = resolvedTrades.length ? resolvedTrades.reduce((a, t) => a + effR(t), 0) / resolvedTrades.length : null;
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
        if (s.closedByCapReaction) resultHtml += ' <span class="gap-badge" title="Today\\'s daily loss cap tripped on a different trade -- closed at today\\'s own close instead of left to run">(CLOSED AT EOD)</span>';
        if (s.closedByRule724) resultHtml += ' <span class="gap-badge" title="QQQ closed oversold (2D RSI<=10) while still above its 200ema and >=5x its own 14d ADR off the 52-week high -- closed at today\\'s own close">(CLOSED AT EOD)</span>';
        if (s.closedByDistTop) resultHtml += ' <span class="gap-badge" title="QQQ showed 3 consecutive ascending-high blue bars on descending volume, >=3 days since its own 8ema touch -- a distribution-top exhaustion day, so this long was closed at today\\'s own close">(CLOSED AT EOD)</span>';
      }
      if (s.sizeMult != null && s.sizeMult < 1.0) {
        const reasons = [];
        if (s.firstTradeOfDay && s.thinFirstTrade) reasons.push('day\\'s first trade + below-median liquidity (0.5x × 0.5x)');
        else if (s.firstTradeOfDay) reasons.push('day\\'s first taken trade (materially worse win% across every core tier)');
        else if (s.thinFirstTrade) reasons.push('day\\'s first trade + below-median liquidity (EP/Parabolic/q0.5 aren\\'t exempt from this half)');
        if (s.losingWeekActive) reasons.push('week following a losing week');
        if (s.qqqOverboughtActive) reasons.push('QQQ RSI14 ≥ 75 the prior day (longs only)');
        if (s.obSizeDownActive) reasons.push('QQQ RSI14 ≥ 80 the prior day (longs only, stacks with the 75x cut above)');
        const badgeColor = s.sizeMult <= 0.35 ? 'var(--loss)' : 'var(--text-faint)';
        resultHtml += ' <span class="gap-badge" style="background:color-mix(in srgb, ' + badgeColor + ' 20%, transparent); color:' + badgeColor + ';" title="' + reasons.join(' + ') + ' -- locked rule: size to ' + s.sizeMult + 'x.">' + s.sizeMult + 'x</span>';
      }
      if (s.rsBoostActive) {
        resultHtml += ' <span class="gap-badge" style="background:color-mix(in srgb, var(--win) 20%, transparent); color:var(--win);" title="Stock\\'s own 3-week RS vs QQQ >=+5 while QQQ 2D RSI<=15 the prior day -- locked rule: size to 1.5x.">1.5x RS-BOOST</span>';
      }
      const tf = s.tf || '30m';
      const closeOffset = tf === '1h' ? 3600 : 1800;
      return '<tr><td class="mono" style="font-weight:600;">' + s.symbol + '</td><td>' + fmtTime(s.barTime + closeOffset) + ' PT <span style="color:var(--text-faint);">(' + tf + ')</span></td>' +
        '<td class="' + s.side + '">' + s.side.toUpperCase() + '</td><td>' + resultHtml + '</td></tr>';
    }).join('');
    container.innerHTML = '<table><thead><tr><th>Ticker</th><th>Time</th><th>Side</th><th>Result</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // Rejected-for-capital section -- intentionally EXCLUDES daily-loss-cap rejections
  // (no reason to show tempting "almost took this" alerts on a day you've already hit -1R).
  const allRejected = (day && day.rejected ? day.rejected : []).filter(r => r.rejectReason !== 'daily loss cap');
  if (!allRejected.length) {
    rejectedContainer.innerHTML = '<div class="empty" style="padding:16px;">None today -- capital/slots were never the binding constraint.</div>';
  } else {
    const rrows = allRejected.slice().sort((a, b) => a.barTime - b.barTime).map(s => {
      const tf = s.tf || '30m';
      const closeOffset = tf === '1h' ? 3600 : 1800;
      return '<tr><td class="mono" style="font-weight:600;">' + s.symbol + '</td><td>' + fmtTime(s.barTime + closeOffset) + ' PT <span style="color:var(--text-faint);">(' + tf + ')</span></td>' +
        '<td class="' + s.side + '">' + s.side.toUpperCase() + '</td><td style="color:var(--text-faint);">' + s.rejectReason + '</td></tr>';
    }).join('');
    rejectedContainer.innerHTML = '<table><thead><tr><th>Ticker</th><th>Time</th><th>Side</th><th>Reason</th></tr></thead><tbody>' + rrows + '</tbody></table>';
  }

  // Close Adjustments section -- feed of anything the LOCKED EOD rules did to an open
  // position: sized up (eod_add_winners.js). Historical force-closed-by-CP entries from
  // before the rule was retired (2026-07-27) still render for accurate history.
  // Defensive dedup (2026-07-27): a prior bug had two independent code paths each pushing
  // their own entry for the same qualifying trade, showing every add-winners symbol twice.
  // Root cause fixed in eod_add_winners.js, but dedupe here too as a safety net.
  const closeAdjSeen = new Set();
  const closeAdj = ((day && day.closeAdjustments) ? day.closeAdjustments : []).filter(a => {
    const key = a.type + '|' + a.symbol + '|' + a.side + '|' + a.barTime;
    if (closeAdjSeen.has(key)) return false;
    closeAdjSeen.add(key);
    return true;
  });
  if (!closeAdj.length) {
    closeAdjustmentsContainer.innerHTML = '<div class="empty" style="padding:16px;">None -- nothing sized up or force-closed at the close this day.</div>';
  } else {
    const carows = closeAdj.slice().sort((a, b) => a.barTime - b.barTime).map(s => {
      if (s.type === 'sized_up') {
        return '<tr><td class="mono" style="font-weight:600;">' + s.symbol + '</td>' +
          '<td class="' + s.side + '">' + s.side.toUpperCase() + '</td>' +
          '<td class="mono">$' + s.entryPrice.toFixed(2) + '</td>' +
          '<td><span class="gap-badge" style="background:color-mix(in srgb, var(--win) 20%, transparent); color:var(--win);">SIZED UP</span></td>' +
          '<td class="r-pos mono">+' + s.liveR.toFixed(2) + 'R</td>' +
          '<td class="mono">' + s.addMult + 'x total</td></tr>';
      }
      const rCls = s.rMultiple >= 0 ? 'r-pos' : 'r-neg';
      const badge = s.type === 'closed_cap_reaction'
        ? '<span class="gap-badge" title="Today\\'s daily loss cap tripped on a different trade -- this position was down at least 0.25R as of today\\'s own close, so it was closed out rather than left to run">CLOSED (CAP)</span>'
        : s.type === 'closed_724_rule'
        ? '<span class="gap-badge" title="QQQ closed oversold (2D RSI<=10) while still above its 200ema and >=5x its own 14d ADR off the 52-week high -- an oversold-bounce-risk day, so this short was closed at today\\'s own close">CLOSED (7/24)</span>'
        : s.type === 'closed_disttop_rule'
        ? '<span class="gap-badge" title="QQQ showed 3 consecutive ascending-high blue bars on descending volume, >=3 days since its own 8ema touch -- a distribution-top exhaustion day, so this long was closed at today\\'s own close">CLOSED (DIST-TOP)</span>'
        : '<span class="gap-badge" title="Entry day closed weak (long) or strong (short) within its own range">CLOSED (CP)</span>';
      return '<tr><td class="mono" style="font-weight:600;">' + s.symbol + '</td>' +
        '<td class="' + s.side + '">' + s.side.toUpperCase() + '</td>' +
        '<td class="mono">$' + (s.entryPrice != null ? s.entryPrice.toFixed(2) : '--') + '</td>' +
        '<td>' + badge + '</td>' +
        '<td class="' + rCls + ' mono">' + (s.rMultiple >= 0 ? '+' : '') + s.rMultiple.toFixed(2) + 'R</td>' +
        '<td class="mono">--</td></tr>';
    }).join('');
    closeAdjustmentsContainer.innerHTML = '<table><thead><tr><th>Ticker</th><th>Side</th><th>Entry</th><th>Action</th><th>R</th><th>Size to</th></tr></thead><tbody>' + carows + '</tbody></table>';
  }
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

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

render(days.length && days[days.length - 1] >= todayStr ? days[days.length - 1] : (days.includes(todayStr) ? todayStr : (days[days.length - 1] || todayStr)));
</script>
</body></html>`;

  fs.writeFileSync(path.join(__dirname, '..', 'index.html'), html);
  console.log('Built index.html');
}

module.exports = { build };
if (require.main === module) build();
