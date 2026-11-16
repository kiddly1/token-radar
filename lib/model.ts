// Token Radar — comparable-multiples model (radar-2).
//
// Every number in the board is derived from the sealed DefiLlama snapshot
// itself, nothing is hardcoded per protocol:
//   implied = TVL x category multiple x growth multiplier x maturity multiplier
// where the category multiple is the MEDIAN market-cap/TVL ratio of the
// live-token protocols in the same category (fallback: the overall live
// median when a category has fewer than 3 live protocols).
//
// A protocol is rankable only when the snapshot records no token for it
// (mcap, gecko_id and symbol all null) AND it is not a wrapped, staked,
// bridged or exchange product — the same exclusion rule the watchlist uses.
// We say "records no token", never "has no token": DefiLlama is not proof.

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
  multiple: number;
  growth_mult: number;
  maturity_mult: number;
  implied_value_usd: number;
  farm_steps: string[];
  rank: number;
  on_watchlist: boolean;
};

export type CategoryMultiple = {
  category: string;
  multiple: number;
  live_count: number;
  fallback: boolean;
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Category multiples from the snapshot's own live-token protocols:
 * median(mcap_usd / tvl_usd) per category (n >= 3), else the overall live
 * median. Clamped to [0.05, 1.5] so one odd category cannot explode a value.
 */
export function categoryMultiples(
  protocols: Protocol[],
): { byCategory: Map<string, CategoryMultiple>; overall: number } {
  const live = protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const overall = median(live.map((p) => (p.mcap_usd as number) / p.tvl_usd));
  const byCategory = new Map<string, CategoryMultiple>();
  const grouped = new Map<string, number[]>();
  for (const p of live) {
    const cat = p.category ?? "Unknown";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push((p.mcap_usd as number) / p.tvl_usd);
  }
  for (const [cat, ratios] of grouped) {
    if (ratios.length >= 3) {
      byCategory.set(cat, {
        category: cat,
        multiple: clamp(median(ratios), 0.05, 1.5),
        live_count: ratios.length,
        fallback: false,
      });
    }
  }
  return { byCategory, overall: clamp(overall, 0.05, 1.5) };
}

export function multipleFor(
  category: string,
  multiples: { byCategory: Map<string, CategoryMultiple>; overall: number },
): CategoryMultiple {
  const hit = multiples.byCategory.get(category);
  if (hit) return hit;
  return {
    category,
    multiple: multiples.overall,
    live_count: 0,
    fallback: true,
  };
}

/** Growth multiplier: 7-day TVL change, clamped to [-60%, +120%], half weight. */
export function growthMultiplier(change7d: number | null): number {
  if (change7d === null) return 1;
  return 1 + (clamp(change7d, -60, 120) / 100) * 0.5;
}

/** Maturity multiplier: 0.60 at launch, rising to 1.00 after 3 years no token. */
export function maturityMultiplier(age: number): number {
  return 0.6 + (Math.min(age, 1095) / 1095) * 0.4;
}

export function impliedValue(
  p: Protocol,
  multiples: { byCategory: Map<string, CategoryMultiple>; overall: number },
  asOf: string,
): {
  implied: number;
  multiple: CategoryMultiple;
  growthMult: number;
  maturityMult: number;
  age: number;
} {
  const multiple = multipleFor(p.category ?? "Unknown", multiples);
  const growthMult = growthMultiplier(p.change_7d);
  const age = ageDays(p.listed_at, asOf);
  const maturityMult = maturityMultiplier(age);
  const implied = Math.max(
    1,
    Math.round(p.tvl_usd * multiple.multiple * growthMult * maturityMult),
  );
  return { implied, multiple, growthMult, maturityMult, age };
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

const GAS_BY_CHAIN: Record<string, string> = {
  Ethereum: "$2-$8",
  Solana: "about $0.01",
  Base: "$0.05-$0.30",
  Arbitrum: "$0.05-$0.30",
  Optimism: "$0.05-$0.30",
  Polygon: "about $0.05",
  Binance: "$0.10-$0.30",
  Avalanche: "$0.10-$0.50",
  Bitcoin: "$1-$5",
};

function stable(chain: string): string {
  return STABLE_BY_CHAIN[chain] ?? "USDC";
}

function asset(chain: string): string {
  return ASSET_BY_CHAIN[chain] ?? "ETH";
}

const GAS_TOTAL_BY_CHAIN: Record<string, string> = {
  Ethereum: "$12-$48",
  Solana: "under $0.10",
  Base: "$0.30-$1.80",
  Arbitrum: "$0.30-$1.80",
  Optimism: "$0.30-$1.80",
  Polygon: "about $0.30",
  Binance: "$0.60-$1.80",
  Avalanche: "$0.60-$3.00",
  Bitcoin: "$6-$30",
};

function gas(chain: string): string {
  return GAS_BY_CHAIN[chain] ?? "about $0.50";
}

function gasTotal(chain: string): string {
  return GAS_TOTAL_BY_CHAIN[chain] ?? "a few dollars";
}

function capitalTier(implied: number): string {
  if (implied < 25_000_000) return "$25-$100";
  if (implied < 150_000_000) return "$100-$500";
  return "$250-$1,000";
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

export function farmSteps(p: Protocol, implied: number): string[] {
  const chain = p.chains[0] ?? "Ethereum";
  const tier = capitalTier(implied);
  const steps = [
    `Open ${p.name} (${p.category ?? "protocol"}) on ${chain} and connect a fresh wallet you control. Start with a $5 test transaction to confirm the flow, then scale to ${tier} total.`,
    coreAction(p, chain),
    `Use it again on a different day — two more interactions in the next 30 days. Airdrops reward repeat users, not one-and-done wallets.`,
    `Check the protocol's points or rewards page weekly and note your points balance. If there is a referral code, share it once with a friend who actually uses the product.`,
    `Set a calendar reminder for day 30: withdraw half, leave half running. If a token announcement appears, claim from the protocol's official app only — never from links in DMs.`,
    `Log what you spent: gas on ${chain} runs ${gas(chain)} per transaction, so six transactions cost roughly ${gasTotal(chain)}. If gas doubles, pause and wait for a cheaper window.`,
  ];
  return steps.map((s) => s.trim());
}

// -------------------------------------------------------------------- board

export function buildBoard(snapshot: Snapshot): {
  rows: Row[];
  live: Protocol[];
  multiples: CategoryMultiple[];
  overallMultiple: number;
} {
  const multiples = categoryMultiples(snapshot.protocols);
  const watchlist = new Set(snapshot.watchlist);
  const rows: Row[] = [];
  for (const p of snapshot.protocols) {
    const onWatchlist = watchlist.has(p.slug);
    const isEarly = !onWatchlist && rankable(p) && p.tvl_usd < snapshot.floor_usd;
    if (!onWatchlist && !isEarly) continue;
    const { implied, multiple, growthMult, maturityMult, age } = impliedValue(
      p,
      multiples,
      snapshot.as_of,
    );
    rows.push({
      slug: p.slug,
      name: p.name,
      category: p.category ?? "Unknown",
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: age,
      multiple: multiple.multiple,
      growth_mult: growthMult,
      maturity_mult: maturityMult,
      implied_value_usd: implied,
      farm_steps: farmSteps(p, implied),
      rank: 0,
      on_watchlist: onWatchlist,
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
  const multiplesList = [...multiples.byCategory.values()].sort(
    (a, b) => b.multiple - a.multiple,
  );
  return {
    rows,
    live,
    multiples: multiplesList,
    overallMultiple: multiples.overall,
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

/** Payload the dashboard reads: rows + live set + category multiples. */
export function dataScript(
  snapshot: Snapshot,
  board: ReturnType<typeof buildBoard>,
): string {
  const payload = {
    asOf: snapshot.as_of,
    floorUsd: snapshot.floor_usd,
    watchlistCount: snapshot.watchlist.length,
    overallMultiple: board.overallMultiple,
    multiples: board.multiples,
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
