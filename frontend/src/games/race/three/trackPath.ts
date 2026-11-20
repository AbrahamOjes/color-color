/**
 * The oval: where a race distance puts a runner in the 3D world.
 *
 * Pure and dependency-free, so the asset script (scripts/race3d/build-assets.mjs) imports the
 * same constants and the track geometry always matches the path the runners follow.
 *
 * Layout, seen from above (y up, track in the x–z plane, centre of the oval at the origin):
 *
 *            back straight (runners go −x)
 *        ┌──────────────────────────────┐
 *   bend 2  traps →                       bend 1
 *        └──────────────────────────────┘
 *            home straight (runners go +x), finish line, stand on the +z side
 *
 * `s` is arc length along the inner rail, starting where the home straight leaves bend 2.
 * A race starts on the back straight, rounds bend 2 and finishes on the home straight, which
 * gives the director its five shots in order: traps, side tracking, the bend, head-on down
 * the straight, the line.
 *
 * Lateral offset `o` is metres outward from the inner rail. The finish line is a straight cut
 * across the track at `FINISH_S`, so every lane crosses it at exactly race distance 1: the
 * order runners reach the line is the timeline's order, whatever their lane.
 *
 * Only geometry uses Math.sin and Math.cos. Who wins and when comes from timeline.ts, whose
 * maths is exact across engines; a sub-micron difference in where a dog is drawn on a bend
 * changes nothing.
 */

/// Bend radius at the inner rail, metres.
export const BEND_RADIUS = 32;
/// Length of each straight, metres.
export const STRAIGHT = 110;
const BEND = Math.PI * BEND_RADIUS;
/// One lap along the inner rail.
export const LAP = 2 * STRAIGHT + 2 * BEND;
/// Width from the inner rail to the outer rail.
export const TRACK_WIDTH = 9;
/// Traps: 15 m into the back straight.
export const START_S = STRAIGHT + BEND + 15;
/// Finish line: three quarters of the way down the home straight.
export const FINISH_S = STRAIGHT * 0.75;
/// Race length: traps → bend 2 → home straight → line.
export const RACE_METRES = LAP - START_S + FINISH_S;

/// Where each section of the course starts, in race metres from the traps.
export const SECTION = {
  backStraightEnd: STRAIGHT + BEND + STRAIGHT - START_S,
  bendEnd: LAP - START_S,
  finish: RACE_METRES,
} as const;

/// Direction towards the sun (unnormalised). The track bake and the runner shader both use
/// it, so the dogs are lit from where the baked shadows say the sun is.
export const SUN: readonly [number, number, number] = [-0.45, 0.75, 0.48];

export type Pose = {
  x: number;
  z: number;
  /// Rotation about +y that turns a model facing +x to face the direction of travel.
  yaw: number;
};

/// Pose at arc length `s` (any value; wraps) and lateral offset `o` from the inner rail.
export function poseAtS(s: number, o: number): Pose {
  const u = ((s % LAP) + LAP) % LAP;
  const half = STRAIGHT / 2;
  const r = BEND_RADIUS + o;
  if (u < STRAIGHT) {
    // Home straight, +x, outward is +z.
    return { x: -half + u, z: r, yaw: 0 };
  }
  if (u < STRAIGHT + BEND) {
    // Bend 1, centred on (+half, 0).
    const phi = (u - STRAIGHT) / BEND_RADIUS;
    const sin = Math.sin(phi);
    const cos = Math.cos(phi);
    return { x: half + r * sin, z: r * cos, yaw: phi };
  }
  if (u < 2 * STRAIGHT + BEND) {
    // Back straight, −x, outward is −z.
    return { x: half - (u - STRAIGHT - BEND), z: -r, yaw: Math.PI };
  }
  // Bend 2, centred on (−half, 0).
  const phi = (u - 2 * STRAIGHT - BEND) / BEND_RADIUS;
  return { x: -half - r * Math.sin(phi), z: -r * Math.cos(phi), yaw: Math.PI + phi };
}

/// Pose at race distance `d` (0 at the traps, 1 at the line; the run-out goes past 1).
export function poseAtDistance(d: number, o: number): Pose {
  return poseAtS(START_S + d * RACE_METRES, o);
}
