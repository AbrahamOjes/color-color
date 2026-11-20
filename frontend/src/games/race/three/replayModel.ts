import { type Hex } from "viem";
import { buildTimeline, type Timeline } from "../timeline";
import { shotAt, type CameraShot } from "./director";
import { planLanes, runnerStates, type LanePlan, type RunnerState } from "./runners";
import { isSlowMotion, makeWarp, raceTimeAt, type Warp } from "./timewarp";

/**
 * Everything the 3D replay draws, as one pure function of wall-clock time.
 *
 * `buildReplay` runs once per race; `sceneAt` runs every frame. The renderer passes
 * `performance.now() − start` and draws what comes back; it keeps no state of its own about
 * the race. That is what makes the replay identical at any frame rate.
 */
export type ReplayModel = {
  timeline: Timeline;
  lanes: LanePlan;
  warp: Warp;
};

export type SceneState = {
  /// Race seconds shown at this wall time (slower than wall time during slow motion).
  raceT: number;
  slowMotion: boolean;
  runners: RunnerState[];
  camera: CameraShot;
};

export function buildReplay(order: readonly number[], seed: Hex, durationS = 25): ReplayModel {
  const timeline = buildTimeline(order, seed, { duration: durationS });
  return { timeline, lanes: planLanes(timeline.runners, seed), warp: makeWarp(timeline) };
}

export function sceneAt(model: ReplayModel, wallT: number): SceneState {
  const raceT = raceTimeAt(model.warp, wallT);
  return {
    raceT,
    slowMotion: isSlowMotion(model.warp, raceT),
    runners: runnerStates(model.timeline, model.lanes, raceT),
    camera: shotAt(model.timeline, model.warp, raceT),
  };
}
