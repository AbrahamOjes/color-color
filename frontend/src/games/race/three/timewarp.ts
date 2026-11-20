import { isPhotoFinish, type Timeline } from "../timeline";

/**
 * Slow motion at the line, as a pure map from wall-clock seconds to race seconds.
 *
 * The replay runs at 1× until just before the winner reaches the line, at a fraction of real
 * speed through the finish, then 1× again for the run-out. The map is piecewise linear and
 * holds no state, so a frame at wall time `w` shows the same race moment on every device.
 * The speed change is hidden by the director's cut to the photo-finish camera, which happens
 * at exactly `slowFrom`.
 */
export type Warp = {
  /// Race time where slow motion starts and ends.
  slowFrom: number;
  slowTo: number;
  /// Playback speed inside the slow section, 0 < rate < 1.
  rate: number;
  /// Race length, and the wall-clock length of the warped replay.
  raceDuration: number;
  wallDuration: number;
};

/// Slow motion starts this long before the winner crosses, and ends this long after.
const LEAD_IN = 0.7;
const FOLLOW_THROUGH = 0.5;

export function makeWarp(timeline: Timeline): Warp {
  const winnerTime = timeline.finishTime[timeline.order[0]];
  const slowFrom = winnerTime - LEAD_IN;
  const slowTo = Math.min(winnerTime + FOLLOW_THROUGH, timeline.duration);
  const rate = isPhotoFinish(timeline) ? 0.2 : 0.3;
  const wallDuration = timeline.duration + (slowTo - slowFrom) * (1 / rate - 1);
  return { slowFrom, slowTo, rate, raceDuration: timeline.duration, wallDuration };
}

/// Race time shown at wall time `w` seconds after the off. Clamped to the replay.
export function raceTimeAt(warp: Warp, w: number): number {
  if (w <= 0) return 0;
  if (w >= warp.wallDuration) return warp.raceDuration;
  if (w <= warp.slowFrom) return w;
  const slowWall = (warp.slowTo - warp.slowFrom) / warp.rate;
  if (w <= warp.slowFrom + slowWall) return warp.slowFrom + (w - warp.slowFrom) * warp.rate;
  return warp.slowTo + (w - warp.slowFrom - slowWall);
}

/// The inverse: the wall time at which race time `t` is shown.
export function wallTimeAt(warp: Warp, t: number): number {
  if (t <= warp.slowFrom) return t;
  if (t <= warp.slowTo) return warp.slowFrom + (t - warp.slowFrom) / warp.rate;
  return t + (warp.slowTo - warp.slowFrom) * (1 / warp.rate - 1);
}

export function isSlowMotion(warp: Warp, raceT: number): boolean {
  return raceT > warp.slowFrom && raceT < warp.slowTo;
}
