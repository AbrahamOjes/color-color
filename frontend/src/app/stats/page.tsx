"use client";

import { useState } from "react";
import Link from "next/link";
import { usePredictionGame } from "@/hooks/usePredictionGame";
import { COLORCOLOR, playHref } from "@/games/registry";
import { useRecentDraws } from "@/games/colorcolor/hooks";
import { Card, EmptyState } from "@/components/ui";
import { Ball } from "@/games/colorcolor/Result";
import {
  colourStats,
  numberStats,
  dominanceRanking,
  type Band,
  type HistoricDraw,
} from "@/lib/signals";
import { COLOURS, COLOUR_BG, COLOUR_TEXT } from "@/lib/colours";

const WINDOWS = [10, 25, 50, 100] as const;

const BAND_STYLE: Record<Band, { label: string; tone: string }> = {
  cold: { label: "Cold", tone: "bg-blue-50 text-blue-700" },
  low: { label: "Low", tone: "bg-slate-100 text-slate-600" },
  normal: { label: "Normal", tone: "bg-slate-100 text-slate-500" },
  high: { label: "High", tone: "bg-amber-50 text-amber-700" },
  hot: { label: "Hot", tone: "bg-red-50 text-red-700" },
};

function selectionColourClass(id: number): string {
  return id < 4 ? COLOUR_BG[COLOURS[id]] : "bg-slate-400";
}

export default function StatsPage() {
  const { currentDrawId } = usePredictionGame(COLORCOLOR);
  const [window, setWindow] = useState<number>(100);
  const draws = useRecentDraws(COLORCOLOR, currentDrawId, 100) as HistoricDraw[];

  if (draws.length === 0) {
    return (
      <div className="mx-auto max-w-lg px-4 pb-16 pt-6">
        <h1 className="mb-1 text-2xl font-bold text-slate-900">Statistics</h1>
        <p className="mb-6 text-sm text-slate-400">Frequency, streaks and gaps for every outcome.</p>
        <EmptyState title="No settled draws yet" hint="Statistics appear once draws start settling." />
      </div>
    );
  }

  const effective = Math.min(window, draws.length);
  const colours = colourStats(draws, effective);
  const numbers = numberStats(draws, effective);
  const ranking = dominanceRanking(draws, effective);
  const maxWins = Math.max(1, ...colours.map((c) => c.wins));

  const hottest = [...numbers].sort((a, b) => b.appearances - a.appearances).slice(0, 8);
  const overdue = [...numbers]
    .sort((a, b) => (b.drawsSinceSeen ?? 999) - (a.drawsSinceSeen ?? 999))
    .slice(0, 8);

  return (
    <div className="mx-auto max-w-lg px-4 pb-16 pt-6">
      <h1 className="mb-1 text-2xl font-bold text-slate-900">Statistics</h1>
      <p className="mb-5 text-sm text-slate-400">
        Frequency, streaks and gaps across the last {effective} settled draws.
      </p>

      <div className="mb-5 flex gap-1 rounded-xl bg-slate-100 p-1">
        {WINDOWS.map((w) => (
          <button
            key={w}
            onClick={() => setWindow(w)}
            disabled={w > draws.length}
            className={`flex-1 rounded-lg py-2 text-xs font-bold transition-all disabled:opacity-40 ${
              window === w ? "bg-white text-slate-900 shadow-sm" : "text-slate-400 hover:text-slate-600"
            }`}
          >
            Last {w}
          </button>
        ))}
      </div>

      {/* Winning colour table — the core of a fast-draw statistics tab */}
      <Card className="mb-4" padded={false}>
        <div className="border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-bold text-slate-900">Winning colour</h2>
        </div>
        <div className="divide-y divide-slate-50">
          {colours.map((c) => (
            <div key={c.id} className="px-5 py-3">
              <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`h-3 w-3 rounded-full ${selectionColourClass(c.id)}`} />
                  <span className="text-sm font-bold text-slate-900">{c.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${BAND_STYLE[c.band].tone}`}>
                    {BAND_STYLE[c.band].label}
                  </span>
                </div>
                <span className="text-sm font-bold tabular-nums text-slate-900">
                  {(100 * c.frequency).toFixed(1)}%
                </span>
              </div>

              <div className="mb-2 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full ${selectionColourClass(c.id)}`}
                  style={{ width: `${(c.wins / maxWins) * 100}%` }}
                />
              </div>

              <div className="flex justify-between text-[11px] text-slate-400">
                <span>
                  Won <b className="text-slate-600">{c.wins}</b> / {effective}
                </span>
                <span>
                  Last drawn{" "}
                  <b className="text-slate-600">
                    {c.drawsSinceLastWin === null ? `${effective}+` : c.drawsSinceLastWin}
                  </b>
                </span>
                <span>
                  Streak <b className="text-slate-600">{c.currentStreak}</b> / max {c.maxStreak}
                </span>
              </div>

              {/* Expected range, so a "band" is visibly ordinary variation rather than a portent. */}
              <p className="mt-1 text-[10px] text-slate-300">
                expected {c.expected.toFixed(1)} · {c.sigma >= 0 ? "+" : ""}
                {c.sigma.toFixed(1)}σ from expected
              </p>
            </div>
          ))}
        </div>
      </Card>

      {/* Dominance ranking */}
      <Card className="mb-4">
        <h2 className="mb-3 text-sm font-bold text-slate-900">Dominance</h2>
        <div className="space-y-2">
          {ranking.map((c, i) => (
            <div key={c.id} className="flex items-center gap-3">
              <span className="w-4 text-xs font-bold text-slate-300">{i + 1}</span>
              <span className={`h-2.5 w-2.5 rounded-full ${selectionColourClass(c.id)}`} />
              <span className={`flex-1 text-sm font-semibold ${COLOUR_TEXT[COLOURS[c.id]]}`}>
                {c.label}
              </span>
              <span className="text-sm font-bold tabular-nums text-slate-700">{c.wins}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className="mb-4 grid grid-cols-1 gap-4">
        <Card>
          <h2 className="mb-3 text-sm font-bold text-slate-900">Hot numbers</h2>
          <div className="flex flex-wrap gap-2">
            {hottest.map((s) => (
              <span key={s.n} className="flex items-center gap-1">
                <Ball n={s.n} size="sm" />
                <span className="text-[10px] font-semibold text-slate-400">×{s.appearances}</span>
              </span>
            ))}
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-bold text-slate-900">Overdue numbers</h2>
          <div className="flex flex-wrap gap-2">
            {overdue.map((s) => (
              <span key={s.n} className="flex items-center gap-1">
                <Ball n={s.n} size="sm" />
                <span className="text-[10px] font-semibold text-slate-400">
                  {s.drawsSinceSeen === null ? `${effective}+` : s.drawsSinceSeen}
                </span>
              </span>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-slate-300">
            Draws since last seen. Every number is drawn {(100 * (6 / 49)).toFixed(1)}% of the time
            regardless of how long it has been waiting.
          </p>
        </Card>
      </div>

      {/* Full number grid */}
      <Card padded={false} className="mb-4">
        <div className="border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-bold text-slate-900">All numbers</h2>
        </div>
        <div className="grid grid-cols-7 gap-1.5 p-4">
          {numbers.map((s) => {
            const rate = s.frequency / (6 / 49);
            return (
              <div key={s.n} className="text-center">
                <Ball n={s.n} size="sm" />
                <p
                  className={`mt-0.5 text-[9px] font-bold tabular-nums ${
                    rate > 1.3 ? "text-red-500" : rate < 0.7 ? "text-blue-500" : "text-slate-400"
                  }`}
                >
                  {s.appearances}
                </p>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="text-center">
        <Link href={playHref(COLORCOLOR)} className="text-sm font-semibold text-indigo-600 hover:text-indigo-700">
          Back to the game →
        </Link>
      </div>
    </div>
  );
}
