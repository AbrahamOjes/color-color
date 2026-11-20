"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type Hex } from "viem";
import { Button, Pill } from "@/components/ui";
import { type RaceSkin } from "../skins";
import { buildTimeline, frameAt, isPhotoFinish, leadChanges, type LeadChange, type Timeline } from "./timeline";

/// The contract a replay renderer implements. The Three.js and PixiJS versions take the
/// same props and draw from the same `timeline.ts`, so all three show the identical race.
export type ReplayProps = {
  /// Runner index per finishing position, from `getRaceResult`.
  finishingOrder: readonly number[];
  /// `replaySeed(drawId)`.
  replaySeed: Hex;
  skin: RaceSkin;
  /// Called once when the replay ends (or is skipped).
  onFinished?: () => void;
  /// Called when the viewer restarts it, so the page can hide the result again.
  onRestart?: () => void;
};

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

/// The line under the replay: the off, the leader at race time `t`, then the result. Shared
/// by the 2D and 3D replays so both commentate identically.
export function replayCaption(
  timeline: Timeline,
  commentary: readonly LeadChange[],
  skin: RaceSkin,
  t: number,
  done: boolean,
): string {
  const winner = timeline.order[0];
  const label = (r: number) => `${skin.runnerLabel} ${r + 1}`;
  if (done) {
    return isPhotoFinish(timeline)
      ? `Photo finish! ${skin.runners[winner].name} (${label(winner)}) gets up by a whisker`
      : `${skin.runners[winner].name} (${label(winner)}) wins`;
  }
  if (t < 0.8) return "And they're off!";
  const current = [...commentary].reverse().find((c) => c.t <= t);
  const leader = current?.leader ?? frameAt(timeline, t).standings[0];
  return `${skin.runners[leader].name} (${label(leader)}) leads`;
}

/// The 2D placeholder replay: one lane per runner, running left to right.
export function Replay({ finishingOrder, replaySeed, skin, onFinished, onRestart }: ReplayProps) {
  const reducedMotion = usePrefersReducedMotion();
  // Keyed on the order's contents, not the array: callers often pass a fresh array each
  // render, and a new timeline would restart the race.
  const orderKey = finishingOrder.join(",");
  const durationMs = skin.replay.durationMs;
  const timeline = useMemo(
    () => buildTimeline(orderKey.split(",").map(Number), replaySeed, { duration: durationMs / 1000 }),
    [orderKey, replaySeed, durationMs],
  );
  const commentary = useMemo(() => leadChanges(timeline), [timeline]);

  // `elapsed` drives the frame. Reduced motion skips straight to the result.
  const [elapsed, setElapsed] = useState(0);
  const [skipped, setSkipped] = useState(false);
  const [run, setRun] = useState(0); // bump to restart
  const finishedRef = useRef(false);
  const done = reducedMotion || skipped || elapsed >= timeline.duration;

  useEffect(() => {
    if (reducedMotion) return;
    finishedRef.current = false;
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = (now - start) / 1000;
      setElapsed(Math.min(t, timeline.duration));
      if (t < timeline.duration) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [timeline, reducedMotion, run]);

  useEffect(() => {
    if (done && !finishedRef.current) {
      finishedRef.current = true;
      onFinished?.();
    }
  }, [done, onFinished]);

  const t = done ? timeline.duration : elapsed;
  const winner = finishingOrder[0];
  const caption = replayCaption(timeline, commentary, skin, t, done);

  return (
    <div>
      {!done && <TrackView timeline={timeline} t={t} skin={skin} from={0} to={1.04} />}

      <p className="mt-3 min-h-5 text-center text-sm font-semibold text-slate-700" aria-live="polite">
        {caption}
      </p>

      {done && (
        <div className="mt-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Photo finish</p>
            {isPhotoFinish(timeline) && <Pill tone="warning">Close one</Pill>}
          </div>
          <TrackView
            timeline={timeline}
            t={timeline.finishTime[winner]}
            skin={skin}
            from={0.9}
            to={1.01}
            showGaps
          />
        </div>
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
              setElapsed(0);
              setSkipped(false);
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

/// One frame of the race as lanes. `from`/`to` set the visible distance window, so the same
/// view draws the whole race or a zoomed photo-finish strip at the line.
function TrackView({
  timeline,
  t,
  skin,
  from,
  to,
  showGaps = false,
}: {
  timeline: Timeline;
  t: number;
  skin: RaceSkin;
  from: number;
  to: number;
  showGaps?: boolean;
}) {
  const frame = frameAt(timeline, t);
  const ids = `t${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`; // safe inside url(#…)
  // Sized for a phone: about 2.5:1 for six lanes, so tokens stay legible at 360px wide.
  const width = 600;
  const lane = 40;
  const pad = 40;
  const height = timeline.runners * lane;
  const x = (d: number) => pad + ((d - from) / (to - from)) * (width - 2 * pad);
  const lineX = x(1);
  const place = new Map(timeline.order.map((r, p) => [r, p]));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full rounded-xl bg-emerald-800"
      role="img"
      aria-label={`Race at ${t.toFixed(1)} seconds`}
    >
      <defs>
        {skin.runners.map((style, r) => (
          <pattern key={r} id={`${ids}-runner-${r}`} width="10" height="10" patternUnits="userSpaceOnUse">
            <rect width="10" height="10" fill={style.colour} />
            {style.pattern !== "solid" && (
              <rect
                width={style.pattern === "stripes" ? 5 : 10}
                height={style.pattern === "hoops" ? 5 : 10}
                fill={style.accent}
              />
            )}
          </pattern>
        ))}
      </defs>
      {Array.from({ length: timeline.runners }, (_, r) => (
        <g key={r}>
          <rect y={r * lane} width={width} height={lane} fill={r % 2 ? "#065f46" : "#047857"} />
          <line x1={0} x2={width} y1={(r + 1) * lane} y2={(r + 1) * lane} stroke="#ffffff22" />
        </g>
      ))}
      {from <= 0 && <line x1={x(0)} x2={x(0)} y1={0} y2={height} stroke="#ffffff66" strokeWidth={2} />}
      <line x1={lineX} x2={lineX} y1={0} y2={height} stroke="#ffffff" strokeWidth={3} strokeDasharray="6 4" />
      {Array.from({ length: timeline.runners }, (_, r) => {
        const cx = x(frame.distance[r]);
        const cy = r * lane + lane / 2;
        const style = skin.runners[r];
        return (
          <g key={r}>
            <rect x={cx - 36} y={cy - 15} width={36} height={30} rx={8} fill={`url(#${ids}-runner-${r})`} stroke="#00000033" />
            <text
              x={cx - 18}
              y={cy + 6}
              textAnchor="middle"
              fontSize={17}
              fontWeight={900}
              fill={style.text}
              stroke={style.pattern === "solid" ? "none" : style.colour}
              strokeWidth={style.pattern === "solid" ? 0 : 3}
              paintOrder="stroke"
            >
              {r + 1}
            </text>
            {showGaps && (
              <text x={cx - 42} y={cy + 5} textAnchor="end" fontSize={14} fontWeight={700} fill="#ffffff">
                {ordinal((place.get(r) ?? 0) + 1)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function ordinal(n: number): string {
  const suffix = n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th";
  return `${n}${suffix}`;
}
