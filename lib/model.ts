// Token Radar — fitted size-curve model (radar-3).
//
// Every number in the board is derived from the sealed DefiLlama snapshot
// itself, nothing is hardcoded per protocol:
//
//   log10(implied) = a + b * log10(TVL) + shrunk category offset
//                    + log10(1 + 0.5 * clamp(change_7d, -60, 120) / 100)
//
// where (a, b) is the ordinary-least-squares fit of log10(market cap) on
// log10(TVL) over the snapshot's own traded protocols ("comps": market cap
// and TVL both positive, wrapped/staked/bridged/exchange products excluded),
// and the category offset is the mean residual of the category's comps,
// shrunk by n/(n+5) so thin categories barely move the curve.
//
// Two adjustments were tested and are NOT in this model, with the reason
// recorded in the backtest: a maturity (age) multiplier helps the pooled
// cross-validation slightly but collapses on the time-split holdout (the age
// effect reverses across listing cohorts), so it was dropped; a fitted
// (unbounded) growth coefficient is unstable in sign across folds, so
// growth enters only as the bounded v1-style half-weight multiplier.
//
// A protocol is rankable only when the snapshot records no token for it
// (mcap, gecko_id and symbol all null) AND it is not a wrapped, staked,
// bridged or exchange product — the same exclusion rule the watchlist uses.
// We say "records no token", never "has no token": DefiLlama is not proof.
//
// The backtest in this file is computed from the snapshot at runtime, every
// run: a deterministic 5-fold cross-validation (folds by slug hash) and a
// time-split holdout (train on comps listed before the median listing date,
// test on comps listed after), for this model and for the v1 model
// (category-median multiples x growth x maturity) on the same holdouts.

export type Protocol = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  symbol: string | null;
  gecko_id: string | null;
  mcap_usd: number | null;
};

export type Snapshot = {
  as_of: string;
  floor_usd: number;
  watchlist: string[];
  protocols: Protocol[];
};

export type Row = {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number;
  /** Effective curve multiple: implied = round(TVL x multiple x growth). */
  multiple: number;
  growth_mult: number;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  /** Costed plan total in dollars (gas + fees). */
  plan_cost_usd: number;
  /** FARM | THIN | SKIP — from the netted low-end case. */
  verdict: string;
  farm_steps: string[];
  rank: number;
  on_watchlist: boolean;
};

export type CurveFit = {
  a: number;
  b: number;
  r2: number;
  n: number;
  residSd: number;
  /** Residual quantiles (log10) — the per-row low/high band multipliers. */
  bandLowLog: number;
  bandHighLog: number;
};

export type CategoryOffset = {
  category: string;
  offset: number;
  meanResidual: number;
  live_count: number;
};

export type BacktestMetric = {
  medAbsLogErr: number;
  within2xPct: number;
  within3xPct: number;
  n: number;
};

export type Backtest = {
  cv: { v1: BacktestMetric; radar3: BacktestMetric };
  timeSplit: { v1: BacktestMetric; radar3: BacktestMetric; cut: string };
};

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
// Products whose own receipt token already trades, so they are not pre-token.
const EXCLUDED_CATEGORIES = new Set([
  "Bridge",
  "Canonical Bridge",
  "Liquid Staking",
  "Liquid Restaking",
  "Restaked BTC",
  "CEX",
]);

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function ageDays(listedAt: string | null, asOf: string): number {
  if (!listedAt) return 365; // unknown age: neutral one-year assumption
  const days = Math.floor(
    (Date.parse(asOf) - Date.parse(listedAt + "T00:00:00Z")) / 86400000,
  );
  return Math.max(0, days);
}

/** The snapshot records no token for this protocol. */
export function recordsNoToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** True when the protocol is a wrapped/staked/bridged/exchange product. */
export function isWrappedOrExchangeProduct(p: Protocol): boolean {
  if (p.category && EXCLUDED_CATEGORIES.has(p.category)) return true;
  if (VERSIONED.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  if (EXCHANGE_PREFIX.test(p.name)) return true;
  return false;
}

/** Rankable = records no token and is not a wrapped/staked/bridged product. */
export function rankable(p: Protocol): boolean {
  return recordsNoToken(p) && !isWrappedOrExchangeProduct(p);
}

/** Traded comps: a live token with a positive market cap and TVL. */
export function compsOf(protocols: Protocol[]): Protocol[] {
  return protocols.filter(
    (p) =>
      p.mcap_usd !== null &&
      p.mcap_usd > 0 &&
      p.tvl_usd > 0 &&
      !isWrappedOrExchangeProduct(p),
  );
}

// ------------------------------------------------------------------ curve

/** OLS fit of log10(mcap) on log10(TVL) over the comps. */
export function fitCurve(comps: Protocol[]): CurveFit {
  const pts = comps.map((p) => [
    Math.log10(p.tvl_usd),
    Math.log10(p.mcap_usd as number),
  ]);
  const n = pts.length;
  const mx = pts.reduce((s, [x]) => s + x, 0) / n;
  const my = pts.reduce((s, [, y]) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  const b = sxy / sxx;
  const a = my - b * mx;
  const r2 = sxy ** 2 / (sxx * syy);
  const residuals = pts.map(([x, y]) => y - (a + b * x));
  const residSd = Math.sqrt(
    residuals.reduce((s, r) => s + r * r, 0) / n,
  );
  return {
    a,
    b,
    r2,
    n,
    residSd,
    bandLowLog: quantile(residuals, 0.25),
    bandHighLog: quantile(residuals, 0.75),
  };
}

/**
 * Per-category mean residual off the curve, shrunk by n/(n+5): a category
 * with 1-2 comps barely moves the curve, one with 14 comps moves it most.
 */
export function categoryOffsets(
  comps: Protocol[],
  fit: CurveFit,
): Map<string, CategoryOffset> {
  const grouped = new Map<string, number[]>();
  for (const p of comps) {
    const cat = p.category ?? "Unknown";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped
      .get(cat)!
      .push(
        Math.log10(p.mcap_usd as number) -
          (fit.a + fit.b * Math.log10(p.tvl_usd)),
      );
  }
  const out = new Map<string, CategoryOffset>();
  for (const [cat, residuals] of grouped) {
    const mean = residuals.reduce((s, r) => s + r, 0) / residuals.length;
    out.set(cat, {
      category: cat,
      offset: mean * (residuals.length / (residuals.length + 5)),
      meanResidual: mean,
      live_count: residuals.length,
    });
  }
  return out;
}

/** Growth multiplier: 7-day TVL change, clamped to [-60%, +120%], half weight. */
export function growthMultiplier(change7d: number | null): number {
  if (change7d === null) return 1;
  return 1 + (clamp(change7d, -60, 120) / 100) * 0.5;
}

export function offsetFor(
  category: string,
  offsets: Map<string, CategoryOffset>,
): number {
  return offsets.get(category)?.offset ?? 0;
}

/** The curve's implied market cap for a protocol, before the growth term. */
export function curveValue(
  p: Protocol,
  fit: CurveFit,
  offsets: Map<string, CategoryOffset>,
): number {
  const logM =
    fit.a +
    fit.b * Math.log10(p.tvl_usd) +
    offsetFor(p.category ?? "Unknown", offsets);
  return Math.max(1, 10 ** logM);
}

export function impliedValue(
  p: Protocol,
  fit: CurveFit,
  offsets: Map<string, CategoryOffset>,
): {
  implied: number;
  multiple: number;
  growthMult: number;
  curve: number;
  low: number;
  high: number;
} {
  const curve = curveValue(p, fit, offsets);
  const growthMult = growthMultiplier(p.change_7d);
  const implied = Math.max(1, Math.round(curve * growthMult));
  const multiple = implied / p.tvl_usd / growthMult;
  return {
    implied,
    multiple,
    growthMult,
    curve,
    low: Math.max(1, Math.round(implied * 10 ** fit.bandLowLog)),
    high: Math.max(1, Math.round(implied * 10 ** fit.bandHighLog)),
  };
}

// ------------------------------------------------------- v1 baseline (for
// the backtest only: category-median multiples x growth x maturity)

function v1Multiples(protocols: Protocol[]): {
  byCategory: Map<string, number>;
  overall: number;
} {
  const live = protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const overall = median(live.map((p) => (p.mcap_usd as number) / p.tvl_usd));
  const grouped = new Map<string, number[]>();
  for (const p of live) {
    const cat = p.category ?? "Unknown";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push((p.mcap_usd as number) / p.tvl_usd);
  }
  const byCategory = new Map<string, number>();
  for (const [cat, ratios] of grouped) {
    if (ratios.length >= 3)
      byCategory.set(cat, clamp(median(ratios), 0.05, 1.5));
  }
  return { byCategory, overall: clamp(overall, 0.05, 1.5) };
}

function v1Predict(
  p: Protocol,
  mult: { byCategory: Map<string, number>; overall: number },
  asOf: string,
): number {
  const m = mult.byCategory.get(p.category ?? "Unknown") ?? mult.overall;
  const growth = growthMultiplier(p.change_7d);
  const age = ageDays(p.listed_at, asOf);
  const maturity = 0.6 + (Math.min(age, 1095) / 1095) * 0.4;
  return Math.max(1, Math.round(p.tvl_usd * m * growth * maturity));
}

// ---------------------------------------------------------------- backtest

function metric(preds: number[], trues: number[]): BacktestMetric {
  const errs = preds.map((pr, i) =>
    Math.abs(Math.log10(pr / trues[i])),
  );
  return {
    medAbsLogErr: +median(errs).toFixed(3),
    within2xPct: +(
      (errs.filter((e) => e <= Math.log10(2)).length / errs.length) *
      100
    ).toFixed(1),
    within3xPct: +(
      (errs.filter((e) => e <= Math.log10(3)).length / errs.length) *
      100
    ).toFixed(1),
    n: trues.length,
  };
}

function foldOf(slug: string): number {
  let h = 0;
  for (const c of slug) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 5;
}

function evaluate(
  train: Protocol[],
  test: Protocol[],
  asOf: string,
): { v1: BacktestMetric; radar3: BacktestMetric } {
  const fit = fitCurve(train);
  const offsets = categoryOffsets(train, fit);
  const mult = v1Multiples(train);
  const trues = test.map((p) => p.mcap_usd as number);
  return {
    v1: metric(
      test.map((p) => v1Predict(p, mult, asOf)),
      trues,
    ),
    radar3: metric(
      test.map((p) => impliedValue(p, fit, offsets).implied),
      trues,
    ),
  };
}

export function backtest(snapshot: Snapshot): Backtest {
  const comps = compsOf(snapshot.protocols);
  // 5-fold cross-validation, folds fixed by slug hash.
  const cvV1: number[] = [];
  const cvR3: number[] = [];
  const cvTrues: number[] = [];
  for (let k = 0; k < 5; k++) {
    const test = comps.filter((p) => foldOf(p.slug) === k);
    const train = comps.filter((p) => foldOf(p.slug) !== k);
    const fit = fitCurve(train);
    const offsets = categoryOffsets(train, fit);
    const mult = v1Multiples(train);
    cvV1.push(...test.map((p) => v1Predict(p, mult, snapshot.as_of)));
    cvR3.push(
      ...test.map((p) => impliedValue(p, fit, offsets).implied),
    );
    cvTrues.push(...test.map((p) => p.mcap_usd as number));
  }
  // Time-split: train on comps listed before the median listing date,
  // test on comps listed after it.
  const dated = comps.filter((p) => p.listed_at);
  const dates = dated.map((p) => p.listed_at as string).sort();
  const cut = dates[Math.floor(dates.length / 2)];
  const train = dated.filter((p) => (p.listed_at as string) < cut);
  const test = dated.filter((p) => (p.listed_at as string) >= cut);
  const split = evaluate(train, test, snapshot.as_of);
  return {
    cv: {
      v1: metric(cvV1, cvTrues),
      radar3: metric(cvR3, cvTrues),
    },
    timeSplit: { ...split, cut },
  };
}

// ---------------------------------------------------------------- farm plans

const STABLE_BY_CHAIN: Record<string, string> = {
  Ethereum: "USDC",
  Solana: "USDC",
  Base: "USDC",
  Arbitrum: "USDC",
  Optimism: "USDC",
  Polygon: "USDC",
  Binance: "USDT",
  Avalanche: "USDC",
  Bitcoin: "WBTC",
};

const ASSET_BY_CHAIN: Record<string, string> = {
  Ethereum: "ETH",
  Solana: "SOL",
  Base: "ETH",
  Arbitrum: "ETH",
  Optimism: "ETH",
  Polygon: "MATIC",
  Binance: "BNB",
  Avalanche: "AVAX",
  Bitcoin: "BTC",
};

/** Typical gas cost per transaction in dollars, by chain. */
const GAS_MID_BY_CHAIN: Record<string, number> = {
  Ethereum: 5,
  Solana: 0.01,
  Base: 0.18,
  Arbitrum: 0.18,
  Optimism: 0.18,
  Polygon: 0.05,
  Binance: 0.2,
  Avalanche: 0.3,
  Bitcoin: 3,
};

function stable(chain: string): string {
  return STABLE_BY_CHAIN[chain] ?? "USDC";
}

function asset(chain: string): string {
  return ASSET_BY_CHAIN[chain] ?? "ETH";
}

function gasMid(chain: string): number {
  return GAS_MID_BY_CHAIN[chain] ?? 0.5;
}

/** Whole-plan cost: 6 transactions at the chain's typical gas + $2 fees. */
export function planCost(chain: string): number {
  return +(6 * gasMid(chain) + 2).toFixed(2);
}

function capitalTier(implied: number): string {
  if (implied < 25_000_000) return "$25-$100";
  if (implied < 150_000_000) return "$100-$500";
  return "$250-$1,000";
}

function money(n: number): string {
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

/**
 * Net verdict from the low-end case: the low band of the implied value,
 * at a 0.001% farmer share (one basis point — a $10M community pool split
 * 10,000 ways), netted against the costed plan.
 * FARM when the net clears $50, THIN when it covers the cost, else SKIP.
 */
export function verdictFor(lowUsd: number, costUsd: number): {
  verdict: string;
  proxy: number;
  net: number;
} {
  const proxy = lowUsd * 0.00001;
  const net = proxy - costUsd;
  const verdict = net >= 50 ? "FARM" : net >= 0 ? "THIN" : "SKIP";
  return { verdict, proxy, net };
}

/** The core interaction, per category. Names only the chain and assets from the row. */
function coreAction(p: Protocol, chain: string): string {
  const s = stable(chain);
  const a = asset(chain);
  const name = p.name;
  switch (p.category) {
    case "Lending":
      return `Supply ${s} as collateral on ${name} (${chain}) and borrow ${a} against it, keeping your health factor above 2.0. Do the supply/borrow loop twice this month.`;
    case "Dexs":
      return `Provide liquidity to the busiest pool on ${name} (${chain}) and route one swap a week through it. Hold the LP position at least 30 days.`;
    case "Yield":
      return `Deposit ${s} into the highest-APY vault on ${name} (${chain}) and let it compound weekly. Keep the deposit in place for 60+ days.`;
    case "RWA":
      return `Buy a tokenized position on ${name} (${chain}) with ${s} and hold it through one full 30-day yield cycle to register as a real holder.`;
    case "Derivatives":
      return `Open a small position on ${name} (${chain}) with $25-$50 notional and close it after a week. Repeat monthly on a different market.`;
    case "Risk Curators":
      return `Allocate ${s} to a curated vault on ${name} (${chain}) and leave it staked for a full 30-day epoch.`;
    case "CDP":
      return `Mint the protocol's stablecoin against ${a} on ${name} (${chain}), keep the collateral ratio above 200%, and repay after 30 days.`;
    case "Yield Aggregator":
      return `Deposit ${s} into the auto-compounding strategy on ${name} (${chain}) and let it run a full 30 days without withdrawing.`;
    case "Onchain Capital Allocator":
      return `Deposit ${s} into the allocation vault on ${name} (${chain}) and hold for a full 30-day epoch.`;
    case "Basis Trading":
      return `Deposit ${s} as margin on ${name} (${chain}), open a delta-neutral basis position, and hold it for one funding cycle (7 days).`;
    case "Insurance":
      return `Buy cover on ${name} (${chain}) for a $100 position and hold the policy to expiry (30 days).`;
    case "Chain":
      return `Bridge $25 of ${s} to ${name}'s chain and use its flagship app once a week for a month.`;
    case "Payments":
      return `Send two payments through ${name} (${chain}) a month apart, $25 each, to a wallet you control.`;
    case "Stablecoin Wrapper":
      return `Wrap ${s} into the protocol's yield-bearing form on ${name} (${chain}) and hold it for 30 days.`;
    case "Staking Pool":
      return `Stake ${a} in the pool on ${name} (${chain}) for a full 30-day epoch.`;
    case "Governance Incentives":
      return `Lock ${a} for voting on ${name} (${chain}) and vote on at least two proposals.`;
    case "Restaking":
      return `Restake ${a} through ${name} (${chain}) and hold the position for a full 30-day epoch.`;
    case "CeDeFi":
      return `Deposit ${s} into the CeDeFi vault on ${name} (${chain}) and hold for a full 30-day cycle.`;
    case "Collateral Markets":
      return `Supply ${a} as collateral on ${name} (${chain}) and borrow against it once, keeping your health factor above 2.0.`;
    default:
      return `Use ${name}'s main product on ${chain} once a week for a month — a real position, not a dust transaction.`;
  }
}

export function farmSteps(
  p: Protocol,
  implied: number,
  low: number,
): { steps: string[]; cost: number; verdict: string } {
  const chain = p.chains[0] ?? "Ethereum";
  const tier = capitalTier(implied);
  const cost = planCost(chain);
  const { verdict, proxy, net } = verdictFor(low, cost);
  const verdictLine =
    verdict === "FARM"
      ? "Worth farming — the low-end case still clears the cost by a wide margin."
      : verdict === "THIN"
        ? "Thin — only farm if the chain is cheap for you or you already use the product."
        : "Skip on cost — the plan costs more than the low-end case is worth; only do it if you already use the product.";
  const netText = (net >= 0 ? "+" : "−") + "$" + Math.abs(net).toFixed(0);
  const steps = [
    `Open ${p.name} (${p.category ?? "protocol"}) on ${chain} and connect a fresh wallet you control. Start with a $5 test transaction, then scale to ${tier} total. Gas here runs about $${gasMid(chain)} per transaction.`,
    coreAction(p, chain),
    `Use it again on two more days in the next 30 days, then check the points or rewards page weekly. Airdrops reward repeat users, not one-and-done wallets.`,
    `Log the cost: 6 transactions at about $${gasMid(chain)} each plus about $2 in swap and bridge fees is roughly $${cost.toFixed(2)} for the whole plan. If gas doubles, pause and wait for a cheaper window.`,
    `Set a reminder for day 30: withdraw half, leave half running. If a token announcement appears, claim from the protocol's official app only — never from links in DMs.`,
    `Net check: low-end implied value ${money(low)} at a 0.001% farmer share is about ${money(proxy)}, against a $${cost.toFixed(2)} plan cost — net ${netText}: ${verdict}. ${verdictLine}`,
  ];
  return { steps: steps.map((s) => s.trim()), cost, verdict };
}

// -------------------------------------------------------------------- board

export function buildBoard(snapshot: Snapshot): {
  rows: Row[];
  live: Protocol[];
  fit: CurveFit;
  offsets: CategoryOffset[];
  backtest: Backtest;
} {
  const comps = compsOf(snapshot.protocols);
  const fit = fitCurve(comps);
  const offsetsByCat = categoryOffsets(comps, fit);
  const watchlist = new Set(snapshot.watchlist);
  const rows: Row[] = [];
  for (const p of snapshot.protocols) {
    if (!rankable(p)) continue;
    const { implied, multiple, growthMult, low, high } = impliedValue(
      p,
      fit,
      offsetsByCat,
    );
    const { steps, cost, verdict } = farmSteps(p, implied, low);
    rows.push({
      slug: p.slug,
      name: p.name,
      category: p.category ?? "Unknown",
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: ageDays(p.listed_at, snapshot.as_of),
      multiple,
      growth_mult: growthMult,
      implied_value_usd: implied,
      implied_low_usd: low,
      implied_high_usd: high,
      plan_cost_usd: cost,
      verdict,
      farm_steps: steps,
      rank: 0,
      on_watchlist: watchlist.has(p.slug),
    });
  }
  // Rank by implied value, ties broken by slug so the order is deterministic.
  rows.sort(
    (a, b) =>
      b.implied_value_usd - a.implied_value_usd || a.slug.localeCompare(b.slug),
  );
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  const live = snapshot.protocols
    .filter((p) => !recordsNoToken(p) && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number))
    .slice(0, 24);
  const offsets = [...offsetsByCat.values()].sort(
    (a, b) => b.offset - a.offset,
  );
  return {
    rows,
    live,
    fit,
    offsets,
    backtest: backtest(snapshot),
  };
}

/** Self-check mirroring the gate's board rules; returns a list of problems. */
export function boardIssue(snapshot: Snapshot, rows: Row[]): string[] {
  const problems: string[] = [];
  if (rows.length < 100) problems.push(`board has ${rows.length} rows, needs >= 100`);
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.slug)) problems.push(`duplicate slug ${r.slug}`);
    seen.add(r.slug);
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12)
      problems.push(`${r.slug}: ${r.farm_steps.length} farm steps`);
    for (const step of r.farm_steps) {
      if (step.trim().length < 20 || step.trim().length > 600)
        problems.push(`${r.slug}: farm step length ${step.trim().length}`);
    }
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0)
      problems.push(`${r.slug}: implied value ${r.implied_value_usd} is not a positive whole number`);
  }
  const watchlist = new Set(snapshot.watchlist);
  const missing = [...watchlist].filter((s) => !seen.has(s));
  if (missing.length) problems.push(`watchlist missing: ${missing.join(", ")}`);
  const outside = rows.filter((r) => !watchlist.has(r.slug)).length;
  if (outside < 60) problems.push(`only ${outside} rows outside the watchlist, needs >= 60`);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].implied_value_usd > rows[i - 1].implied_value_usd)
      problems.push(`implied value rises at rank ${rows[i].rank}`);
  }
  const values = new Set(rows.map((r) => r.implied_value_usd));
  if (values.size === 1) problems.push("all implied values are equal");
  rows.forEach((r, i) => {
    if (r.rank !== i + 1) problems.push(`${r.slug}: rank ${r.rank} != ${i + 1}`);
  });
  return problems;
}

/** Payload the dashboard reads: rows + live set + fitted curve + backtest. */
export function dataScript(
  snapshot: Snapshot,
  board: ReturnType<typeof buildBoard>,
): string {
  const payload = {
    asOf: snapshot.as_of,
    floorUsd: snapshot.floor_usd,
    watchlistCount: snapshot.watchlist.length,
    model: "radar-3",
    fit: {
      a: board.fit.a,
      b: board.fit.b,
      r2: board.fit.r2,
      n: board.fit.n,
      residSd: board.fit.residSd,
      bandLowMult: 10 ** board.fit.bandLowLog,
      bandHighMult: 10 ** board.fit.bandHighLog,
    },
    offsets: board.offsets,
    backtest: board.backtest,
    comps: compsOf(snapshot.protocols).map((p) => ({
      slug: p.slug,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      category: p.category ?? "Unknown",
    })),
    rows: board.rows,
    live: board.live.map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category ?? "Unknown",
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
    })),
  };
  return `window.RADAR = ${JSON.stringify(payload)};\n`;
}
