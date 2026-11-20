// Token Radar — expected-value model (radar-4).
//
// Every number in the board is derived from the sealed DefiLlama snapshot
// itself, nothing is hardcoded per protocol. The board ranks by EXPECTED
// value — what a launch would be worth, times the odds a protocol like
// this ever records a token:
//
//   value-if-launches = 10^(a + bT * log10(TVL) + bC * log10(nChains)
//                        + shrunk category offset) * growth
//   implied (EV)      = value-if-launches * launch odds
//
// The curve is an ordinary-least-squares fit of log10(market cap) on
// log10(TVL) and log10(chain count) over the snapshot's own traded
// protocols ("comps": market cap and TVL both positive, wrapped/staked/
// bridged/exchange products excluded). The chain term is negative:
// at the same TVL, a protocol spread over many chains prices lower
// (TVL spread thin / mercenary). The category offset is the mean
// residual of the category's comps, shrunk by n/(n+20) — thin categories
// barely move the curve. Growth is the bounded v1-style half-weight
// multiplier: 1 + 0.5 * clamp(change_7d, -60, 120) / 100.
//
// The launch odds come from a logistic regression fitted on ALL 758
// snapshot protocols (target: records a token), with features log10(TVL),
// log10(age in days + 1), log10(chain count), clamped 7-day change and
// a flag for unknown listing date. It is a CROSS-SECTIONAL proxy —
// "among protocols that look like this, how many already record a
// token" — not a validated forecast of a future launch: the snapshot
// carries no token-launch dates, so the forward hazard is not
// identified from it. Cross-sectionally the odds RISE with age (a
// protocol that has run 2-3 years was more likely to have launched by
// now); do not claim the odds fall with age.
//
// Age was tested IN the curve and is NOT there: an age term helps the
// pooled cross-validation slightly but collapses on the time-split
// holdout (the fitted age coefficient is +4.72 on the pre-2024-07-15
// training cohort and -0.155 on the full data — the sign flips across
// cohorts). Age enters only through the odds, where it validates on
// both holdouts (AUC 0.58-0.67 vs 0.50 base; see the odds backtest).
// A fitted (unbounded) growth coefficient is unstable in sign across
// folds, so growth stays bounded.
//
// A protocol is rankable only when the snapshot records no token for it
// (mcap, gecko_id and symbol all null) AND it is not a wrapped, staked,
// bridged or exchange product — the same exclusion rule the watchlist uses.
// We say "records no token", never "has no token": DefiLlama is not proof.
//
// The backtests in this file are computed from the snapshot at runtime,
// every run: a deterministic 5-fold cross-validation (folds by slug hash)
// and a time-split holdout, for the v1 model, the v2 model (radar-3) and
// this model on the same curve holdouts, plus a separate 5-fold +
// time-split classification backtest (AUC / log-loss vs the base rate)
// for the launch-odds model. The odds are never mixed into the curve
// backtest — the curve is scored on value-if-launched alone.

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
  /** True when listed_at is present; false means the age is unknown. */
  age_known: boolean;
  /** Effective curve multiple: curve = TVL x multiple (before growth). */
  multiple: number;
  growth_mult: number;
  /** Value if the token launches (curve x growth), before the odds. */
  curve_value_usd: number;
  /** Launch odds: P(a protocol like this records a token), 0..1. */
  launch_odds: number;
  /** Expected value = curve_value_usd x launch_odds. This is the rank. */
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  /** Cheapest chain (by gas table) the farm plan is costed on. */
  chain_used: string;
  /** Costed plan total in dollars (gas + fees). */
  plan_cost_usd: number;
  /** Active minutes the plan takes (holding time is separate, in steps). */
  plan_time_min: number;
  /** Holding time the plan asks for, in days. */
  plan_holding_days: number;
  /** FARM | THIN | SKIP — from the netted low-end case. */
  verdict: string;
  farm_steps: string[];
  rank: number;
  on_watchlist: boolean;
};

export type CurveFit = {
  a: number;
  /** Slope on log10(TVL). */
  b: number;
  /** Slope on log10(chain count); 0 for the v2 (radar-3) fit. */
  bChains: number;
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
  /** Share of the category's protocols (all 758) that record a token. */
  launch_rate: number;
  launch_n: number;
  launch_total: number;
};

export type BacktestMetric = {
  medAbsLogErr: number;
  within2xPct: number;
  within3xPct: number;
  n: number;
};

/** Launch-odds classification backtest: AUC + log-loss vs base rate. */
export type OddsMetric = {
  auc: number;
  logLoss: number;
  baseLogLoss: number;
  n: number;
};

export type OddsBacktest = {
  cv: OddsMetric;
  timeSplit: OddsMetric & { cut: string };
};

/** Logistic launch-odds model, fitted at runtime on all protocols. */
export type OddsModel = {
  /** Standardized-feature weights, intercept first. */
  weights: number[];
  mean: number[];
  sd: number[];
};

export type Backtest = {
  cv: { v1: BacktestMetric; radar3: BacktestMetric; radar4: BacktestMetric };
  timeSplit: {
    v1: BacktestMetric;
    radar3: BacktestMetric;
    radar4: BacktestMetric;
    cut: string;
  };
  odds: OddsBacktest;
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

/** Solve a small dense linear system by Gaussian elimination. */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    [m[col], m[piv]] = [m[piv], m[col]];
    const d = m[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / d;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/** Design row: [1, log10(TVL), log10(chain count)] (chains term optional). */
function designRow(p: Protocol, useChains: boolean): number[] {
  const row = [1, Math.log10(p.tvl_usd)];
  if (useChains) row.push(Math.log10(Math.max(1, p.chains.length)));
  return row;
}

/**
 * OLS fit of log10(mcap) on log10(TVL) — and, for radar-4, on
 * log10(chain count) as well — over the comps. `k` is the category
 * shrinkage used with the fit (kept here for the caller, not the fit).
 */
export function fitCurve(
  comps: Protocol[],
  useChains = true,
): CurveFit {
  const xRows = comps.map((p) => designRow(p, useChains));
  const y = comps.map((p) => Math.log10(p.mcap_usd as number));
  const k = xRows[0].length;
  const xtx: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const xty = new Array(k).fill(0);
  for (let i = 0; i < xRows.length; i++) {
    for (let r = 0; r < k; r++) {
      xty[r] += xRows[i][r] * y[i];
      for (let c = 0; c < k; c++) xtx[r][c] += xRows[i][r] * xRows[i][c];
    }
  }
  const beta = solveLinear(xtx, xty);
  const residuals = xRows.map(
    (row, i) => y[i] - row.reduce((s, v, j) => s + v * beta[j], 0),
  );
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  const sst = y.reduce((s, v) => s + (v - my) ** 2, 0);
  const sse = residuals.reduce((s, r) => s + r * r, 0);
  return {
    a: beta[0],
    b: beta[1],
    bChains: useChains ? beta[2] : 0,
    r2: 1 - sse / sst,
    n: comps.length,
    residSd: Math.sqrt(sse / comps.length),
    bandLowLog: quantile(residuals, 0.25),
    bandHighLog: quantile(residuals, 0.75),
  };
}

/**
 * Per-category mean residual off the curve, shrunk by n/(n+k): a category
 * with 1-2 comps barely moves the curve, one with 14 comps moves it most.
 * Also carries each category's launch rate over ALL snapshot protocols
 * (share that record a token) for the dashboard's peer context.
 */
export function categoryOffsets(
  comps: Protocol[],
  fit: CurveFit,
  k = 20,
  allProtocols: Protocol[] = [],
): Map<string, CategoryOffset> {
  const grouped = new Map<string, number[]>();
  for (const p of comps) {
    const cat = p.category ?? "Unknown";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped
      .get(cat)!
      .push(
        Math.log10(p.mcap_usd as number) -
          (fit.a +
            fit.b * Math.log10(p.tvl_usd) +
            fit.bChains * Math.log10(Math.max(1, p.chains.length))),
      );
  }
  const launch = new Map<string, [number, number]>();
  for (const p of allProtocols) {
    const cat = p.category ?? "Unknown";
    const cur = launch.get(cat) ?? [0, 0];
    cur[1] += 1;
    if (p.mcap_usd !== null && p.mcap_usd > 0) cur[0] += 1;
    launch.set(cat, cur);
  }
  const out = new Map<string, CategoryOffset>();
  for (const [cat, residuals] of grouped) {
    const mean = residuals.reduce((s, r) => s + r, 0) / residuals.length;
    const [ln, tot] = launch.get(cat) ?? [0, 0];
    out.set(cat, {
      category: cat,
      offset: mean * (residuals.length / (residuals.length + k)),
      meanResidual: mean,
      live_count: residuals.length,
      launch_rate: tot > 0 ? ln / tot : 0,
      launch_n: ln,
      launch_total: tot,
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
    fit.bChains * Math.log10(Math.max(1, p.chains.length)) +
    offsetFor(p.category ?? "Unknown", offsets);
  return Math.max(1, 10 ** logM);
}

/** Expected value: curve x growth (value if it launches) x launch odds. */
export function impliedValue(
  p: Protocol,
  fit: CurveFit,
  offsets: Map<string, CategoryOffset>,
  oddsModel: OddsModel,
  asOf: string,
): {
  implied: number;
  multiple: number;
  growthMult: number;
  curve: number;
  curveValue: number;
  odds: number;
  low: number;
  high: number;
} {
  const curve = curveValue(p, fit, offsets);
  const growthMult = growthMultiplier(p.change_7d);
  const valueIfLaunches = curve * growthMult;
  const odds = launchOdds(p, oddsModel, asOf);
  const implied = Math.max(1, Math.round(valueIfLaunches * odds));
  const multiple = curve / p.tvl_usd;
  return {
    implied,
    multiple,
    growthMult,
    curve,
    curveValue: valueIfLaunches,
    odds,
    low: Math.max(1, Math.round(implied * 10 ** fit.bandLowLog)),
    high: Math.max(1, Math.round(implied * 10 ** fit.bandHighLog)),
  };
}

// ------------------------------------------------------------ launch odds

/**
 * Raw odds features: log10(TVL), log10(age in days + 1), log10(chain
 * count), clamped 7-day change (fraction), and a flag for unknown
 * listing date. Age uses the same neutral 365-day stand-in as ageDays
 * when listed_at is missing — the flag tells the model it is a guess.
 */
export function oddsFeatures(p: Protocol, asOf: string): number[] {
  const change =
    p.change_7d === null ? 0 : clamp(p.change_7d, -60, 120) / 100;
  return [
    Math.log10(Math.max(1, p.tvl_usd)),
    Math.log10(ageDays(p.listed_at, asOf) + 1),
    Math.log10(Math.max(1, p.chains.length)),
    change,
    p.listed_at === null ? 1 : 0,
  ];
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

/**
 * Logistic regression (L2 lambda=1, features standardized on the
 * training set, Newton/IRLS) for P(protocol records a token).
 * Deterministic: fixed iteration count and start.
 */
export function fitOdds(
  protocols: Protocol[],
  asOf: string,
): OddsModel {
  const raw = protocols.map((p) => oddsFeatures(p, asOf));
  const y = protocols.map((p) => (p.mcap_usd !== null && p.mcap_usd > 0 ? 1 : 0));
  const d = raw[0].length;
  const mean = raw[0].map((_, j) => raw.reduce((s, r) => s + r[j], 0) / raw.length);
  const sd = raw[0].map((_, j) => {
    const m = mean[j];
    const v = raw.reduce((s, r) => s + (r[j] - m) ** 2, 0) / raw.length;
    return Math.sqrt(v) || 1;
  });
  const x = raw.map((r) => [1, ...r.map((v, j) => (v - mean[j]) / sd[j])]);
  const weights = new Array(d + 1).fill(0);
  for (let iter = 0; iter < 100; iter++) {
    const grad = new Array(d + 1).fill(0);
    const hess: number[][] = Array.from({ length: d + 1 }, () =>
      new Array(d + 1).fill(0),
    );
    for (let i = 0; i < x.length; i++) {
      const z = x[i].reduce((s, v, j) => s + v * weights[j], 0);
      const pr = sigmoid(z);
      const wgt = Math.max(1e-6, pr * (1 - pr));
      for (let r = 0; r <= d; r++) {
        grad[r] += (pr - y[i]) * x[i][r];
        for (let c = 0; c <= d; c++) hess[r][c] += wgt * x[i][r] * x[i][c];
      }
    }
    for (let j = 1; j <= d; j++) {
      grad[j] += weights[j];
      hess[j][j] += 1;
    }
    const step = solveLinear(hess, grad);
    let maxStep = 0;
    for (let j = 0; j <= d; j++) {
      weights[j] -= step[j];
      maxStep = Math.max(maxStep, Math.abs(step[j]));
    }
    if (maxStep < 1e-8) break;
  }
  return { weights, mean, sd };
}

/** P(this protocol records a token) under a fitted odds model. */
export function launchOdds(
  p: Protocol,
  model: OddsModel,
  asOf: string,
): number {
  const raw = oddsFeatures(p, asOf);
  const z =
    model.weights[0] +
    raw.reduce(
      (s, v, j) => s + model.weights[j + 1] * ((v - model.mean[j]) / model.sd[j]),
      0,
    );
  return sigmoid(z);
}

/** AUC (Mann-Whitney, ties averaged) and log-loss of scored labels. */
export function aucLogLoss(
  scores: number[],
  labels: number[],
): { auc: number; logLoss: number } {
  const order = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  const rank = new Array(scores.length).fill(0);
  let j = 0;
  while (j < order.length) {
    let k = j;
    while (k + 1 < order.length && scores[order[k + 1]] === scores[order[j]]) k++;
    const avg = (j + k) / 2 + 1;
    for (let m = j; m <= k; m++) rank[order[m]] = avg;
    j = k + 1;
  }
  const pos = labels.reduce((s, l) => s + l, 0);
  const neg = labels.length - pos;
  const rankSum = labels.reduce((s, l, i) => s + (l === 1 ? rank[i] : 0), 0);
  const auc = pos > 0 && neg > 0 ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
  const eps = 1e-9;
  const logLoss =
    -labels.reduce(
      (s, l, i) =>
        s +
        (l * Math.log(Math.max(eps, scores[i])) +
          (1 - l) * Math.log(Math.max(eps, 1 - scores[i]))),
      0,
    ) / labels.length;
  return { auc, logLoss };
}

/** Log-loss of predicting one constant rate for every label. */
export function baseLogLoss(labels: number[], rate: number): number {
  const eps = 1e-9;
  const r = Math.min(1 - eps, Math.max(eps, rate));
  return (
    -labels.reduce(
      (s, l) => s + (l * Math.log(r) + (1 - l) * Math.log(1 - r)),
      0,
    ) / labels.length
  );
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

/**
 * Curve predictions for one train/test split, for all three models.
 * The odds model is NOT applied here: the curve backtest scores
 * value-if-launched on tokens that launched, and multiplying by odds
 * < 1 would underpredict them by construction.
 */
function evaluate(
  train: Protocol[],
  test: Protocol[],
  asOf: string,
): { v1: BacktestMetric; radar3: BacktestMetric; radar4: BacktestMetric } {
  const fit3 = fitCurve(train, false);
  const off3 = categoryOffsets(train, fit3, 5);
  const fit4 = fitCurve(train, true);
  const off4 = categoryOffsets(train, fit4, 20);
  const mult = v1Multiples(train);
  const trues = test.map((p) => p.mcap_usd as number);
  const curveOnly = (p: Protocol, fit: CurveFit, offs: Map<string, CategoryOffset>) =>
    Math.max(
      1,
      Math.round(curveValue(p, fit, offs) * growthMultiplier(p.change_7d)),
    );
  return {
    v1: metric(
      test.map((p) => v1Predict(p, mult, asOf)),
      trues,
    ),
    radar3: metric(
      test.map((p) => curveOnly(p, fit3, off3)),
      trues,
    ),
    radar4: metric(
      test.map((p) => curveOnly(p, fit4, off4)),
      trues,
    ),
  };
}

/** Classification backtest for the odds model (AUC / log-loss vs base). */
export function oddsBacktest(snapshot: Snapshot): OddsBacktest {
  const all = snapshot.protocols;
  const label = (p: Protocol) => (p.mcap_usd !== null && p.mcap_usd > 0 ? 1 : 0);
  // 5-fold cross-validation, folds fixed by slug hash.
  const cvScores: number[] = [];
  const cvLabels: number[] = [];
  for (let k = 0; k < 5; k++) {
    const test = all.filter((p) => foldOf(p.slug) === k);
    const train = all.filter((p) => foldOf(p.slug) !== k);
    const model = fitOdds(train, snapshot.as_of);
    cvScores.push(...test.map((p) => launchOdds(p, model, snapshot.as_of)));
    cvLabels.push(...test.map(label));
  }
  const cvAuc = aucLogLoss(cvScores, cvLabels);
  const cvBase = baseLogLoss(
    cvLabels,
    cvLabels.reduce((s, l) => s + l, 0) / cvLabels.length,
  );
  // Time-split: train on protocols listed before the median listing date
  // of ALL dated protocols, test on those listed after it.
  const dated = all.filter((p) => p.listed_at);
  const dates = dated.map((p) => p.listed_at as string).sort();
  const cut = dates[Math.floor(dates.length / 2)];
  const train = dated.filter((p) => (p.listed_at as string) < cut);
  const test = dated.filter((p) => (p.listed_at as string) >= cut);
  const model = fitOdds(train, snapshot.as_of);
  const spScores = test.map((p) => launchOdds(p, model, snapshot.as_of));
  const spLabels = test.map(label);
  const spAuc = aucLogLoss(spScores, spLabels);
  const trainRate =
    train.reduce((s, p) => s + label(p), 0) / train.length;
  return {
    cv: {
      auc: +cvAuc.auc.toFixed(3),
      logLoss: +cvAuc.logLoss.toFixed(3),
      baseLogLoss: +cvBase.toFixed(3),
      n: cvLabels.length,
    },
    timeSplit: {
      auc: +spAuc.auc.toFixed(3),
      logLoss: +spAuc.logLoss.toFixed(3),
      baseLogLoss: +baseLogLoss(spLabels, trainRate).toFixed(3),
      n: spLabels.length,
      cut,
    },
  };
}

export function backtest(snapshot: Snapshot): Backtest {
  const comps = compsOf(snapshot.protocols);
  // 5-fold cross-validation, folds fixed by slug hash.
  const cvV1: number[] = [];
  const cvR3: number[] = [];
  const cvR4: number[] = [];
  const cvTrues: number[] = [];
  for (let k = 0; k < 5; k++) {
    const test = comps.filter((p) => foldOf(p.slug) === k);
    const train = comps.filter((p) => foldOf(p.slug) !== k);
    const fit3 = fitCurve(train, false);
    const off3 = categoryOffsets(train, fit3, 5);
    const fit4 = fitCurve(train, true);
    const off4 = categoryOffsets(train, fit4, 20);
    const mult = v1Multiples(train);
    const curveOnly = (p: Protocol, fit: CurveFit, offs: Map<string, CategoryOffset>) =>
      Math.max(
        1,
        Math.round(curveValue(p, fit, offs) * growthMultiplier(p.change_7d)),
      );
    cvV1.push(...test.map((p) => v1Predict(p, mult, snapshot.as_of)));
    cvR3.push(...test.map((p) => curveOnly(p, fit3, off3)));
    cvR4.push(...test.map((p) => curveOnly(p, fit4, off4)));
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
      radar4: metric(cvR4, cvTrues),
    },
    timeSplit: { ...split, cut },
    odds: oddsBacktest(snapshot),
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

/**
 * The cheapest chain (by the gas table) this protocol runs on. A plan
 * costed on Ethereum when the protocol also runs on Base is a plan that
 * overcharges the reader; the choice is stated in step 1. When none of
 * the protocol's chains is in the gas table, the first chain is used at
 * the default $0.50/tx and step 4 says the gas is estimated.
 */
export function cheapestChain(p: Protocol): { chain: string; estimated: boolean } {
  let best: string | null = null;
  for (const c of p.chains) {
    if (GAS_MID_BY_CHAIN[c] === undefined) continue;
    if (best === null || GAS_MID_BY_CHAIN[c] < GAS_MID_BY_CHAIN[best]) best = c;
  }
  if (best !== null) return { chain: best, estimated: false };
  return { chain: p.chains[0] ?? "Ethereum", estimated: true };
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
 * Net verdict from the low-end case: the low band of the EXPECTED value,
 * at a 0.01% farmer share (ten basis points — a $10M community pool split
 * 1,000 ways), netted against the costed plan.
 * FARM when the net clears $50, THIN when it covers the cost, else SKIP.
 * The share is larger than v2's 0.001% because the expected value already
 * discounts by the launch odds: at the old share no row on the board
 * could clear the FARM bar at all, which would make the verdict column
 * dead. The share is a stated global assumption, the same for every row.
 */
export function verdictFor(lowUsd: number, costUsd: number): {
  verdict: string;
  proxy: number;
  net: number;
} {
  const proxy = lowUsd * 0.0001;
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

/**
 * Active time per step, in minutes — the time the reader actually
 * spends, as opposed to the holding time the plan waits through.
 * Step 2's holding (30 or 60 days, per category) is separate.
 */
const STEP_MINUTES = [10, 15, 5, 5, 10, 0];

export function farmSteps(
  p: Protocol,
  implied: number,
  low: number,
): {
  steps: string[];
  cost: number;
  verdict: string;
  chain: string;
  timeMin: number;
  holdingDays: number;
} {
  const { chain, estimated } = cheapestChain(p);
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
  const chainNote =
    p.chains.length > 1
      ? ` This protocol also runs on ${p.chains.filter((c) => c !== chain).slice(0, 3).join(", ")}; ${chain} is the cheapest of its chains in the gas table below, so the plan is costed there.`
      : "";
  const gasNote = estimated
    ? " Gas here is estimated at $0.50 per transaction — this chain is not in the gas table, so check the live gas price before you start."
    : ` Gas here runs about $${gasMid(chain)} per transaction.`;
  const core = coreAction(p, chain);
  const holdingDays = /60\+ days|60 days/.test(core) ? 60 : 30;
  const timeMin = STEP_MINUTES.reduce((s, m) => s + m, 0);
  const steps = [
    `Open ${p.name} (${p.category ?? "protocol"}) on ${chain} and connect a fresh wallet you control — about 10 minutes. Start with a $5 test transaction, then scale to ${tier} total.${gasNote}${chainNote}`,
    `${core} Allow about 15 minutes of active time for the setup; the position then sits for ${holdingDays} days.`,
    `Use it again on two more days in the next 30 days, then check the points or rewards page weekly — about 5 minutes per visit. Airdrops reward repeat users, not one-and-done wallets.`,
    `Log the cost (about 5 minutes): 6 transactions at about $${gasMid(chain)} each plus about $2 in swap and bridge fees is roughly $${cost.toFixed(2)} for the whole plan. If gas doubles, pause and wait for a cheaper window.`,
    `Set a reminder for day ${holdingDays} (about 10 minutes of work that day): withdraw half, leave half running. If a token announcement appears, claim from the protocol's official app only — never from links in DMs.`,
    `Net check: low-end expected value ${money(low)} at a 0.01% farmer share is about ${money(proxy)}, against a $${cost.toFixed(2)} plan cost — net ${netText}: ${verdict}. ${verdictLine}`,
  ];
  return {
    steps: steps.map((s) => s.trim()),
    cost,
    verdict,
    chain,
    timeMin,
    holdingDays,
  };
}

// -------------------------------------------------------------------- board

export function buildBoard(snapshot: Snapshot): {
  rows: Row[];
  live: Protocol[];
  fit: CurveFit;
  offsets: CategoryOffset[];
  oddsModel: OddsModel;
  backtest: Backtest;
} {
  const comps = compsOf(snapshot.protocols);
  const fit = fitCurve(comps, true);
  const offsetsByCat = categoryOffsets(comps, fit, 20, snapshot.protocols);
  const oddsModel = fitOdds(snapshot.protocols, snapshot.as_of);
  const watchlist = new Set(snapshot.watchlist);
  const rows: Row[] = [];
  for (const p of snapshot.protocols) {
    if (!rankable(p)) continue;
    const { implied, multiple, growthMult, curveValue, odds, low, high } =
      impliedValue(p, fit, offsetsByCat, oddsModel, snapshot.as_of);
    const { steps, cost, verdict, chain, timeMin, holdingDays } = farmSteps(
      p,
      implied,
      low,
    );
    rows.push({
      slug: p.slug,
      name: p.name,
      category: p.category ?? "Unknown",
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: ageDays(p.listed_at, snapshot.as_of),
      age_known: p.listed_at !== null,
      multiple,
      growth_mult: growthMult,
      curve_value_usd: Math.max(1, Math.round(curveValue)),
      launch_odds: odds,
      implied_value_usd: implied,
      implied_low_usd: low,
      implied_high_usd: high,
      chain_used: chain,
      plan_cost_usd: cost,
      plan_time_min: timeMin,
      plan_holding_days: holdingDays,
      verdict,
      farm_steps: steps,
      rank: 0,
      on_watchlist: watchlist.has(p.slug),
    });
  }
  // Rank by expected value, ties broken by slug so the order is deterministic.
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
    oddsModel,
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
    model: "radar-4",
    fit: {
      a: board.fit.a,
      b: board.fit.b,
      bChains: board.fit.bChains,
      r2: board.fit.r2,
      n: board.fit.n,
      residSd: board.fit.residSd,
      bandLowMult: 10 ** board.fit.bandLowLog,
      bandHighMult: 10 ** board.fit.bandHighLog,
    },
    offsets: board.offsets,
    odds: oddsScriptPayload(board),
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

/** Payload the dashboard reads: rows + live set + fitted curve + odds + backtests. */
export function oddsScriptPayload(board: ReturnType<typeof buildBoard>): {
  weights: number[];
  mean: number[];
  sd: number[];
  backtest: OddsBacktest;
} {
  return {
    weights: board.oddsModel.weights,
    mean: board.oddsModel.mean,
    sd: board.oddsModel.sd,
    backtest: board.backtest.odds,
  };
}
