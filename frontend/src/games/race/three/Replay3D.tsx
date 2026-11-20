"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Button, Pill } from "@/components/ui";
import { isPhotoFinish, leadChanges } from "../timeline";
import { ordinal, replayCaption, usePrefersReducedMotion, type ReplayProps } from "../Replay";
import { FpsOverlay, summarise } from "./FpsOverlay";
import { buildReplay } from "./replayModel";
import { ASSET_BASE, FrameStats, Race, Track, type ReplayClock } from "./Scene";
import { detectTier, TIER_SETTINGS } from "./tier";
import { raceTimeAt, wallTimeAt } from "./timewarp";

export type Replay3DProps = ReplayProps & {
  /// "full", "low", or anything else for auto-detect.
  tier?: string | null;
  showFps?: boolean;
};

/// After this long running, a full-tier device averaging under 30 fps drops to reduced detail.
const DOWNGRADE_AFTER_S = 3;
const DOWNGRADE_BELOW_FPS = 30;

/// Asks for one more frame when the loop switches to on-demand (the paused result frame).
function RenderOnce({ when }: { when: unknown }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => invalidate(), [invalidate, when]);
  return null;
}

/// The 3D race replay. Same props and same race as the 2D `Replay`: both draw from
/// timeline.ts, and everything in a frame is `sceneAt(model, wallTime)`.
export default function Replay3D({
  finishingOrder,
  replaySeed,
  skin,
  onFinished,
  onRestart,
  tier: tierOverride,
  showFps = false,
}: Replay3DProps) {
  const reducedMotion = usePrefersReducedMotion();
  const orderKey = finishingOrder.join(",");
  const durationMs = skin.replay.durationMs;
  const model = useMemo(
    () => buildReplay(orderKey.split(",").map(Number), replaySeed, durationMs / 1000),
    [orderKey, replaySeed, durationMs],
  );
  const commentary = useMemo(() => leadChanges(model.timeline), [model]);
  const { timeline, warp } = model;
  const winner = timeline.order[0];
  /// The paused frame after the race: the winner on the line.
  const photoWall = wallTimeAt(warp, timeline.finishTime[winner]);

  const [tierInfo] = useState(() => detectTier(tierOverride));
  const settings = TIER_SETTINGS[tierInfo.tier];
  const [degraded, setDegraded] = useState(false);
  const [stats] = useState(() => new FrameStats());

  // The clock. `start` is set on the first frame drawn after the assets load, so loading time
  // never eats into the race. `fixed` pins the frame once the replay is over.
  const [run, setRun] = useState(0);
  const [skipped, setSkipped] = useState(false);
  const [wall, setWall] = useState(0); // a 4 Hz copy of the clock for the caption
  const startRef = useRef<number | null>(null);
  const fixedRef = useRef<number | null>(null);
  const done = reducedMotion || skipped || wall >= warp.wallDuration;

  const clock = useMemo<ReplayClock>(
    () => ({
      wallTime: () => {
        if (fixedRef.current !== null) return fixedRef.current;
        const now = performance.now();
        if (startRef.current === null) startRef.current = now;
        return (now - startRef.current) / 1000;
      },
      running: () => fixedRef.current === null,
    }),
    [],
  );

  useEffect(() => {
    fixedRef.current = done ? photoWall : null;
  }, [done, photoWall]);

  // A new race or a restart starts the clock again.
  useEffect(() => {
    startRef.current = null;
    stats.reset();
  }, [model, run, stats]);

  useEffect(() => {
    if (done) return;
    const id = setInterval(() => {
      if (startRef.current !== null) setWall((performance.now() - startRef.current) / 1000);
    }, 250);
    return () => clearInterval(id);
  }, [done, run]);

  const finishedRef = useRef(false);
  useEffect(() => {
    if (done && !finishedRef.current) {
      finishedRef.current = true;
      onFinished?.();
    }
  }, [done, onFinished]);

  // Runtime safety net: if an auto-selected tier can't hold 30 fps, render at 1× and drop
  // detail (the full tier's crowd and trees).
  useEffect(() => {
    if (tierInfo.reason === "url" || degraded || done) return;
    const id = setInterval(() => {
      if (wall < DOWNGRADE_AFTER_S) return;
      const { fps, frames } = summarise(stats, 90);
      if (frames >= 60 && fps < DOWNGRADE_BELOW_FPS) setDegraded(true);
    }, 1000);
    return () => clearInterval(id);
  }, [tierInfo, degraded, done, wall, stats]);

  // For scripts/race3d/measure.mjs.
  useEffect(() => {
    (window as unknown as { __race3d?: unknown }).__race3d = {
      stats,
      tier: tierInfo,
      degraded,
      wallDuration: warp.wallDuration,
      done,
    };
  }, [stats, tierInfo, degraded, warp, done]);

  const raceT = done ? timeline.duration : raceTimeAt(warp, wall);
  const caption = replayCaption(timeline, commentary, skin, raceT, done);
  const lowAssets = tierInfo.tier === "low";
  const label = `${tierInfo.tier}${degraded ? " (reduced)" : ""} · ${tierInfo.reason} · ${tierInfo.gpu}`;

  return (
    <div>
      <div className="relative aspect-[16/10] w-full overflow-hidden rounded-xl bg-sky-200">
        <Canvas
          flat
          dpr={[1, degraded ? 1 : settings.maxDpr]}
          gl={{ antialias: settings.antialias, powerPreference: "high-performance" }}
          camera={{ fov: 45, near: 0.5, far: 900, position: [0, 20, 60] }}
          frameloop={done ? "demand" : "always"}
        >
          <color attach="background" args={["#a9cfe8"]} />
          <Suspense fallback={null}>
            <Track url={`${ASSET_BASE}/track${lowAssets ? "-low" : ""}.glb`} detail={!degraded} />
            <Race
              key={run}
              url={`${ASSET_BASE}/greyhound${lowAssets ? "-low" : ""}.glb`}
              model={model}
              skin={skin}
              clock={clock}
              stats={stats}
            />
          </Suspense>
          <RenderOnce when={done} />
        </Canvas>
        {showFps && <FpsOverlay stats={stats} label={label} />}
        {done && isPhotoFinish(timeline) && (
          <div className="absolute right-2 top-2">
            <Pill tone="warning">Photo finish</Pill>
          </div>
        )}
      </div>

      <p className="mt-3 min-h-5 text-center text-sm font-semibold text-slate-700" aria-live="polite">
        {caption}
      </p>

      {done && (
        <ol className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-slate-700 sm:grid-cols-3">
          {timeline.order.map((r, p) => (
            <li key={r}>
              <span className="font-bold">{ordinal(p + 1)}</span> {skin.runners[r].name} ({skin.runnerLabel} {r + 1})
            </li>
          ))}
        </ol>
      )}

      <div className="mt-4 flex justify-center gap-2">
        {!done && (
          <Button size="sm" variant="ghost" onClick={() => setSkipped(true)}>
            Skip to result
          </Button>
        )}
        {done && !reducedMotion && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setWall(0);
              setSkipped(false);
              fixedRef.current = null;
              finishedRef.current = false;
              setRun((r) => r + 1);
              onRestart?.();
            }}
          >
            Watch again
          </Button>
        )}
      </div>
    </div>
  );
}
