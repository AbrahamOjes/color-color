"use client";

import { useEffect, useState } from "react";
import { type FrameStats } from "./Scene";

export type FpsSummary = { fps: number; low1: number; frames: number };

/// Average fps and the 1% low over the frames in `stats` (the last ~600).
export function summarise(stats: FrameStats, lastN = 600): FpsSummary {
  const frames = stats.frameMs.slice(-lastN).filter((ms) => ms > 0);
  if (frames.length === 0) return { fps: 0, low1: 0, frames: 0 };
  const total = frames.reduce((a, b) => a + b, 0);
  const sorted = [...frames].sort((a, b) => b - a);
  const worst = sorted.slice(0, Math.max(1, Math.floor(frames.length / 100)));
  const worstAvg = worst.reduce((a, b) => a + b, 0) / worst.length;
  return { fps: (1000 * frames.length) / total, low1: 1000 / worstAvg, frames: frames.length };
}

/// The on-device check for the exit criterion: read it on the target phone.
export function FpsOverlay({ stats, label }: { stats: FrameStats; label: string }) {
  const [text, setText] = useState("…");
  useEffect(() => {
    const id = setInterval(() => {
      const s = summarise(stats);
      setText(
        `${s.fps.toFixed(1)} fps · 1% low ${s.low1.toFixed(1)} · ${stats.calls} calls · ${(stats.triangles / 1000).toFixed(1)}k tris`,
      );
    }, 500);
    return () => clearInterval(id);
  }, [stats]);
  return (
    <div className="pointer-events-none absolute left-2 top-2 max-w-[calc(100%-1rem)] rounded bg-black/65 px-2 py-1 font-mono text-[11px] leading-tight text-white">
      <div>{text}</div>
      <div className="truncate opacity-80">{label}</div>
    </div>
  );
}
