"use client";

import { Card } from "@/components/ui";
import { type RaceSkin } from "../skins";
import { MARKET } from "./encode";
import { type RaceOdds } from "./hooks";
import { RunnerToken } from "./RunnerToken";

export type Selection = { market: number; picks: number[] };

const SINGLES = [
  { market: MARKET.WIN, label: "Win", key: "win" },
  { market: MARKET.PLACE, label: "Place", key: "place" },
  { market: MARKET.SHOW, label: "Show", key: "show" },
] as const;

/// The race card: every runner's form weight, win chance and live single prices. Tapping a
/// price selects that bet.
export function RaceCard({
  skin,
  weights,
  odds,
  selection,
  onSelect,
  disabled,
}: {
  skin: RaceSkin;
  weights: number[] | null;
  odds: RaceOdds | null;
  selection: Selection | null;
  onSelect: (selection: Selection) => void;
  disabled: boolean;
}) {
  const total = weights?.reduce((a, b) => a + b, 0) ?? 0;
  const maxWeight = weights ? Math.max(...weights) : 0;

  return (
    <Card padded={false} className="mb-5 overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <p className="text-sm font-bold text-slate-900">Race card</p>
        <div className="grid w-[168px] grid-cols-3 gap-1.5 text-center text-[10px] font-bold uppercase tracking-wider text-slate-400">
          {SINGLES.map(({ label }) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      </div>

      {skin.runners.map((style, i) => {
        const weight = weights?.[i];
        return (
          <div key={i} className="flex items-center gap-3 border-b border-slate-50 px-4 py-2.5 last:border-b-0">
            <RunnerToken index={i} style={style} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-slate-900">{style.name}</p>
              {weight !== undefined && total > 0 ? (
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-slate-700"
                      style={{ width: `${(weight / maxWeight) * 100}%` }}
                    />
                  </div>
                  {/* The model's exact win probability, w / W. Information only: prices come
                      from the contract. */}
                  <span className="text-[11px] text-slate-400">
                    Form {weight} · {((weight / total) * 100).toFixed(1)}% to win
                  </span>
                </div>
              ) : (
                <p className="mt-1 text-[11px] text-slate-300">Loading form…</p>
              )}
            </div>
            <div className="grid w-[168px] shrink-0 grid-cols-3 gap-1.5">
              {SINGLES.map(({ market, key }) => {
                const price = odds?.[key][i];
                const on = selection?.market === market && selection.picks[0] === i;
                return (
                  <button
                    key={market}
                    disabled={disabled || !price}
                    onClick={() => onSelect({ market, picks: [i] })}
                    className={`h-9 rounded-lg text-xs font-bold tabular-nums transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                      on ? "bg-slate-900 text-white shadow-md" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                    }`}
                  >
                    {price ? price.toFixed(2) : "—"}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </Card>
  );
}
