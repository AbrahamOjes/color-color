import { type Hex } from "viem";

/**
 * The deterministic race timeline: where every runner is at every moment of a replay.
 *
 * The result is final when VRF fulfills; this module only replays it. Inputs are the on-chain
 * `finishingOrder` and `replaySeed`, so every viewer, and every renderer (the 2D placeholder,
 * the Three.js replay, the PixiJS low tier), draws the identical race.
 *
 * Renderer-agnostic: no DOM, no React, no clock. A renderer asks `frameAt(timeline, t)` for
 * any `t` in seconds and draws what comes back, at whatever frame rate it manages.
 *
 * How the order is guaranteed:
 * - Each runner's finish time comes from its finishing position, strictly increasing.
 * - Seeded noise moves only the intermediate checkpoints, never the start or the line, so the
 *   middle of the race can have surges, fades and lead changes.
 * - Distance between checkpoints is a monotone cubic (Fritsch–Carlson), which never
 *   overshoots, so no runner reaches the line before its finish time.
 * - After the line, every runner follows the same run-out curve, so nobody is passed after
 *   finishing.
 *
 * Determinism across devices: the PRNG is integer-only (sfc32), and the curve maths uses only
 * + − × ÷, which IEEE 754 defines exactly. There are no Math.sin, Math.exp or Math.pow calls,
 * whose results may differ between JavaScript engines.
 */

export type TimelineOptions = {
  /// Total replay length in seconds, including the run-out after the last finisher.
  duration?: number;
};

export type Timeline = {
  runners: number;
  /// Runner index per finishing position, as on-chain (0-based).
  order: readonly number[];
  /// Seconds after the off at which each runner (by index) crosses the line.
  finishTime: readonly number[];
  /// When to stop drawing: the last finisher's time plus the run-out.
  duration: number;
  /// Winner's margin over second place, in seconds.
  winningMargin: number;
  /// Per runner: checkpoint times, distances and Hermite tangents.
  curves: readonly Curve[];
};

type Curve = { t: number[]; d: number[]; m: number[] };

export type Frame = {
  /// Distance per runner (by index). 0 at the traps, 1 at the line, slightly above after.
  distance: number[];
  /// Runner indexes, leader first.
  standings: number[];
  /// Runners that have crossed the line, in finishing order.
  finished: number[];
};

/// Checkpoints at these fractions of the distance. The early one shapes the break.
const CHECKPOINTS = [0, 0.04, 0.12, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.96, 1];
/// Distance covered after the line by every runner, and how long it takes.
const RUNOUT_DISTANCE = 0.035;
const RUNOUT_SECONDS = 2;
/// A winning margin below this fraction of the winner's time counts as a photo finish.
const PHOTO_FINISH_FRACTION = 0.0025;

// ── PRNG ─────────────────────────────────────────────────────────────────────────────────

/// sfc32: small, fast, integer-only, and identical on every JavaScript engine.
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/// Seeds sfc32 from all 32 bytes of the replay seed.
export function seededRandom(seed: Hex): () => number {
  const hex = seed.slice(2).padStart(64, "0");
  const words = Array.from({ length: 8 }, (_, i) => parseInt(hex.slice(i * 8, i * 8 + 8), 16) | 0);
  const rand = sfc32(words[0] ^ words[4], words[1] ^ words[5], words[2] ^ words[6], words[3] ^ words[7]);
  for (let i = 0; i < 15; i++) rand(); // warm-up
  return rand;
}

// ── Building ─────────────────────────────────────────────────────────────────────────────

/// Share of a runner's total time spent reaching distance `x` at even pace, with a slower
/// break from the traps: g(0) = 0, g(1) = 1, increasing.
function basePace(x: number): number {
  const rest = 1 - x;
  return x + 0.45 * x * rest * rest;
}

export function buildTimeline(order: readonly number[], seed: Hex, opts: TimelineOptions = {}): Timeline {
  const n = order.length;
  if (n < 2) throw new Error("A race needs at least two runners");
  const seen = new Set(order);
  if (seen.size !== n || order.some((r) => r < 0 || r >= n || !Number.isInteger(r))) {
    throw new Error("finishingOrder must be a permutation of 0..N-1");
  }

  const rand = seededRandom(seed);
  const duration = opts.duration ?? 25;

  // Finish times. The winner crosses at 82% of the replay; gaps are mostly small, with a
  // squared draw so close finishes are common and big margins rare.
  const winnerTime = duration * 0.82;
  const maxSpread = duration - RUNOUT_SECONDS - 0.2 - winnerTime;
  const gaps: number[] = [];
  for (let p = 1; p < n; p++) {
    const u = rand();
    gaps.push(winnerTime * (0.002 + 0.018 * u * u));
  }
  const totalGap = gaps.reduce((a, b) => a + b, 0);
  const scale = totalGap > maxSpread ? maxSpread / totalGap : 1;

  const finishTime: number[] = new Array(n);
  let time = winnerTime;
  finishTime[order[0]] = time;
  for (let p = 1; p < n; p++) {
    time += gaps[p - 1] * scale;
    finishTime[order[p]] = time;
  }

  // Curves, drawn in runner-index order so the PRNG stream is fixed for a given seed.
  const curves: Curve[] = [];
  for (let r = 0; r < n; r++) {
    const total = finishTime[r];
    // Running style: positive leads early and fades, negative comes from behind.
    const style = rand() * 2 - 1;
    // Smooth noise: a bounded random walk.
    let walk = 0;
    const t: number[] = [];
    for (let k = 0; k < CHECKPOINTS.length; k++) {
      const x = CHECKPOINTS[k];
      if (k === 0) {
        t.push(0);
        continue;
      }
      if (k === CHECKPOINTS.length - 1) {
        t.push(total);
        continue;
      }
      walk += (rand() - 0.5) * 0.9;
      if (walk > 1) walk = 1;
      if (walk < -1) walk = -1;
      const bump = 4 * x * (1 - x); // zero at the traps and at the line
      const styleShape = -style * bump * (1 - x); // ahead (less time) early, gives it back late
      const fraction = basePace(x) + 0.03 * bump * walk + 0.035 * styleShape;
      t.push(total * fraction);
    }
    // Strictly increasing, and strictly inside (0, total) — a guard; the amplitudes above keep
    // it from ever binding.
    const minStep = total * 0.01;
    for (let k = 1; k < t.length - 1; k++) {
      if (t[k] < t[k - 1] + minStep) t[k] = t[k - 1] + minStep;
    }
    for (let k = t.length - 2; k >= 1; k--) {
      if (t[k] > t[k + 1] - minStep) t[k] = t[k + 1] - minStep;
    }
    curves.push(withTangents(t, CHECKPOINTS));
  }

  return {
    runners: n,
    order: [...order],
    finishTime,
    duration: finishTime[order[n - 1]] + RUNOUT_SECONDS,
    winningMargin: finishTime[order[1]] - finishTime[order[0]],
    curves,
  };
}

/// Fritsch–Carlson tangents for a monotone cubic through (t[k], d[k]). Starts from a
/// standstill (zero tangent at the traps).
function withTangents(t: number[], d: number[]): Curve {
  const k = t.length;
  const secant: number[] = [];
  for (let i = 0; i < k - 1; i++) secant.push((d[i + 1] - d[i]) / (t[i + 1] - t[i]));
  const m: number[] = new Array(k);
  m[0] = 0;
  for (let i = 1; i < k - 1; i++) {
    // Harmonic mean of positive secants is at most twice the smaller, inside the
    // Fritsch–Carlson monotone region.
    m[i] = 2 / (1 / secant[i - 1] + 1 / secant[i]);
  }
  m[k - 1] = secant[k - 2];
  return { t, d: [...d], m };
}

// ── Sampling ─────────────────────────────────────────────────────────────────────────────

/// Distance of one runner at time `t` seconds after the off.
export function distanceAt(timeline: Timeline, runner: number, t: number): number {
  const { t: times, d, m } = timeline.curves[runner];
  if (t <= 0) return 0;
  const end = times[times.length - 1];
  if (t >= end) {
    // Shared run-out: ease to a stop over RUNOUT_SECONDS.
    const s = Math.min((t - end) / RUNOUT_SECONDS, 1);
    const eased = 1 - (1 - s) * (1 - s);
    return 1 + RUNOUT_DISTANCE * eased;
  }
  let i = 0;
  while (times[i + 1] < t) i++;
  const h = times[i + 1] - times[i];
  const s = (t - times[i]) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  return h00 * d[i] + h10 * h * m[i] + h01 * d[i + 1] + h11 * h * m[i + 1];
}

/// Everything a renderer needs for one frame.
export function frameAt(timeline: Timeline, t: number): Frame {
  const distance = Array.from({ length: timeline.runners }, (_, r) => distanceAt(timeline, r, t));
  const position = new Array<number>(timeline.runners);
  timeline.order.forEach((runner, p) => (position[runner] = p));

  const finished = timeline.order.filter((r) => timeline.finishTime[r] <= t);
  const running = distance
    .map((_, r) => r)
    .filter((r) => timeline.finishTime[r] > t)
    .sort((a, b) => distance[b] - distance[a] || position[a] - position[b]);

  return { distance, standings: [...finished, ...running], finished };
}

/// The order runners cross the line, read back from the curves. Equals `order` by
/// construction; exposed so renderers and tests can check it.
export function finishOrderOf(timeline: Timeline): number[] {
  return Array.from({ length: timeline.runners }, (_, r) => r).sort(
    (a, b) => timeline.finishTime[a] - timeline.finishTime[b],
  );
}

export function isPhotoFinish(timeline: Timeline): boolean {
  return timeline.winningMargin < timeline.finishTime[timeline.order[0]] * PHOTO_FINISH_FRACTION;
}

export type LeadChange = { t: number; leader: number };

/// Every change of leader, sampled at `step` seconds, for commentary and camera cues.
export function leadChanges(timeline: Timeline, step = 0.1): LeadChange[] {
  const changes: LeadChange[] = [];
  let leader = -1;
  const end = timeline.finishTime[timeline.order[0]];
  for (let i = 1; i * step <= end; i++) {
    const now = frameAt(timeline, i * step).standings[0];
    if (now !== leader) {
      changes.push({ t: i * step, leader: now });
      leader = now;
    }
  }
  return changes;
}
