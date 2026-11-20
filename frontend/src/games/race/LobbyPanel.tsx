"use client";

import { type GameInstance } from "../types";
import { decodeSkinId, resolveSkin } from "../skins";
import { useRaceConfig, useRaceResult } from "./hooks";
import { RunnerToken } from "./RunnerToken";
import { ordinal } from "./Replay";

/// A race game's part of its lobby card: the last race's first three.
export function RaceLobbyPanel({ game, currentDrawId }: { game: GameInstance; currentDrawId: bigint }) {
  const { runners, skinId } = useRaceConfig(game);
  const lastRace = currentDrawId > 1n ? currentDrawId - 1n : null;
  const result = useRaceResult(game, lastRace);
  if (!runners || !lastRace) return null;
  const skin = resolveSkin(decodeSkinId(skinId), game.skin, runners);

  return (
    <div className="mt-6 border-t border-slate-100 pt-5">
      <p className="mb-3 text-center text-[11px] font-bold uppercase tracking-widest text-slate-400">
        Last result · Race #{lastRace.toString()}
      </p>
      {result?.settled ? (
        <div className="flex justify-center gap-4">
          {result.order.slice(0, 3).map((r, p) => (
            <div key={r} className="flex flex-col items-center gap-1">
              <RunnerToken index={r} style={skin.runners[r]} size="lg" />
              <span className="text-[11px] font-bold text-slate-400">{ordinal(p + 1)}</span>
              <span className="max-w-24 truncate text-xs text-slate-600">{skin.runners[r].name}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-center text-sm text-slate-400">Running…</p>
      )}
    </div>
  );
}
