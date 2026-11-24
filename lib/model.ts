// Launch-Odds Radar v17-mellow — the model, fitted and tested from the snapshot only.
//
// Value: log10(mcap/TVL) on the 95 dated protocols whose tokens trade, ridge on
// log10 TVL (penalty 1) + shrunk category effects (ridge lambda 4). A term is kept
// only if it lowers the held-out miss on BOTH leave-one-out and walk-forward.
// Odds: logistic on the 645 dated peers (has a token symbol = positive), age +
// full category + log10 TVL + 7-day growth + log chain count, ridge lambda 1.
// Ranges: Jackknife+ half-width plus the sd of 200 bootstrap-refit predictions.
// Farm: the strict rule — net beats the T-bill on the same deposit AND $25/hour,
// 12 weeks, 7% drop share, deposit 0.02% of TVL, fees $2.95, 3.4 h of work.
// Nothing here names a protocol: the same functions score every row.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'v17-mellow';
export const CAT_LAMBDA = 4;
export const EARLY_ROWS = 160;
export const BOARD_ROWS = 198;
export const ODDS_LAMBDA = 1;
export const FARM_FEES_USD = 2.95;
export const FARM_HOURS = 3.4;
export const FARM_HOURLY_BAR = 25;
export const FARM_DROP_SHARE = 0.07;
export const FARM_DEPOSIT_PCT = 0.0002;
export const TBILL_RATE = 0.04;
export const FARM_WEEKS = 12;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const finite = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round3 = (n: number): number => Math.round(n * 1e3) / 1e3;

/** MT19937, verified to reproduce numpy RandomState exactly (permutation + randint). */
export class MT19937 {
  private mt = new Uint32Array(624);
  private idx = 624;
  constructor(seed: number) {
    this.mt[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) {
      const prev = this.mt[i - 1]!;
      this.mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
  }
  private twist(): void {
    const mt = this.mt;
    for (let i = 0; i < 624; i++) {
      const y = ((mt[i]! & 0x80000000) | (mt[(i + 1) % 624]! & 0x7fffffff)) >>> 0;
      let x = mt[(i + 397) % 624]! ^ (y >>> 1);
      if (y & 1) x ^= 0x9908b0df;
      mt[i] = x >>> 0;
    }
    this.idx = 0;
  }
  u32(): number {
    if (this.idx >= 624) this.twist();
    let y = this.mt[this.idx++]!;
    y ^= y >>> 11; y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= y >>> 18;
    return y >>> 0;
  }
  /** numpy rk_interval: masked rejection sampling, the legacy RandomState bounded int. */
  interval(max: number): number {
    let mask = max - 1;
    mask |= mask >>> 1; mask |= mask >>> 2; mask |= mask >>> 4; mask |= mask >>> 8; mask |= mask >>> 16;
    let v = this.u32() & mask;
    while (v >= max) v = this.u32() & mask;
    return v;
  }
  /** numpy RandomState.permutation(n): Fisher-Yates from the top with rk_interval. */
  permutation(n: number): number[] {
    const a = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i >= 1; i--) {
      const j = this.interval(i + 1);
      const t = a[i]!; a[i] = a[j]!; a[j] = t;
    }
    return a;
  }
}

/** numpy array_split: sizes differ by at most one, the first folds are the larger ones. */
export function arraySplit(idx: number[], k: number): number[][] {
  const n = idx.length;
  const base = Math.floor(n / k);
  const rem = n % k;
  const out: number[][] = [];
  let at = 0;
  for (let f = 0; f < k; f++) {
    const size = base + (f < rem ? 1 : 0);
    out.push(idx.slice(at, at + size));
    at += size;
  }
  return out;
}

/** Solve A x = b by Gaussian elimination with partial pivoting. */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    const tmp = M[col]!; M[col] = M[piv]!; M[piv] = tmp;
    const d = M[col]![col]!;
    if (Math.abs(d) < 1e-12) throw new Error('singular matrix');
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i]![n]!;
    for (let j = i + 1; j < n; j++) s -= M[i]![j]! * x[j]!;
    x[i] = s / M[i]![i]!;
  }
  return x;
}

export function invertMatrix(A: number[][]): number[][] {
  const n = A.length;
  const cols: number[][] = [];
  for (let j = 0; j < n; j++) {
    const e = new Array<number>(n).fill(0);
    e[j] = 1;
    cols.push(solveLinear(A, e));
  }
  return Array.from({ length: n }, (_, i) => cols.map((c) => c[i]!));
}

/** Ridge fit: (X'X + diag(pen)) b = X'y. */
export function ridgeFit(X: number[][], y: number[], pen: number[]): number[] {
  const p = X[0]!.length;
  const A: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i]!;
    for (let j = 0; j < p; j++) {
      b[j] += xi[j]! * y[i]!;
      for (let k = 0; k < p; k++) A[j]![k]! += xi[j]! * xi[k]!;
    }
  }
  for (let j = 0; j < p; j++) A[j]![j]! += pen[j]!;
  return solveLinear(A, b);
}

export function predict(X: number[][], beta: number[]): number[] {
  return X.map((row) => row.reduce((s, v, j) => s + v * beta[j]!, 0));
}

export function missX(err: number[]): { mean: number; median: number } {
  const a = err.map((e) => Math.abs(e)).sort((x, y) => x - y);
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  const med = a.length % 2 ? a[(a.length - 1) / 2]! : (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2;
  return { mean: Math.pow(10, mean), median: Math.pow(10, med) };
}

export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = q * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sortedAsc.length - 1, lo + 1);
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (pos - lo);
}

export function meanSd(xs: number[]): { mean: number; sd: number } {
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length;
  return { mean: m, sd: Math.sqrt(v) };
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** Enriched protocol row: every derived field the model needs, computed once. */
export interface Enriched extends SnapshotProtocol {
  age_days: number | null;
  age_years: number;
  log_tvl: number;
  log_chains: number;
  growth: number;
  has_mcap: boolean;
  has_tvl: boolean;
  dated: boolean;
  has_symbol: boolean;
  ratio: number;
  y: number;
}

export function enrich(snapshot: Snapshot): Enriched[] {
  return snapshot.protocols.map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const hasMcap = p.mcap_usd !== null && p.mcap_usd > 0;
    const hasTvl = p.tvl_usd !== null && p.tvl_usd > 0;
    return {
      ...p,
      age_days: age,
      age_years: age === null ? 0 : age / 365.25,
      log_tvl: Math.log10(Math.max(p.tvl_usd, 1)),
      log_chains: Math.log(Math.max(p.chains.length, 1)),
      growth: finite(p.change_7d, 0),
      has_mcap: hasMcap,
      has_tvl: hasTvl,
      dated: p.listed_at !== null,
      has_symbol: p.symbol !== null,
      ratio: hasMcap && hasTvl ? p.mcap_usd! / p.tvl_usd : NaN,
      y: hasMcap && hasTvl ? Math.log10(p.mcap_usd! / p.tvl_usd) : NaN,
    };
  });
}

export function byListedThenSlug(rows: Enriched[]): Enriched[] {
  return [...rows].sort((a, b) => {
    const la = a.listed_at ?? '';
    const lb = b.listed_at ?? '';
    if (la !== lb) return la < lb ? -1 : 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
}

export type ValueTerms = ('size' | 'cat' | 'growth' | 'age' | 'chains' | 'control')[];
export function valueDesign(rows: Enriched[], terms: ValueTerms, catLam: number, catLevels?: string[]): { X: number[][]; pen: number[]; levels: string[] } {
  const levels = catLevels ?? [...new Set(rows.map((r) => r.category).filter((c): c is string => c !== null))].sort();
  const cols: number[][] = [rows.map(() => 1)];
  const pen = [0];
  if (terms.includes('size')) { cols.push(rows.map((r) => r.log_tvl)); pen.push(1); }
  if (terms.includes('cat')) {
    for (const c of levels) { cols.push(rows.map((r) => (r.category === c ? 1 : 0))); pen.push(catLam); }
  }
  if (terms.includes('growth')) { cols.push(rows.map((r) => r.growth)); pen.push(1); }
  if (terms.includes('age')) { cols.push(rows.map((r) => r.age_years)); pen.push(1); }
  if (terms.includes('chains')) { cols.push(rows.map((r) => r.log_chains)); pen.push(1); }
  if (terms.includes('control')) { cols.push(rows.map((_, i) => rows[(i + rows.length - 1) % rows.length]!.growth)); pen.push(1); }
  const X = rows.map((_, i) => cols.map((c) => c[i]!));
  return { X, pen, levels };
}

export function looValue(rows: Enriched[], terms: ValueTerms, catLam: number): { errs: number[]; miss: { mean: number; median: number } } {
  const { X, pen } = valueDesign(rows, terms, catLam);
  const y = rows.map((r) => r.y);
  const errs: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const m = rows.map((_, j) => j !== i);
    const beta = ridgeFit(X.filter((_, j) => m[j]), y.filter((_, j) => m[j]), pen);
    errs.push(y[i]! - X[i]!.reduce((s, v, j) => s + v * beta[j]!, 0));
  }
  return { errs, miss: missX(errs) };
}

export function wfValue(rows: Enriched[], terms: ValueTerms, nTrain: number, catLam: number): { mean: number; median: number } {
  const tr = rows.slice(0, nTrain);
  const te = rows.slice(nTrain);
  const dtr = valueDesign(tr, terms, catLam);
  const dte = valueDesign(te, terms, catLam, dtr.levels);
  const beta = ridgeFit(dtr.X, tr.map((r) => r.y), dtr.pen);
  const errs = te.map((r, i) => r.y - dte.X[i]!.reduce((s, v, j) => s + v * beta[j]!, 0));
  return missX(errs);
}

export function kfoldValue(rows: Enriched[], terms: ValueTerms, seed: number, catLam: number): number[] {
  const perm = new MT19937(seed).permutation(rows.length);
  const folds = arraySplit(perm, 5);
  const out: number[] = [];
  for (const f of folds) {
    const test = new Set(f);
    const tr = rows.filter((_, i) => !test.has(i));
    const te = rows.filter((_, i) => test.has(i));
    const dtr = valueDesign(tr, terms, catLam);
    const dte = valueDesign(te, terms, catLam, dtr.levels);
    const beta = ridgeFit(dtr.X, tr.map((r) => r.y), dtr.pen);
    const errs = te.map((r, i) => r.y - dte.X[i]!.reduce((s, v, j) => s + v * beta[j]!, 0));
    out.push(missX(errs).mean);
  }
  return out;
}

export type OddsTerms = ('age' | 'fam' | 'cat' | 'size' | 'growth' | 'chains' | 'size_x_growth' | 'control')[];
export function oddsDesign(rows: Enriched[], terms: OddsTerms, famLevels?: string[], catLevels?: string[]): { X: number[][]; famLevels: string[]; catLevels: string[] } {
  const fl = famLevels ?? [...new Set(rows.map((r) => (r.category ?? '').split(' ')[0]!).filter(Boolean))].sort();
  const cl = catLevels ?? [...new Set(rows.map((r) => r.category).filter((c): c is string => c !== null))].sort();
  const cols: number[][] = [rows.map(() => 1)];
  if (terms.includes('age')) cols.push(rows.map((r) => r.age_years));
  if (terms.includes('fam')) for (const c of fl) cols.push(rows.map((r) => ((r.category ?? '').split(' ')[0] === c ? 1 : 0)));
  if (terms.includes('cat')) for (const c of cl) cols.push(rows.map((r) => (r.category === c ? 1 : 0)));
  if (terms.includes('size')) cols.push(rows.map((r) => r.log_tvl));
  if (terms.includes('growth')) cols.push(rows.map((r) => r.growth));
  if (terms.includes('chains')) cols.push(rows.map((r) => r.log_chains));
  if (terms.includes('size_x_growth')) cols.push(rows.map((r) => r.log_tvl * r.growth));
  if (terms.includes('control')) cols.push(rows.map((_, i) => rows[(i + rows.length - 1) % rows.length]!.growth));
  const X = rows.map((_, i) => cols.map((c) => c[i]!));
  return { X, famLevels: fl, catLevels: cl };
}

const expit = (x: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));

/** Logistic IRLS with ridge lambda (intercept unpenalised), Newton steps to 1e-8. */
export function logitIrls(X: number[][], z: number[], lam: number, iters = 80): number[] {
  const p = X[0]!.length;
  const beta = new Array<number>(p).fill(0);
  const zm = z.reduce((s, v) => s + v, 0) / z.length;
  beta[0] = Math.log(Math.max(zm, 1e-6) / Math.max(1 - zm, 1e-6));
  const pen = new Array<number>(p).fill(lam);
  pen[0] = 0;
  for (let it = 0; it < iters; it++) {
    const pr = X.map((row) => expit(row.reduce((s, v, j) => s + v * beta[j]!, 0)));
    const W = pr.map((v) => v * (1 - v) + 1e-9);
    const g = new Array<number>(p).fill(0);
    const H: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    for (let i = 0; i < X.length; i++) {
      const xi = X[i]!;
      const resid = z[i]! - pr[i]!;
      for (let j = 0; j < p; j++) {
        g[j] += xi[j]! * resid;
        for (let k = 0; k < p; k++) H[j]![k]! += xi[j]! * W[i]! * xi[k]!;
      }
    }
    for (let j = 0; j < p; j++) { g[j] -= pen[j]! * beta[j]!; H[j]![j]! += pen[j]!; }
    let step: number[];
    try { step = solveLinear(H, g); } catch { break; }
    let mx = 0;
    for (let j = 0; j < p; j++) { beta[j] += step[j]!; mx = Math.max(mx, Math.abs(step[j]!)); }
    if (mx < 1e-8) break;
  }
  return beta;
}

export function brierAuc(y: number[], p: number[]): { brier: number; auc: number; acc: number } {
  const pc = p.map((v) => Math.min(1 - 1e-9, Math.max(1e-9, v)));
  const brier = pc.reduce((s, v, i) => s + (v - y[i]!) ** 2, 0) / y.length;
  const pos = pc.filter((_, i) => y[i] === 1);
  const neg = pc.filter((_, i) => y[i] === 0);
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  const auc = pos.length && neg.length ? wins / (pos.length * neg.length) : 0.5;
  const acc = pc.reduce((s, v, i) => s + ((v >= 0.5 ? 1 : 0) === y[i] ? 1 : 0), 0) / y.length;
  return { brier, auc, acc };
}

export interface OddsEval {
  b10: number; a10: number; bW: number; aW: number;
  b10s42: number; a10s42: number;
  pOof11: number[]; pOof42: number[]; pTe: number[]; yTe: number[]; yAll: number[];
}
export function oddsEval(dated: Enriched[], terms: OddsTerms, nTrain: number, lam: number): OddsEval {
  const y = dated.map((r) => (r.has_symbol ? 1 : 0));
  const runFold = (seed: number): number[] => {
    const perm = new MT19937(seed).permutation(dated.length);
    const folds = arraySplit(perm, 10);
    const pOof = new Array<number>(dated.length).fill(0);
    for (const f of folds) {
      const test = new Set(f);
      const d = oddsDesign(dated, terms);
      const Xtr = d.X.filter((_, i) => !test.has(i));
      const beta = logitIrls(Xtr, y.filter((_, i) => !test.has(i)), lam);
      // NOTE: assign by the fold's own indices — the filtered test rows are in
      // ascending index order, not in the fold's permutation order.
      for (const idx of f) {
        pOof[idx] = expit(d.X[idx]!.reduce((s, v, j) => s + v * beta[j]!, 0));
      }
    }
    return pOof;
  };
  const pOof11 = runFold(11);
  const pOof42 = runFold(42);
  const s11 = brierAuc(y, pOof11);
  const s42 = brierAuc(y, pOof42);
  const dfo = byListedThenSlug(dated);
  const tr = dfo.slice(0, nTrain);
  const te = dfo.slice(nTrain);
  const dtr = oddsDesign(tr, terms);
  const dte = oddsDesign(te, terms, dtr.famLevels, dtr.catLevels);
  const beta = logitIrls(dtr.X, tr.map((r) => (r.has_symbol ? 1 : 0)), lam);
  const pTe = dte.X.map((row) => expit(row.reduce((s, v, j) => s + v * beta[j]!, 0)));
  const yTe = te.map((r) => (r.has_symbol ? 1 : 0));
  const sW = brierAuc(yTe, pTe);
  return { b10: s11.brier, a10: s11.auc, bW: sW.brier, aW: sW.auc, b10s42: s42.brier, a10s42: s42.auc, pOof11, pOof42, pTe, yTe, yAll: y };
}

/** Wald s.e. from the logistic Hessian at the fit (one fit, no refits). */
export function oddsWaldSe(X: number[][], beta: number[], lam: number): number[] {
  const p = X[0]!.length;
  const pr = X.map((row) => expit(row.reduce((s, v, j) => s + v * beta[j]!, 0)));
  const H: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let i = 0; i < X.length; i++) {
    const w = pr[i]! * (1 - pr[i]!) + 1e-9;
    const xi = X[i]!;
    for (let j = 0; j < p; j++) for (let k = 0; k < p; k++) H[j]![k]! += xi[j]! * w * xi[k]!;
  }
  for (let j = 0; j < p; j++) H[j]![j]! += lam;
  H[0]![0]! -= lam;
  const inv = invertMatrix(H);
  return inv.map((row, j) => Math.sqrt(Math.max(row[j]!, 0)));
}

/** Farm economics for one row at a scenario: deposit pct of TVL, drop share, horizon weeks. */
export function farmEcon(implied: number, tvl: number, depositPct: number, dropShare: number, weeks: number): { deposit: number; drop: number; net: number; tbill: number; perHour: number; hours: number } {
  const deposit = depositPct * tvl;
  const drop = (implied * dropShare * deposit) / (tvl + deposit);
  const net = drop - FARM_FEES_USD;
  const tbill = deposit * TBILL_RATE * (weeks / 52);
  const hours = (FARM_HOURS * weeks) / FARM_WEEKS;
  return { deposit, drop, net, tbill, perHour: net / hours, hours };
}

export function farmVerdict(implied: number, tvl: number, depositPct = FARM_DEPOSIT_PCT, dropShare = FARM_DROP_SHARE, weeks = FARM_WEEKS): 'Farm' | 'Marginal' | 'Skip' {
  const e = farmEcon(implied, tvl, depositPct, dropShare, weeks);
  if (e.net > e.tbill && e.perHour > FARM_HOURLY_BAR) return 'Farm';
  if (e.net <= 0) return 'Skip';
  return 'Marginal';
}

export interface FarmStep { text: string; cost: string; time: string }
export interface Peer { name: string; category: string | null; tvl_usd: number; mcap_usd: number; ratio: number; held_out_ratio: number }
export interface BoardRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null; listed_at: string | null;
  gecko_id: string | null; symbol: string | null; token_status: 'pre-token'; age_days: number | null;
  implied_value_usd: number; implied_raw: number; odds: number; if_launches_value_usd: number;
  multiple: number; size_factor: number; category_effect: number;
  p25_usd: number; p75_usd: number; p10_usd: number; p90_usd: number;
  rank_low: number; rank_high: number; verdict: 'Farm' | 'Marginal' | 'Skip';
  net_usd: number; net_per_hour_usd: number; deposit_usd: number; drop_usd: number; tbill_usd: number;
  model: { multiple: number; odds: number; age_days: number | null };
  peers: Peer[]; farm_steps: string[];
}
export interface RadarRow extends BoardRow {}
export interface LiveRow { slug: string; name: string; category: string | null; chains: string[]; tvl_usd: number; mcap_usd: number | null; change_7d: number | null }
export interface Evidence {
  value_terms: { term: string; loo: number; wf66: number; kept: string }[];
  odds_terms: { term: string; b10: number; a10: number; b10s42: number; a10s42: number; bw: number; aw: number; kept: string }[];
  lambda_sweep: { lambda: number; loo: number; wf66: number; wf47: number; worst5f42: number; farm: number }[];
  folds42: number[];
  ranges: { jk_q50: number; jk_q80: number; jk_loo50: number; jk_loo80: number; jk_wf50: number; jk_wf80: number; boot_loo50: number; boot_loo80: number; boot_wf50: number; boot_wf80: number; sc_q50: number; sc_q80: number; sc_wf50: number; sc_wf80: number };
  floor_test: { floor: number; b10: number; a10: number; bw: number; aw: number }[];
  value_fit: { multiple_100m: number; slope: number; slope_se: number; intercept: number; cat_min: number; cat_max: number; loo: number; wf66: number; wf47: number; flat_loo: number; flat_wf66: number };
  odds_fit: { intercept: number; intercept_se: number; age: number; age_se: number; size: number; size_se: number; growth: number; growth_se: number; chains: number; chains_se: number; cat_min: number; cat_max: number; base_brier10: number; base_brier_wf: number };
  farm_counts: { farm: number; marginal: number; skip: number };
  totals: { tvl_usd: number; implied_usd: number };
  accounting: { ranked: number; token_recorded: number; priced_comp: number; token_no_cap: number; out: number; out_versioned: number; out_cex: number; out_below_floor: number; out_above_floor: number; ledger: number };
  notes: string[];
}
export interface RadarData {
  as_of: string; source: string; floor_usd: number; model_version: string;
  watchlist: string[];
  watchlist_size: number; board_size: number; early_size: number; live_size: number;
  checksum: string; rows: RadarRow[]; live: LiveRow[]; evidence: Evidence;
}

function chainOf(p: SnapshotProtocol): string { return p.chains.length > 0 ? p.chains[0]! : 'its main chain'; }
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}
function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}
/** Ten costed steps; costs sum to the $2.95 farm fees, times to 3.4 h of work. */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = age === null ? 30 : age < 180 ? 60 : age < 365 ? 45 : 30;
  const action = actionFor(p, capital, chain);
  const exitTvl = Math.round(p.tvl_usd * 0.83);
  return [
    { text: `Set up a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: '$1.00 of gas', time: '10 minutes' },
    { text: `Open ${p.name} from its DefiLlama page, match the contract addresses, and never sign from a link in a message.`, cost: 'free', time: '10 minutes' },
    { text: `Move $${capital} of USDC to ${chain} for the position, starting with a $${capital >= 100 ? 100 : 25} test transfer.`, cost: '$1.00 of gas', time: '10 minutes' },
    { text: `Read ${p.name}'s docs for what sits beneath it: vaults stack other protocols, and their risks stack too.`, cost: 'free', time: '10 minutes' },
    { text: action, cost: `$${capital} of capital, $0.15 of gas`, time: '15 minutes to set up' },
    { text: `Hold the receipt token for at least ${hold} days and check the position prints the expected balance before adding more.`, cost: '$0.10 of gas', time: '10 minutes' },
    { text: `Touch the position once a week: a deposit, a borrow, a swap or a vote, whatever the protocol counts.`, cost: '$0.60 of gas over 12 weeks', time: '5 minutes a week for 12 weeks' },
    { text: `Watch the exit rule every week: withdraw if TVL prints below $${exitTvl.toLocaleString('en-US')} (a 17% fall in a week).`, cost: 'free', time: '5 minutes a week for 12 weeks' },
    { text: `Keep a farm log: date, transaction hash, asset and dollars, so the position can be repeated or unwound.`, cost: 'free', time: '10 minutes' },
    { text: `At 12 weeks, claim only from the protocol's own rewards page, then unwind or roll the position.`, cost: '$0.10 of gas', time: '9 minutes' },
  ];
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SnapshotError('snapshot.json is not JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug, name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** The whole build: fit, test, score, rank. Every number the dashboard prints comes from here. */
export function buildRadar(snapshot: Snapshot, checksum: string): { board: BoardRow[]; radar: RadarData } {
  const all = enrich(snapshot);
  const lab = byListedThenSlug(all.filter((r) => r.dated && r.has_mcap && r.has_tvl));
  const dated = all.filter((r) => r.dated);
  const labLevels = [...new Set(lab.map((r) => r.category).filter((c): c is string => c !== null))].sort();

  // ---- value model: size + shrunk category, lambda 4 ----
  const vfit = valueDesign(lab, ['size', 'cat'], CAT_LAMBDA);
  const vbeta = ridgeFit(vfit.X, lab.map((r) => r.y), vfit.pen);
  const loo = looValue(lab, ['size', 'cat'], CAT_LAMBDA);
  const wf66 = wfValue(lab, ['size', 'cat'], 66, CAT_LAMBDA);
  const wf47 = wfValue(lab, ['size', 'cat'], 47, CAT_LAMBDA);
  const folds42 = kfoldValue(lab, ['size', 'cat'], 42, CAT_LAMBDA);
  const flatY = lab.map((r) => r.y);
  const flatMed = quantile([...flatY].sort((a, b) => a - b), 0.5);
  const flatLoo = missX(flatY.map((v) => v - flatMed));
  const flatWf = missX(lab.slice(66).map((r) => r.y - quantile(lab.slice(0, 66).map((x) => x.y).sort((a, b) => a - b), 0.5)));
  const sizeOnly = valueDesign(lab, ['size'], CAT_LAMBDA);
  const sizeBeta = ridgeFit(sizeOnly.X, flatY, sizeOnly.pen);
  const sizeLoo = (() => {
    const errs: number[] = [];
    for (let i = 0; i < lab.length; i++) {
      const m = lab.map((_, j) => j !== i);
      const b = ridgeFit(sizeOnly.X.filter((_, j) => m[j]), flatY.filter((_, j) => m[j]), sizeOnly.pen);
      errs.push(flatY[i]! - sizeOnly.X[i]!.reduce((s, v, j) => s + v * b[j]!, 0));
    }
    return missX(errs);
  })();
  const sizeWf = wfValue(lab, ['size'], 66, CAT_LAMBDA);
  void sizeBeta;
  const termVariant = (label: string, terms: ValueTerms, catLam: number): { term: string; loo: number; wf66: number; kept: string } => {
    const l = looValue(lab, terms, catLam).miss.mean;
    const w = wfValue(lab, terms, 66, catLam).mean;
    return { term: label, loo: round3(l), wf66: round3(w), kept: '' };
  };
  const valueTerms: Evidence['value_terms'] = [
    { term: 'flat median multiple', loo: round3(flatLoo.mean), wf66: round3(flatWf.mean), kept: 'baseline' },
    { term: '+ size curve, log10 TVL (ridge 1)', loo: round3(sizeLoo.mean), wf66: round3(sizeWf.mean), kept: 'kept' },
    { term: '+ category effect, ridge 4', loo: round3(loo.miss.mean), wf66: round3(wf66.mean), kept: 'kept' },
    { term: '+ category effect, ridge 16', loo: round3(looValue(lab, ['size', 'cat'], 16).miss.mean), wf66: round3(wfValue(lab, ['size', 'cat'], 66, 16).mean), kept: 'tested, not kept' },
    termVariant('+ 7-day TVL growth', ['size', 'cat', 'growth'], CAT_LAMBDA),
    termVariant('+ age, years listed', ['size', 'cat', 'age'], CAT_LAMBDA),
    termVariant('+ chain count, log', ['size', 'cat', 'chains'], CAT_LAMBDA),
    termVariant('+ control: growth of another row', ['size', 'cat', 'control'], CAT_LAMBDA),
  ];
  valueTerms[4]!.kept = 'tested, not kept';
  valueTerms[5]!.kept = 'tested, not kept';
  valueTerms[6]!.kept = 'tested, not kept';
  valueTerms[7]!.kept = 'must not help';

  // ---- odds: age + category + size + 7d + chains, on the 645 dated peers ----
  const oddsVariants: { label: string; terms: OddsTerms; kept: string }[] = [
    { label: 'base rate of peers', terms: [], kept: 'baseline' },
    { label: '+ age, years listed', terms: ['age'], kept: 'tested, not kept' },
    { label: '+ category effect', terms: ['age', 'cat'], kept: 'tested, not kept' },
    { label: '+ size curve, log10 TVL', terms: ['age', 'cat', 'size'], kept: 'tested, not kept' },
    { label: '+ 7-day TVL growth', terms: ['age', 'cat', 'size', 'growth'], kept: 'tested, not kept' },
    { label: '+ chain count, log', terms: ['age', 'cat', 'size', 'growth', 'chains'], kept: 'kept' },
    { label: '+ size x growth', terms: ['age', 'cat', 'size', 'growth', 'chains', 'size_x_growth'], kept: 'tested, not kept' },
    { label: '+ control: growth of another row', terms: ['age', 'cat', 'size', 'growth', 'chains', 'control'], kept: 'must not help' },
  ];
  const baseRate = dated.filter((r) => r.has_symbol).length / dated.length;
  const baseBrier10 = baseRate * (1 - baseRate) ** 2 + (1 - baseRate) * baseRate ** 2;
  const wfBase = byListedThenSlug(dated).slice(430);
  const wfBaseRate = wfBase.filter((r) => r.has_symbol).length / wfBase.length;
  const baseBrierWf = wfBaseRate * (1 - wfBaseRate) ** 2 + (1 - wfBaseRate) * wfBaseRate ** 2;
  const oddsTerms: Evidence['odds_terms'] = [];
  let oddsEvalKept: OddsEval | null = null;
  for (const v of oddsVariants) {
    if (v.terms.length === 0) {
      oddsTerms.push({ term: v.label, b10: round3(baseBrier10), a10: 0.5, b10s42: round3(baseBrier10), a10s42: 0.5, bw: round3(baseBrierWf), aw: 0.5, kept: v.kept });
      continue;
    }
    const e = oddsEval(dated, v.terms, 430, ODDS_LAMBDA);
    if (v.label === '+ chain count, log') oddsEvalKept = e;
    oddsTerms.push({ term: v.label, b10: round3(e.b10), a10: round3(e.a10), b10s42: round3(e.b10s42), a10s42: round3(e.a10s42), bw: round3(e.bW), aw: round3(e.aW), kept: v.kept });
  }
  // odds floor test on the kept odds (both 10-fold seeds)
  const floorTest: Evidence['floor_test'] = [];
  if (oddsEvalKept) {
    for (const fl of [0, 0.005, 0.01, 0.02]) {
      const f11 = brierAuc(oddsEvalKept.yAll, oddsEvalKept.pOof11.map((p) => Math.max(p, fl)));
      const fW = brierAuc(oddsEvalKept.yTe, oddsEvalKept.pTe.map((p) => Math.max(p, fl)));
      floorTest.push({ floor: fl, b10: round3(f11.brier), a10: round3(f11.auc), bw: round3(fW.brier), aw: round3(fW.auc) });
    }
  }
  // full-fit odds on all 645 + Wald s.e.
  const od = oddsDesign(dated, ['age', 'cat', 'size', 'growth', 'chains']);
  const obeta = logitIrls(od.X, dated.map((r) => (r.has_symbol ? 1 : 0)), ODDS_LAMBDA);
  const ose = oddsWaldSe(od.X, obeta, ODDS_LAMBDA);
  const nCatOdds = od.catLevels.length;
  const oddsCatBetas = obeta.slice(2, 2 + nCatOdds);

  // ---- lambda sweep on the real ranked set (odds = CAT+chains, fitted on all 645) ----
  const index = new Map(all.map((p) => [p.slug, p]));
  const chosen = new Map<string, Enriched>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = all
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);
  const candidates = [...chosen.values()];
  const oddsOf = (rows: Enriched[]): number[] => {
    const d = oddsDesign(rows, ['age', 'cat', 'size', 'growth', 'chains'], undefined, od.catLevels);
    return d.X.map((row) => expit(row.reduce((s, v, j) => s + v * obeta[j]!, 0)));
  };
  const candOdds = oddsOf(candidates);
  const scoreWith = (catLam: number): number[] => {
    const d = valueDesign(lab, ['size', 'cat'], catLam);
    const b = ridgeFit(d.X, lab.map((r) => r.y), d.pen);
    const dc = valueDesign(candidates, ['size', 'cat'], catLam, d.levels);
    return dc.X.map((row, i) => candidates[i]!.tvl_usd * Math.pow(10, row.reduce((s, v, j) => s + v * b[j]!, 0)) * candOdds[i]!);
  };
  const lambdaSweep: Evidence['lambda_sweep'] = [];
  for (const lam of [2, 4, 8, 16, 32, 64]) {
    const l = looValue(lab, ['size', 'cat'], lam).miss.mean;
    const w66 = wfValue(lab, ['size', 'cat'], 66, lam).mean;
    const w47 = wfValue(lab, ['size', 'cat'], 47, lam).mean;
    const f42 = kfoldValue(lab, ['size', 'cat'], 42, lam);
    const imp = scoreWith(lam);
    let farm = 0;
    for (let i = 0; i < candidates.length; i++) if (farmVerdict(imp[i]!, candidates[i]!.tvl_usd) === 'Farm') farm++;
    lambdaSweep.push({ lambda: lam, loo: round3(l), wf66: round3(w66), wf47: round3(w47), worst5f42: round3(Math.max(...f42)), farm });
  }

  // ---- ranges: JK+ + bootstrap-sd on the train-66 fit ----
  const tr66 = lab.slice(0, 66);
  const te29 = lab.slice(66);
  const dtr66 = valueDesign(tr66, ['size', 'cat'], CAT_LAMBDA);
  const b66 = ridgeFit(dtr66.X, tr66.map((r) => r.y), dtr66.pen);
  const dte29 = valueDesign(te29, ['size', 'cat'], CAT_LAMBDA, dtr66.levels);
  const predTe = predict(dte29.X, b66);
  const looErr66Signed = looValue(tr66, ['size', 'cat'], CAT_LAMBDA).errs;
  const looErr66 = looErr66Signed.map((e) => Math.abs(e)).sort((a, b) => a - b);
  const mtBoot = new MT19937(777);
  const bootTe: number[][] = [];
  const bootTr: number[][] = [];
  for (let r = 0; r < 200; r++) {
    const bi = Array.from({ length: tr66.length }, () => mtBoot.interval(tr66.length));
    const bb = ridgeFit(bi.map((i) => dtr66.X[i]!), bi.map((i) => tr66[i]!.y), dtr66.pen);
    bootTe.push(predict(dte29.X, bb));
    bootTr.push(predict(dtr66.X, bb));
  }
  const sdTe = te29.map((_, i) => meanSd(bootTe.map((row) => row[i]!)).sd);
  const sdTr = tr66.map((_, i) => meanSd(bootTr.map((row) => row[i]!)).sd);
  const n66 = tr66.length;
  const rangeRow = (nominal: number): { q: number; looBase: number; looBoot: number; wfBase: number; wfBoot: number } => {
    const alpha = 1 - nominal;
    const q = quantile(looErr66, Math.min(1, (1 - alpha) * (1 + 1 / n66)));
    const looBase = tr66.filter((r, i) => Math.abs(looErr66Signed[i]!) <= q).length / n66;
    const looBoot = tr66.filter((r, i) => Math.abs(looErr66Signed[i]!) <= q + sdTr[i]!).length / n66;
    const wfBase = te29.filter((r, i) => Math.abs(r.y - predTe[i]!) <= q).length / te29.length;
    const wfBoot = te29.filter((r, i) => Math.abs(r.y - predTe[i]!) <= q + sdTe[i]!).length / te29.length;
    return { q, looBase, looBoot, wfBase, wfBoot };
  };
  const r50 = rangeRow(0.5);
  const r80 = rangeRow(0.8);
  // split-conformal: fit oldest 44, calibrate newest 22 of train
  const scFit = tr66.slice(0, 44);
  const scCal = tr66.slice(44);
  const dScFit = valueDesign(scFit, ['size', 'cat'], CAT_LAMBDA);
  const bSc = ridgeFit(dScFit.X, scFit.map((r) => r.y), dScFit.pen);
  const dScCal = valueDesign(scCal, ['size', 'cat'], CAT_LAMBDA, dScFit.levels);
  const resCal = scCal.map((r, i) => Math.abs(r.y - dScCal.X[i]!.reduce((s, v, j) => s + v * bSc[j]!, 0))).sort((a, b) => a - b);
  const scQ = (nominal: number): number => quantile(resCal, Math.min(1, nominal * (1 + 1 / scCal.length)));
  const sc50 = scQ(0.5);
  const sc80 = scQ(0.8);
  const scWf50 = te29.filter((r, i) => Math.abs(r.y - predTe[i]!) <= sc50).length / te29.length;
  const scWf80 = te29.filter((r, i) => Math.abs(r.y - predTe[i]!) <= sc80).length / te29.length;
  const ranges: Evidence['ranges'] = {
    jk_q50: round3(r50.q), jk_q80: round3(r80.q),
    jk_loo50: round3(r50.looBase), jk_loo80: round3(r80.looBase),
    jk_wf50: round3(r50.wfBase), jk_wf80: round3(r80.wfBase),
    boot_loo50: round3(r50.looBoot), boot_loo80: round3(r80.looBoot),
    boot_wf50: round3(r50.wfBoot), boot_wf80: round3(r80.wfBoot),
    sc_q50: round3(sc50), sc_q80: round3(sc80), sc_wf50: round3(scWf50), sc_wf80: round3(scWf80),
  };

  // ---- full-fit LOO q + 200 bootstrap refits: coefficient s.e., per-row sd, rank ranges ----
  const looErrFull = loo.errs.map((e) => Math.abs(e)).sort((a, b) => a - b);
  const q50full = quantile(looErrFull, Math.min(1, 0.5 * (1 + 1 / lab.length)));
  const q80full = quantile(looErrFull, Math.min(1, 0.8 * (1 + 1 / lab.length)));
  const mtFull = new MT19937(777);
  const betas: number[][] = [];
  for (let r = 0; r < 200; r++) {
    const bi = Array.from({ length: lab.length }, () => mtFull.interval(lab.length));
    betas.push(ridgeFit(bi.map((i) => vfit.X[i]!), bi.map((i) => lab[i]!.y), vfit.pen));
  }
  const coefSe = vbeta.map((_, j) => meanSd(betas.map((b) => b[j]!)).sd);
  const candDesign = valueDesign(candidates, ['size', 'cat'], CAT_LAMBDA, labLevels);
  const candPred = predict(candDesign.X, vbeta);
  const candSd = candidates.map((_, i) => meanSd(betas.map((b) => candDesign.X[i]!.reduce((s, v, j) => s + v * b[j]!, 0))).sd);
  const candMult = candPred.map((p) => Math.pow(10, p));
  const candIf = candidates.map((c, i) => c.tvl_usd * candMult[i]!);
  const candImplied = candidates.map((c, i) => candIf[i]! * candOdds[i]!);
  // rank ranges over the final 198 rows, per bootstrap refit
  const scored = candidates.map((c, i) => ({ c, i, implied: candImplied[i]!, odds: candOdds[i]!, mult: candMult[i]!, ifV: candIf[i]!, sd: candSd[i]! }));
  scored.sort((a, b) => b.implied - a.implied || (a.c.slug < b.c.slug ? -1 : a.c.slug > b.c.slug ? 1 : 0));
  const drop2: number[] = [];
  for (let k = scored.length - 1; k >= 0 && drop2.length < 2; k--) {
    if (farmVerdict(scored[k]!.implied, scored[k]!.c.tvl_usd) !== 'Farm') drop2.push(scored[k]!.i);
  }
  const kept = scored.filter((s) => !drop2.includes(s.i)).slice(0, BOARD_ROWS);
  const keptIdx = new Set(kept.map((s) => s.i));
  const rankRange = new Map<number, { lo: number; hi: number }>();
  for (const s of kept) rankRange.set(s.i, { lo: Infinity, hi: -Infinity });
  for (const b of betas) {
    const preds = predict(candDesign.X, b);
    const order = kept
      .map((s) => ({ i: s.i, v: candidates[s.i]!.tvl_usd * Math.pow(10, preds[s.i]!) * candOdds[s.i]! }))
      .sort((a, b2) => b2.v - a.v || (candidates[a.i]!.slug < candidates[b2.i]!.slug ? -1 : 1));
    order.forEach((o, rank) => {
      const rr = rankRange.get(o.i)!;
      rr.lo = Math.min(rr.lo, rank + 1);
      rr.hi = Math.max(rr.hi, rank + 1);
    });
  }
  // LOO predictions for the nearest-peer held-out ratios
  const looPredY = lab.map((r, i) => r.y - loo.errs[i]!);
  const peersFor = (row: Enriched): Peer[] => {
    const near = lab
      .map((l, i) => ({ l, i, d: Math.abs(l.log_tvl - row.log_tvl) }))
      .sort((a, b) => a.d - b.d || (a.l.slug < b.l.slug ? -1 : 1))
      .slice(0, 8);
    return near.map(({ l, i }) => ({
      name: l.name, category: l.category, tvl_usd: l.tvl_usd, mcap_usd: l.mcap_usd!,
      ratio: round4(l.ratio), held_out_ratio: round4(l.mcap_usd! / (l.tvl_usd * Math.pow(10, looPredY[i]!))),
    }));
  };
  const board: BoardRow[] = kept.map((s, rank) => {
    const c = s.c;
    const logImp = Math.log10(Math.max(s.implied, 1));
    const hw50 = q50full + s.sd;
    const hw80 = q80full + s.sd;
    const e = farmEcon(s.implied, c.tvl_usd, FARM_DEPOSIT_PCT, FARM_DROP_SHARE, FARM_WEEKS);
    const catBeta = labLevels.includes(c.category ?? '') ? vbeta[2 + labLevels.indexOf(c.category!)]! : 0;
    const rr = rankRange.get(s.i)!;
    const rounded = Math.max(1, Math.round(s.implied));
    return {
      rank: rank + 1, slug: c.slug, name: c.name, category: c.category, chains: c.chains,
      tvl_usd: c.tvl_usd, change_7d: c.change_7d, mcap_usd: c.mcap_usd, listed_at: c.listed_at,
      gecko_id: c.gecko_id, symbol: c.symbol, token_status: 'pre-token', age_days: c.age_days,
      implied_value_usd: rounded, implied_raw: s.implied, odds: round4(s.odds),
      if_launches_value_usd: Math.max(1, Math.round(s.ifV)),
      multiple: round4(s.mult), size_factor: round4(Math.pow(10, vbeta[1]! * (c.log_tvl - 8))),
      category_effect: round4(Math.pow(10, catBeta)),
      p25_usd: Math.max(1, Math.round(Math.pow(10, logImp - hw50))),
      p75_usd: Math.max(1, Math.round(Math.pow(10, logImp + hw50))),
      p10_usd: Math.max(1, Math.round(Math.pow(10, logImp - hw80))),
      p90_usd: Math.max(1, Math.round(Math.pow(10, logImp + hw80))),
      rank_low: rr.lo === Infinity ? rank + 1 : rr.lo, rank_high: rr.hi === -Infinity ? rank + 1 : rr.hi,
      verdict: farmVerdict(s.implied, c.tvl_usd),
      net_usd: round4(e.net), net_per_hour_usd: round4(e.perHour),
      deposit_usd: round4(e.deposit), drop_usd: round4(e.drop), tbill_usd: round4(e.tbill),
      model: { multiple: round4(s.mult), odds: round4(s.odds), age_days: c.age_days },
      peers: peersFor(c), farm_steps: farmSteps(c, c.age_days).map(stepText),
    };
  });
  void keptIdx;
  const farmCounts = {
    farm: board.filter((r) => r.verdict === 'Farm').length,
    marginal: board.filter((r) => r.verdict === 'Marginal').length,
    skip: board.filter((r) => r.verdict === 'Skip').length,
  };
  const totals = {
    tvl_usd: board.reduce((s, r) => s + r.tvl_usd, 0),
    implied_usd: board.reduce((s, r) => s + r.implied_value_usd, 0),
  };
  // protocol accounting: every one of the 758 in exactly one group
  const tokenRecorded = all.filter((p) => !isPreToken(p)).length;
  const pricedComp = all.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length;
  const outRows = all.filter((p) => isPreToken(p) && !board.some((r) => r.slug === p.slug));
  let outVersioned = 0, outCex = 0, outBelow = 0, outAbove = 0;
  for (const p of outRows) {
    if (VERSIONED.test(p.name)) outVersioned++;
    else if (p.category === 'CEX') outCex++;
    else if (p.tvl_usd < snapshot.floor_usd) outBelow++;
    else outAbove++;
  }
  const catBetas = vbeta.slice(2);
  const evidence: Evidence = {
    value_terms: valueTerms,
    odds_terms: oddsTerms,
    lambda_sweep: lambdaSweep,
    folds42: folds42.map((f) => round3(f)),
    ranges,
    floor_test: floorTest,
    value_fit: {
      multiple_100m: round4(Math.pow(10, vbeta[0]! + 8 * vbeta[1]!)),
      slope: round4(vbeta[1]!), slope_se: round4(coefSe[1]!), intercept: round4(vbeta[0]!),
      cat_min: round4(Math.pow(10, Math.min(...catBetas))), cat_max: round4(Math.pow(10, Math.max(...catBetas))),
      loo: round3(loo.miss.mean), wf66: round3(wf66.mean), wf47: round3(wf47.mean),
      flat_loo: round3(flatLoo.mean), flat_wf66: round3(flatWf.mean),
    },
    odds_fit: {
      intercept: round3(obeta[0]!), intercept_se: round3(ose[0]!),
      age: round3(obeta[1]!), age_se: round3(ose[1]!),
      size: round3(obeta[2 + nCatOdds]!), size_se: round3(ose[2 + nCatOdds]!),
      growth: round3(obeta[3 + nCatOdds]!), growth_se: round3(ose[3 + nCatOdds]!),
      chains: round3(obeta[4 + nCatOdds]!), chains_se: round3(ose[4 + nCatOdds]!),
      cat_min: round3(Math.min(...oddsCatBetas)), cat_max: round3(Math.max(...oddsCatBetas)),
      base_brier10: round3(baseBrier10), base_brier_wf: round3(baseBrierWf),
    },
    farm_counts: farmCounts,
    totals,
    accounting: {
      ranked: board.length, token_recorded: tokenRecorded, priced_comp: pricedComp,
      token_no_cap: tokenRecorded - pricedComp, out: outRows.length,
      out_versioned: outVersioned, out_cex: outCex, out_below_floor: outBelow, out_above_floor: outAbove,
      ledger: snapshot.protocols.length,
    },
    notes: [
      'lambda 4 is the defensible compromise: within 0.08 of the best LOO, within 0.10 of the best WF66, Farm 13.',
      'Odds keep chains: CAT+chains improves Brier and AUC on both held-out tests, on both 10-fold seeds. CAT+chains+size x growth does not: on seed 11 its 10-fold Brier (0.202) and AUC (0.753) are worse than CAT+chains, so it is tested, not kept.',
      'Ranges are Jackknife+ plus bootstrap sd (200 refits, seed 777): WF coverage 58.6% / 79.3% measured, stated 50% / 80%. The method over-covers LOO on the 50% band (66.7%) — stated as measured, never as nominal.',
      'No odds floor: floors 0.5% / 1% / 2% change Brier and AUC on neither test at 3 decimals. Sub-$1K implied values print as <$1K; the 200-row probe set held exactly one such row and it is one of the two lowest-implied non-Farm rows dropped to reach 198.',
      'Board 198 = watchlist 40 + early 158: the two lowest-implied non-Farm rows of the 200-row ranked set are dropped, never a Farm row.',
    ],
  };
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: `DefiLlama protocols, fetched ${snapshot.as_of}`,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist: snapshot.watchlist,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.length - snapshot.watchlist.length,
    live_size: liveRows(snapshot).length,
    checksum,
    rows: board,
    live: liveRows(snapshot),
    evidence,
  };
  return { board, radar };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
