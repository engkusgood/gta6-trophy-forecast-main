// gta6-trophy-rarity-forecast-01 — Varian A (MAIN @tuan-muda)
//
// Forecast each GTA VI trophy's Exophase earn rate at the case's target.
// Method (per trophy, in logit space):
//   - fit a least-squares line of logit(rate) against ln(1 + hours since
//     2026-11-19T00:00:00Z) over the LAST 24 hours of deduplicated reads only
//     (the true curve saturates; fitting the whole history overshoots),
//   - anchor the median on that line and extrapolate only 70% of the trend
//     movement to the target (damping: a logit-linear curve has no saturation),
//   - spread = random-walk term + fit residual + refresh allowance from the
//     most recent downward jumps (36h) or a wide prior when none were seen,
//     plus a dilution term when the tracked-player count is forecast to more
//     than double by the target.
// Deterministic: no randomness, no wall clock; every time comes from the case.
//
// Run: MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
// (Node 22+, standard library only, no network.)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Hours of history the trend fit may see. */
const WINDOW_HOURS = 24;
/** Share of the fitted trend movement carried to the target. */
const DAMP = 0.7;
/** Random-walk spread, logit units per square-root day. */
const RW_SIGMA = 0.5;
/** Refresh prior (logit) when too few downward jumps were observed. */
const REFRESH_PRIOR = 1.3;
/** Only downward logit jumps steeper than this count as refresh jumps. */
const JUMP_CUT = -0.05;
/** Hours back over which refresh jumps are collected. */
const JUMP_WINDOW_HOURS = 36;
/** Dilution spread switches on above this forecast/last player ratio. */
const DILUTION_RATIO = 2;
/** Reference instant for the log-time axis. */
const EPOCH_MS = Date.parse('2026-11-19T00:00:00Z');
/** The five scored quantile levels, in row order. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

interface Trophy {
  id: number;
}
interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}
interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const sigmoidPct = (z: number): number => 100 / (1 + Math.exp(-z));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
/** Hours from the reference instant to an ISO timestamp. */
const hoursSinceEpoch = (iso: string): number =>
  (Date.parse(iso) - EPOCH_MS) / 3_600_000;
/** Log-time coordinate of a read. */
const timeX = (iso: string): number => Math.log(1 + hoursSinceEpoch(iso));

/** Least-squares line y = a + b*x over the given points. */
function fitLine(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  return { a: my - b * mx, b };
}

/** Standard deviation of the residuals of a line fit (0 when degenerate). */
function residualSd(xs: number[], ys: number[], a: number, b: number): number {
  const n = xs.length;
  if (n <= 2) return 0;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (a + b * xs[i]);
    ss += r * r;
  }
  return Math.sqrt(ss / (n - 2));
}

function medianOf(values: number[]): number {
  const s = [...values].sort((p, q) => p - q);
  const m = s.length;
  return m % 2 === 1 ? s[(m - 1) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
}

/** Two reads carry the same information when the player count and every rate match. */
function sameRead(r1: Read, r2: Read): boolean {
  if (r1.players_tracked !== r2.players_tracked) return false;
  if (r1.rates.length !== r2.rates.length) return false;
  for (let i = 0; i < r1.rates.length; i++) {
    if (r1.rates[i] !== r2.rates[i]) return false;
  }
  return true;
}

function forecastCase(c: Case): { id: number; q: number[] }[] {
  const checkpointMs = Date.parse(c.at);
  const horizonDays = c.horizon_minutes / 1440;
  const rwSpread = RW_SIGMA * Math.sqrt(horizonDays);
  const xTarget = timeX(c.target);

  // 1. Deduplicate: drop reads identical to the one before them.
  const dedup: Read[] = [];
  for (const r of c.history) {
    if (dedup.length === 0 || !sameRead(dedup[dedup.length - 1], r)) dedup.push(r);
  }
  const nDistinct = dedup.length;

  // 2. Window: only deduplicated reads at or after checkpoint - 24h;
  //    fall back to the whole deduplicated history when that leaves < 3.
  const windowStart = checkpointMs - WINDOW_HOURS * 3_600_000;
  let window = dedup.filter((r) => Date.parse(r.at) >= windowStart);
  if (window.length < 3) window = dedup;
  const windowXs = window.map((r) => timeX(r.at));
  const xBar = windowXs.reduce((s, v) => s + v, 0) / Math.max(1, windowXs.length);

  // 5b. Refresh allowance: median size of downward logit jumps between
  // consecutive deduplicated reads inside the last 36 hours; a wide prior
  // when fewer than 3 such jumps were seen (flat history => unseen refresh).
  const jumpStart = checkpointMs - JUMP_WINDOW_HOURS * 3_600_000;
  const drops: number[] = [];
  for (let k = 1; k < dedup.length; k++) {
    if (Date.parse(dedup[k].at) < jumpStart) continue;
    for (let i = 0; i < c.trophies.length; i++) {
      const prev = dedup[k - 1].rates[i];
      const cur = dedup[k].rates[i];
      if (prev === null || cur === null) continue;
      const jump = logit(cur) - logit(prev);
      if (jump < JUMP_CUT) drops.push(-jump);
    }
  }
  const refreshSpread =
    drops.length >= 3 ? medianOf(drops) : REFRESH_PRIOR / (1 + 0.5 * nDistinct);

  // 3b. Dilution guard (variant A only): fit log players-tracked against the
  // same log-time axis over the window; if the forecast player count more
  // than doubles the last one, widen the spread for the dilution risk.
  let dilutionSpread = 0;
  if (window.length >= 2) {
    const logN = window.map((r) => Math.log(Math.max(1, r.players_tracked)));
    const { a, b } = fitLine(windowXs, logN);
    const nTarget = Math.exp(a + b * xTarget);
    const nLast = dedup[dedup.length - 1].players_tracked;
    const ratio = nTarget / Math.max(1, nLast);
    if (ratio > DILUTION_RATIO) dilutionSpread = 0.5 * Math.log(ratio);
  }

  const lastRead = dedup[dedup.length - 1];
  return c.trophies.map((t, i) => {
    // Latest non-null rate for this trophy (fall back through the history).
    let lastRate: number | null = null;
    for (let k = dedup.length - 1; k >= 0; k--) {
      if (dedup[k].rates[i] !== null) {
        lastRate = dedup[k].rates[i];
        break;
      }
    }
    if (lastRate === null) {
      // Trophy never rated: widest honest spread around the floor.
      const s = Math.sqrt(
        rwSpread * rwSpread + refreshSpread * refreshSpread + dilutionSpread * dilutionSpread,
      );
      return { id: t.id, q: Z.map((z) => round4(clampPct(sigmoidPct(logit(0.01) + z * s)))) };
    }

    // 3. Per-trophy least-squares fit of logit(rate) on log-time, window only.
    const xs: number[] = [];
    const ys: number[] = [];
    window.forEach((r, k) => {
      const rate = r.rates[i];
      if (rate !== null) {
        xs.push(windowXs[k]);
        ys.push(logit(rate));
      }
    });

    let medianLogit: number;
    let spread: number;
    if (xs.length < 2) {
      // 6. Flat-history shortcut: hold the last rate, spread from the
      // random walk plus the refresh allowance (the prior is what saves the
      // practice cases, whose histories show no refresh at all).
      medianLogit = logit(lastRate);
      spread = Math.sqrt(rwSpread * rwSpread + refreshSpread * refreshSpread);
    } else {
      const { a, b } = fitLine(xs, ys);
      const residSpread = residualSd(xs, ys, a, b);
      // 4. Damped median: anchor on the line's mean, carry only DAMP of the
      // trend movement from the window's centre to the target.
      medianLogit = a + b * xBar + DAMP * b * (xTarget - xBar);
      spread = Math.sqrt(
        rwSpread * rwSpread +
          residSpread * residSpread +
          refreshSpread * refreshSpread +
          dilutionSpread * dilutionSpread,
      );
    }
    const q = Z.map((z) => round4(clampPct(sigmoidPct(medianLogit + z * spread))));
    return { id: t.id, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const trophies = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
