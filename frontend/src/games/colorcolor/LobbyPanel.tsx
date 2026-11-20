"use client";

import { DOMINANT_LABELS, COLOUR_TEXT, COLOURS } from "@/lib/colours";
import { type GameInstance } from "../types";
import { useDrawResult, useRecentDraws } from "./hooks";
import { BallRow, BallPlaceholders } from "./Result";
import { ResultsTicker } from "./ResultsTicker";

/// ColorColor's part of its lobby card: the last result and the recent-draws ticker.
export function ColorColorLobbyPanel({
  game,
  currentDrawId,
  drawPending,
}: {
  game: GameInstance;
  currentDrawId: bigint;
  drawPending: boolean;
}) {
  const lastDrawId = currentDrawId > 1n ? currentDrawId - 1n : null;
  const lastDraw = useDrawResult(game, lastDrawId);
  const recent = useRecentDraws(game, currentDrawId, 12);

  const dominantLabel =
    lastDraw && lastDraw.settled ? DOMINANT_LABELS[lastDraw.dominantColour] : null;
  const dominantClass =
    lastDraw && lastDraw.dominantColour < 4
      ? COLOUR_TEXT[COLOURS[lastDraw.dominantColour]]
      : "text-slate-500";

  return (
    <>
      <div className="mt-6 border-t border-slate-100 pt-5">
        <p className="mb-4 text-center text-[11px] font-bold uppercase tracking-widest text-slate-400">
          {drawPending
            ? "Drawing now"
            : lastDrawId
              ? `Last result · Draw #${lastDrawId.toString()}`
              : "No draws yet"}
        </p>

        {drawPending || !lastDraw?.settled ? (
          <BallPlaceholders size="lg" />
        ) : (
          <>
            <BallRow numbers={lastDraw.numbers} size="lg" reveal />
            <div className="mt-5 flex items-center justify-center gap-6 text-sm">
              <span className="text-slate-400">
                Sum <span className="font-bold text-slate-900">{lastDraw.sum}</span>
              </span>
              <span className="text-slate-400">
                Dominant <span className={`font-bold ${dominantClass}`}>{dominantLabel}</span>
              </span>
            </div>
          </>
        )}
      </div>

      {recent.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-slate-400">
            Recent draws
          </p>
          <ResultsTicker draws={recent} />
        </div>
      )}
    </>
  );
}
