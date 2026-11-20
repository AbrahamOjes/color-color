import { type Hex } from "viem";
import { distanceAt, seededRandom, type Timeline } from "../timeline";
import { poseAtDistance, RACE_METRES } from "./trackPath";

/**
 * Where each runner is drawn: the timeline gives distance, this adds the lane and the gait.
 *
 * Everything is a pure function of race time. Nothing is integrated frame to frame, so a
 * 30 fps phone and a 144 fps desktop draw the same dog in the same place at the same moment.
 */

/// Metres covered per gallop cycle at full stride.
const STRIDE_METRES = 4.2;
/// Lateral position in metres from the inner rail of trap 1, and the gap between traps.
const RAIL_GAP = 0.9;
const TRAP_SPACING = 1.05;
/// The pack tightens towards the rail over the first part of the race.
const RUNNING_SPACING = 0.75;
const SETTLE_BY = 0.12;
/// Lane wobble. Kept below half the running spacing less a dog's width, so two runners in
/// neighbouring lanes never overlap.
const MAX_WOBBLE = 0.17;
/// Speed (m/s) at which the gallop reaches full stride.
const FULL_STRIDE_SPEED = 14;

export type LanePlan = {
  amp: number[];
  freq: number[];
  phase: number[];
  gaitOffset: number[];
};

export type RunnerState = {
  x: number;
  z: number;
  yaw: number;
  /// Gallop cycle position, 0..1.
  gait: number;
  /// Stride amplitude, 0 standing to 1 at full gallop.
  stride: number;
};

/// Seeded lane wobble and gait offsets. Uses timeline.ts's PRNG on the reversed seed, so the
/// stream is independent of the one that shaped the race but still fixed by `replaySeed`.
export function planLanes(runners: number, seed: Hex): LanePlan {
  const reversed = `0x${seed.slice(2).padStart(64, "0").split("").reverse().join("")}` as Hex;
  const rand = seededRandom(reversed);
  const plan: LanePlan = { amp: [], freq: [], phase: [], gaitOffset: [] };
  for (let r = 0; r < runners; r++) {
    plan.amp.push(MAX_WOBBLE * (0.4 + 0.6 * rand()));
    plan.freq.push(1.5 + 2.5 * rand()); // wobble cycles per race
    plan.phase.push(rand());
    plan.gaitOffset.push(rand());
  }
  return plan;
}

function smoothstep(x: number): number {
  const s = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return s * s * (3 - 2 * s);
}

/// A smooth periodic wave in [−1, 1] built from polynomials.
function wave(x: number): number {
  const f = x - Math.floor(x);
  const tent = f < 0.5 ? f * 2 : 2 - 2 * f;
  return 2 * smoothstep(tent) - 1;
}

function frac(x: number): number {
  return x - Math.floor(x);
}

/// Metres outward from the inner rail for runner `r` at race distance `d`.
export function laneOffset(plan: LanePlan, r: number, d: number): number {
  const settle = smoothstep(d / SETTLE_BY);
  const spacing = TRAP_SPACING + (RUNNING_SPACING - TRAP_SPACING) * settle;
  const wobble = plan.amp[r] * wave(d * plan.freq[r] + plan.phase[r]) * settle;
  return RAIL_GAP + spacing * r + wobble;
}

/// Speed in metres per second at race time `t`, by central difference.
function speedAt(timeline: Timeline, r: number, t: number): number {
  const h = 0.05;
  return ((distanceAt(timeline, r, t + h) - distanceAt(timeline, r, t - h)) / (2 * h)) * RACE_METRES;
}

export function runnerState(timeline: Timeline, plan: LanePlan, r: number, t: number): RunnerState {
  const d = distanceAt(timeline, r, t);
  const pose = poseAtDistance(d, laneOffset(plan, r, d));
  const v = speedAt(timeline, r, t);
  const stride = v <= 0 ? 0 : v >= FULL_STRIDE_SPEED ? 1 : v / FULL_STRIDE_SPEED;
  return {
    x: pose.x,
    z: pose.z,
    yaw: pose.yaw,
    gait: frac((d * RACE_METRES) / STRIDE_METRES + plan.gaitOffset[r]),
    stride,
  };
}

export function runnerStates(timeline: Timeline, plan: LanePlan, t: number): RunnerState[] {
  return Array.from({ length: timeline.runners }, (_, r) => runnerState(timeline, plan, r, t));
}
