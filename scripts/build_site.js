const fs = require('fs');
const path = require('path');

function build() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data.json'), 'utf8'));
  const rosterLong = data.rosterLong || [];
  const rosterShort = data.rosterShort || [];
  const updated = data.updated?.roster || 'never';

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>System 6 — Live Roster</title>
<style>
  :root { --paper:#EEF1EE; --surface:#FFFFFF; --text:#171E1A; --text-mute:#4B564E; --text-faint:#7C877D; --rail:#C7CDC5; --rail-strong:#9AA398; --signal:#1B7A6C; --long:#2E7D4F; --short:#A8502E; }
  @media (prefers-color-scheme: dark) { :root { --paper:#0C1210; --surface:#101613; --text:#E9EDE8; --text-mute:#A3AEA1; --text-faint:#6C776B; --rail:#2B342F; --rail-strong:#3D4941; --signal:#3FD6BE; --long:#4FB47A; --short:#D97E5C; } }
  * { box-sizing: border-box; }
  body { background: var(--paper); color: var(--text); font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 40px 24px 80px; }
  .wrap { max-width: 760px; margin: 0 auto; }
  .mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  h1 { font-size: 24px; font-weight: 600; margin: 0 0 6px; }
  .sub { color: var(--text-mute); font-size: 13px; margin: 0 0 28px; }
  .regime { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; margin-bottom: 24px; }
  .regime.bull { background: color-mix(in srgb, var(--long) 18%, transparent); color: var(--long); }
  .regime.bear { background: color-mix(in srgb, var(--short) 18%, transparent); color: var(--short); }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 600px) { .cols { grid-template-columns: 1fr; } }
  .panel { border: 1px solid var(--rail); background: var(--surface); padding: 16px 18px; }
  .panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; margin: 0 0 12px; }
  .panel.long h2 { color: var(--long); } .panel.short h2 { color: var(--short); }
  .ticker-list { display: flex; flex-wrap: wrap; gap: 6px; }
  .ticker { font-size: 13px; padding: 3px 9px; border-radius: 4px; background: var(--paper); border: 1px solid var(--rail); }
  footer { margin-top: 28px; font-size: 12px; color: var(--text-faint); }
</style>
</head><body><div class="wrap">
  <h1>System 6 — Live Roster</h1>
  <p class="sub mono">Updated ${updated} (Pacific) &middot; EOD roster gate only, per the locked System 6 backtest thresholds</p>
  <span class="regime ${data.qqqBullish ? 'bull' : 'bear'}">QQQ regime: ${data.qqqBullish ? 'BULLISH (8ema > 20ema)' : 'BEARISH (20ema > 8ema)'}</span>
  <div class="cols">
    <div class="panel long">
      <h2>Long roster (${rosterLong.length})</h2>
      <div class="ticker-list mono">${rosterLong.map(t => `<span class="ticker">${t}</span>`).join('') || '<span style="color:var(--text-faint)">none (QQQ not bullish)</span>'}</div>
    </div>
    <div class="panel short">
      <h2>Short roster (${rosterShort.length})</h2>
      <div class="ticker-list mono">${rosterShort.map(t => `<span class="ticker">${t}</span>`).join('') || '<span style="color:var(--text-faint)">none</span>'}</div>
    </div>
  </div>
  <footer>These are the tickers that pass System 6's roster gate (price/volume/ADR tiers + EMA50 trend + trailing-252-day qualifying-day count + QQQ regime) as of the latest daily close. This is the "in-play" universe, not a live intraday entry signal — a ticker showing here is eligible for a pattern signal, not necessarily firing one right now. Intraday 30m entry-trigger detection is a planned follow-up phase.</footer>
</div></body></html>`;

  fs.writeFileSync(path.join(__dirname, '..', 'index.html'), html);
  console.log('Built index.html');
}

module.exports = { build };
if (require.main === module) build();
