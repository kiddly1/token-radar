# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/kiddly1/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/kiddly1/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

The best token launch radar: every protocol the sealed DefiLlama snapshot records with no token, ranked by expected value — what its token would be worth if it launched like its live peers, times the odds a protocol like this ever records a token — tested out of sample, with a costed 6-step farm plan for each.

## How the number is built

```
expected value = 10^(a + b × log10(TVL) − c × log10(chains) + shrunk category offset) × growth × launch odds
```

- **Size curve** — ordinary least squares of log10(market cap) on log10(TVL) and log10(chain count) over the snapshot's own traded protocols (market cap and TVL both positive, wrapped/staked/bridged products excluded). Fitted at runtime, never hardcoded. The chain term is negative: at the same TVL, a protocol spread over many chains prices lower.
- **Category offset** — each category's mean miss off the curve, shrunk by n/(n+20) so thin categories barely move the curve.
- **Growth** — the 7-day TVL change, clamped to −60%…+120% and given half weight.
- **Launch odds** — a logistic regression on all 758 protocols in the snapshot (target: records a token), with log TVL, log age, log chain count, 7-day change and a flag for unknown listing date. The odds are a cross-sectional proxy — among protocols that look like this, how many already record a token — not a validated forecast of a future launch.
- **Age** — tested inside the curve and dropped: it helped the cross-validation slightly but collapsed on the time-split holdout (the fitted age coefficient flips sign across listing cohorts). Age is scored through the launch odds instead, where it validates on both holdouts.
- **Backtest, run at build time** — deterministic 5-fold cross-validation and a time-split holdout (train on protocols listed before the median listing date, test after), scored for this model, the v2 curve and the v1 category-median model on the same holdouts; the odds model has its own separate backtest (AUC / log-loss vs the base rate). The odds never enter the curve backtest.
- **Value band** — the middle 50% of the curve's misses on traded tokens, shown per row as a low–high band on the expected value.
- **Rankable** — the snapshot records no token (market cap, Gecko id and symbol all empty) and the protocol is not a wrapped, staked, bridged or exchange product. The board covers all 40 watchlist protocols plus every other eligible protocol: 198 rows.
- **Farm plans** — every plan is costed in dollars (6 transactions at the cheapest chain's typical gas, plus about $2 in swap and bridge fees), states its active time (about 45 minutes) and holding time (30 or 60 days), and is netted against the low end of the expected-value band at a 0.01% farmer share: FARM clears $50 net, THIN covers its cost, SKIP costs more than the low-end case is worth.

No hardcoded protocol names, no hardcoded values — every number is derived from the snapshot.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Requires Node.js 22.18+. Writes `board.json`, `data.js`, `dashboard/` (3 files), `screenshots/` (3 images) and `dossier.json` to the output directory. Two runs on the same snapshot produce byte-identical output.

## Layout

- `main.ts` — entry point: reads the snapshot, builds the board, writes outputs and the dossier.
- `lib/model.ts` — the model: fitted size curve with chain term, category offsets, growth, launch-odds logistic regression, rankability rules, runtime backtests, costed farm plans.
- `vendor/makefun-board.ts` — the make.fun dossier library, vendored verbatim from the competition kit.
- `dashboard/` — the static radar page (no framework, no network): sortable/filterable board, per-protocol detail view with the full expected-value equation and value band, the fitted curve with its scatter chart, and the out-of-sample backtests.
- `screenshots/` — board, detail view, filtered view (1440×900).

---

Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards
