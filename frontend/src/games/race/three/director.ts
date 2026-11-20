import { distanceAt, type Timeline } from "../timeline";
import { poseAtDistance, RACE_METRES, SECTION, STRAIGHT, TRACK_WIDTH } from "./trackPath";
import { type Warp } from "./timewarp";

/**
 * The camera director: five scripted shots, chosen and framed from race time alone.
 *
 * Shots 1–4 cut on the leader's distance, which only grows, so they always run in order.
 * Shot 5 cuts in at the start of slow motion. Inside a shot the camera follows the pack's
 * focus point, which is itself a pure function of time, so there is no smoothing state and
 * every device frames every moment identically.
 */

export const SHOTS = ["start", "side", "bend", "headon", "photo"] as const;
export type ShotName = (typeof SHOTS)[number];

export type CameraShot = {
  shot: ShotName;
  position: [number, number, number];
  target: [number, number, number];
  /// Vertical field of view in degrees.
  fov: number;
};

/// Leader distance (metres) at which each tracking shot takes over.
const CUT_TO_SIDE = 18;
const CUT_TO_BEND = SECTION.backStraightEnd - 7;
const CUT_TO_HEADON = SECTION.bendEnd;
/// How far ahead of the pack's focus point the head-on camera runs, metres.
const HEADON_LEAD = 30;
/// The middle of the running lanes, metres from the inner rail.
const MID_LANE = 4;

const metres = (m: number) => m / RACE_METRES;

function at(d: number, o: number, y: number): [number, number, number] {
  const p = poseAtDistance(d, o);
  return [p.x, y, p.z];
}

/// Where the camera looks: weighted towards the leader so the front of the race stays in shot.
function focusDistance(timeline: Timeline, t: number): { lead: number; focus: number } {
  let lead = 0;
  let sum = 0;
  for (let r = 0; r < timeline.runners; r++) {
    const d = distanceAt(timeline, r, t);
    if (d > lead) lead = d;
    sum += d;
  }
  return { lead, focus: 0.6 * lead + 0.4 * (sum / timeline.runners) };
}

export function shotAt(timeline: Timeline, warp: Warp, t: number): CameraShot {
  const { lead, focus } = focusDistance(timeline, t);

  if (t >= warp.slowFrom) {
    // 5. Photo finish: side-on from a raised position outside the outer rail, looking down
    // over it with a long lens. Dollies with the leader in slow motion, then locks off on the
    // line once the leader reaches it.
    const d = Math.min(lead, 1);
    return {
      shot: "photo",
      position: at(d, TRACK_WIDTH + 3.5, 4),
      target: at(d, MID_LANE, 0.4),
      fov: 24,
    };
  }

  const leadM = lead * RACE_METRES;
  if (leadM < CUT_TO_SIDE) {
    // 1. Start: from the infield just ahead of the traps, looking back as they break. Cuts
    // away before the leader reaches the camera.
    return {
      shot: "start",
      position: at(metres(24), -6, 2.5),
      target: at(metres(2), MID_LANE, 0.6),
      fov: 26,
    };
  }
  if (leadM < CUT_TO_BEND) {
    // 2. Side tracking: alongside the pack from the infield, slightly ahead of it.
    return {
      shot: "side",
      position: at(focus + metres(5), -12, 3),
      target: at(focus, MID_LANE, 0.6),
      fov: 38,
    };
  }
  if (leadM < CUT_TO_HEADON) {
    // 3. High angle over the bend, from a fixed rig above the infield.
    return {
      shot: "bend",
      position: [-STRAIGHT / 2 + 12, 34, 0],
      target: at(focus, MID_LANE, 0.5),
      fov: 20,
    };
  }
  // 4. Head-on down the home straight, telephoto, tracking backwards a fixed distance ahead
  // of the pack so the runners stay large in frame and never reach it.
  return {
    shot: "headon",
    position: at(focus + metres(HEADON_LEAD), MID_LANE, 2.2),
    target: at(focus, MID_LANE, 0.6),
    fov: 24,
  };
}
