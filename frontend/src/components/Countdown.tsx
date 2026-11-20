"use client";

import { useEffect, useState } from "react";

/// Seconds until the next draw, derived from chain state and ticked locally.
///
/// The chain values only refetch every few seconds, so recomputing the target from
/// `lastDrawTimestamp + drawInterval` on every tick (rather than decrementing a counter)
/// keeps the display honest across refetches and tab sleep.
export function useCountdown(lastDrawTimestamp: bigint, drawInterval: bigint) {
  return useCountdownTo(lastDrawTimestamp + drawInterval);
}

/// Seconds until a unix timestamp, ticked locally.
export function useCountdownTo(target: bigint) {
  const [remaining, setRemaining] = useState<number>(() =>
    Math.max(0, Number(target) - Math.floor(Date.now() / 1000)),
  );

  useEffect(() => {
    const tick = () => setRemaining(Math.max(0, Number(target) - Math.floor(Date.now() / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target]);

  return remaining;
}

export function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/// The live clock. Goes amber while the draw is being settled, red in the final ten seconds.
export function Countdown({
  lastDrawTimestamp,
  drawInterval,
  drawPending,
  size = "md",
  target,
}: {
  lastDrawTimestamp: bigint;
  drawInterval: bigint;
  drawPending: boolean;
  size?: "md" | "lg";
  /// Count to this timestamp instead of `lastDrawTimestamp + drawInterval`, e.g. a race's
  /// `bettingClosesAt`.
  target?: bigint;
}) {
  const remaining = useCountdownTo(target ?? lastDrawTimestamp + drawInterval);

  const textSize = size === "lg" ? "text-5xl sm:text-6xl" : "text-2xl";
  const tone = drawPending
    ? "text-amber-500"
    : remaining <= 10
      ? "text-red-500"
      : "text-slate-900";

  if (drawPending) {
    return (
      <div className={`font-mono font-bold tabular-nums ${textSize} ${tone} animate-pulse`}>
        drawing…
      </div>
    );
  }

  return (
    <div className={`font-mono font-bold tabular-nums ${textSize} ${tone}`}>
      {formatClock(remaining)}
    </div>
  );
}
