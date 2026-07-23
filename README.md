# System 6 — Live Roster (v1)

Unattended live companion to the `ll_backtest` System 6 strategy, same architecture as the
RS Screener (GitHub Actions + Pages + cron-job.org, no server or local process needed).

**v1 scope:** EOD roster gate only — which tickers currently pass System 6's long/short
roster (price/vol/ADR tiers + EMA50 trend + trailing-252-day qualifying count + QQQ regime),
using the exact same thresholds as the backtest, fed by free Yahoo Finance daily bars.

**Not yet built:** intraday 30m entry-trigger detection (the actual pattern breakout signals
the backtest fires on), EP overlay, Parabolic Exhaustion Reversal overlay. This tells you
which names are "in play," not the exact moment a signal fires. Follow-up phase.

## Setup (one-time, manual)

1. Create an empty GitHub repo (e.g. `system6-signals`), push this folder to it.
2. Settings → Pages → deploy from `main` branch, root — gives you a public URL for `index.html`.
3. Settings → Actions → General → Workflow permissions → "Read and write permissions" (so the
   bot commit can push).
4. Create a GitHub fine-grained PAT scoped to just this repo, Actions: Read and write.
5. cron-job.org (free) → new job → every 30 min, all day → `POST` to
   `https://api.github.com/repos/<you>/system6-signals/actions/workflows/update.yml/dispatches`
   with body `{"ref":"main"}` and header `Authorization: Bearer <PAT>`.
