# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/kiddly1/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/kiddly1/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

The best token launch radar: every protocol the sealed DefiLlama snapshot records with no token, ranked by what its token would be worth if it traded like its live peers — with a concrete 6-step farm plan for each.

## How the number is built

```
implied value = TVL × category multiple × growth × maturity
```

- **Category multiple** — the median market-cap / TVL ratio of the live-token protocols in the same category, computed from the snapshot itself (overall live median when a category has fewer than 3 live peers; clamped to 0.05–1.50).
- **Growth** — the 7-day TVL change, clamped to −60%…+120% and given half weight.
- **Maturity** — 0.60 at launch, rising to 1.00 after 3 years running with no token recorded (unknown age = 365 days).
- **Rankable** — the snapshot records no token (market cap, Gecko id and symbol all empty) and the protocol is not a wrapped, staked, bridged or exchange product. The board covers all 40 watchlist protocols plus every eligible protocol below the $50M floor: 178 rows.

No hardcoded protocol names, no hardcoded values — every number is derived from the snapshot.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Requires Node.js 22.18+. Writes `board.json`, `data.js`, `dashboard/` (3 files), `screenshots/` (3 images) and `dossier.json` to the output directory. Two runs on the same snapshot produce byte-identical output.

## Layout

- `main.ts` — entry point: reads the snapshot, builds the board, writes outputs and the dossier.
- `lib/model.ts` — the model: category multiples, implied values, rankability rules, farm plans.
- `vendor/makefun-board.ts` — the make.fun dossier library, vendored verbatim from the competition kit.
- `dashboard/` — the static radar page (no framework, no network): sortable/filterable board, per-protocol detail view with the full model equation, and the category-multiples table.
- `screenshots/` — board, detail view, filtered view (1440×900).

---

Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards
