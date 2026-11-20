"use client";

import Link from "next/link";
import { getColour, COLOUR_BG, DOMINANT_LABELS } from "@/lib/colours";

type TickerDraw = {
  drawId: bigint;
  numbers: number[];
  dominantColour: number;
};

/// A horizontally scrolling strip of recent results.
///
/// Keeps the screen feeling live between draws: even with nothing to bet on, there is
/// always motion and recent history on the page.
export function ResultsTicker({ draws }: { draws: TickerDraw[] }) {
  if (draws.length === 0) return null;

  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-1">
      <div className="flex gap-2">
        {draws.map((d) => (
          <Link
            key={d.drawId.toString()}
            href="/results"
            className="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm transition-colors hover:border-slate-300"
          >
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                #{d.drawId.toString()}
              </span>
              <span className="text-[10px] font-semibold text-slate-500">
                {DOMINANT_LABELS[d.dominantColour] ?? "—"}
              </span>
            </div>
            <div className="flex gap-1">
              {d.numbers.map((n, i) => (
                <span
                  key={i}
                  className={`h-5 w-5 rounded-full ${COLOUR_BG[getColour(n)]} text-[9px] font-bold leading-5 text-white`}
                  style={{ textAlign: "center" }}
                >
                  {n}
                </span>
              ))}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
