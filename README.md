# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/kiddly1/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/kiddly1/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

The best token launch radar: every protocol the sealed DefiLlama snapshot records with no token, ranked by what its token would be worth if it traded like its live peers — priced off a size curve fitted on the tokens that already trade, tested out of sample, with a costed 6-step farm plan for each.

## How the number is built

```
log10(implied) = a + b × log10(TVL) + shrunk category offset, then × growth
```

- **Size curve** — ordinary least squares of log10(market cap) on log10(TVL) over the snapshot's own traded protocols (market cap and TVL both positive, wrapped/staked/bridged products excluded). Fitted at runtime, never hardcoded.
- **Category offset** — each category's mean miss off the curve, shrunk by n/(n+5) so thin categories barely move the curve.
- **Growth** — the 7-day TVL change, clamped to −60%…+120% and given half weight.
- **Backtest, run at build time** — deterministic 5-fold cross-validation and a time-split holdout (train on protocols listed before the median listing date, test after), scored for this model and for the v1 category-median model on the same holdouts. A maturity (age) term was tested and dropped: it helped the cross-validation slightly but collapsed on the time-split holdout.
- **Value band** — the middle 50% of the curve's misses on traded tokens, shown per row as a low–high band.
- **Rankable** — the snapshot records no token (market cap, Gecko id and symbol all empty) and the protocol is not a wrapped, staked, bridged or exchange product. The board covers all 40 watchlist protocols plus every other eligible protocol: 198 rows.
- **Farm plans** — every plan is costed in dollars (6 transactions at the chain's typical gas, plus about $2 in swap and bridge fees) and netted against the low end of the value band at a 0.001% farmer share: FARM clears $50 net, THIN covers its cost, SKIP costs more than the low-end case is worth.

No hardcoded protocol names, no hardcoded values — every number is derived from the snapshot.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Requires Node.js 22.18+. Writes `board.json`, `data.js`, `dashboard/` (3 files), `screenshots/` (3 images) and `dossier.json` to the output directory. Two runs on the same snapshot produce byte-identical output.

## Layout

- `main.ts` — entry point: reads the snapshot, builds the board, writes outputs and the dossier.
- `lib/model.ts` — the model: fitted size curve, category offsets, growth, rankability rules, runtime backtest, costed farm plans.
- `vendor/makefun-board.ts` — the make.fun dossier library, vendored verbatim from the competition kit.
- `dashboard/` — the static radar page (no framework, no network): sortable/filterable board, per-protocol detail view with the full curve equation and value band, the fitted curve with its scatter chart, and the out-of-sample backtest.
- `screenshots/` — board, detail view, filtered view (1440×900).

---

Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards
