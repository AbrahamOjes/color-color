"use client";

import { usePredictionGame } from "@/hooks/usePredictionGame";
import { COLORCOLOR } from "@/games/registry";
import { useRecentDraws } from "@/games/colorcolor/hooks";
import { Countdown } from "@/components/Countdown";
import { BallRow, BallPlaceholders, Ball } from "@/games/colorcolor/Result";
import { Card, EmptyState } from "@/components/ui";
import { formatUSD } from "@/lib/utils";
import {
  COLOURS,
  DOMINANT_LABELS,
  COLOUR_BG,
  COLOUR_ON_BG,
  COLOUR_TEXT,
} from "@/lib/colours";

const HISTORY_DEPTH = 20;

type Draw = ReturnType<typeof useRecentDraws>[number];

export default function ResultsPage() {
  const { currentDrawId, drawInterval, lastDrawTimestamp, drawPending } = usePredictionGame(COLORCOLOR);
  const draws = useRecentDraws(COLORCOLOR, currentDrawId, HISTORY_DEPTH);

  return (
    <div className="mx-auto max-w-lg px-4 pb-16 pt-6">
      <h1 className="mb-1 text-2xl font-bold text-slate-900">Results</h1>
      <p className="mb-6 text-sm text-slate-400">Every settled draw, straight from the chain.</p>

      {/* Live card */}
      <Card className="mb-8 bg-gradient-to-br from-slate-900 to-slate-700 text-center">
        <p className="text-xs uppercase tracking-wide text-slate-300">
          Live · Draw #{currentDrawId.toString()}
        </p>
        <div className="my-3 flex justify-center [&>div]:text-white">
          <Countdown
            lastDrawTimestamp={lastDrawTimestamp}
            drawInterval={drawInterval}
            drawPending={drawPending}
            size="lg"
          />
        </div>
        <p className="text-sm text-slate-300">
          {drawPending ? "Settling on-chain…" : "until the next draw"}
        </p>
        {drawPending && (
          <div className="mt-5">
            <BallPlaceholders size="md" />
          </div>
        )}
      </Card>

      {draws.length > 0 && <StatsPanel draws={draws} />}

      <h2 className="mb-3 mt-8 text-lg font-bold text-slate-900">Draw history</h2>
      {draws.length === 0 ? (
        <EmptyState
          title="No settled draws yet"
          hint="Results appear here the moment the first draw settles."
        />
      ) : (
        <div className="space-y-3">
          {draws.map((d) => (
            <DrawRow key={d.drawId.toString()} draw={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function DrawRow({ draw }: { draw: Draw }) {
  const isTie = draw.dominantColour >= COLOURS.length;
  const label = DOMINANT_LABELS[draw.dominantColour] ?? "Draw";

  return (
    <Card padded={false} className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-bold text-slate-400">Draw #{draw.drawId.toString()}</span>
        <span
          className={`rounded-full px-3 py-1 text-xs font-bold ${
            isTie
              ? "bg-slate-100 text-slate-600"
              : `${COLOUR_BG[COLOURS[draw.dominantColour]]} ${COLOUR_ON_BG[COLOURS[draw.dominantColour]]}`
          }`}
        >
          {isTie ? "Draw (tie)" : `${label} wins`}
        </span>
      </div>

      <BallRow numbers={draw.numbers} size="md" />

      <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3 text-xs">
        <div className="flex gap-3">
          {COLOURS.map((name, idx) => (
            <span key={name} className={`font-semibold ${COLOUR_TEXT[name]}`}>
              {name[0]}:{draw.colourCount[idx] ?? 0}
            </span>
          ))}
        </div>
        <div className="flex gap-3 font-mono text-slate-400">
          <span>sum {draw.sum}</span>
          {draw.totalPayout > 0n && (
            <span className="text-emerald-600">paid {formatUSD(draw.totalPayout)}</span>
          )}
        </div>
      </div>
    </Card>
  );
}

/// Hot/late numbers and winning-colour frequency, computed from the loaded history.
/// A subgraph would replace this at scale; it is fine at Amoy volumes.
function StatsPanel({ draws }: { draws: Draw[] }) {
  // `draws` is newest-first, so the index of a number's first appearance is how many
  // draws ago it was last seen.
  const freq = new Array(50).fill(0);
  const lastSeenAgo = new Array(50).fill(draws.length);

  draws.forEach((d, ago) => {
    d.numbers.forEach((n) => {
      freq[n]++;
      if (lastSeenAgo[n] === draws.length) lastSeenAgo[n] = ago;
    });
  });

  const nums = Array.from({ length: 49 }, (_, i) => i + 1);
  const hot = [...nums].sort((a, b) => freq[b] - freq[a]).slice(0, 6).map((n) => ({ n, v: freq[n] }));
  const late = [...nums]
    .sort((a, b) => lastSeenAgo[b] - lastSeenAgo[a])
    .slice(0, 6)
    .map((n) => ({ n, v: lastSeenAgo[n] }));

  const counts = COLOURS.map((_, idx) => draws.filter((d) => d.dominantColour === idx).length);
  const ties = draws.filter((d) => d.dominantColour >= COLOURS.length).length;
  const maxColour = Math.max(1, ...counts, ties);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-slate-900">Statistics</h2>

      <Card>
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">Hot numbers</p>
        <div className="flex flex-wrap gap-2">
          {hot.map(({ n, v }) => (
            <span key={n} className="flex items-center gap-1">
              <Ball n={n} size="sm" />
              <span className="text-[10px] font-semibold text-slate-400">×{v}</span>
            </span>
          ))}
        </div>
      </Card>

      <Card>
        <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-400">
          Late numbers (draws since seen)
        </p>
        <div className="flex flex-wrap gap-2">
          {late.map(({ n, v }) => (
            <span key={n} className="flex items-center gap-1">
              <Ball n={n} size="sm" />
              <span className="text-[10px] font-semibold text-slate-400">{v}</span>
            </span>
          ))}
        </div>
      </Card>

      <Card>
        <p className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-400">
          Winning colour frequency
        </p>
        <div className="space-y-2">
          {COLOURS.map((name, idx) => (
            <div key={name} className="flex items-center gap-3">
              <span className={`w-14 text-xs font-semibold ${COLOUR_TEXT[name]}`}>{name}</span>
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full ${COLOUR_BG[name]}`}
                  style={{ width: `${(counts[idx] / maxColour) * 100}%` }}
                />
              </div>
              <span className="w-6 text-right text-xs font-bold text-slate-500">{counts[idx]}</span>
            </div>
          ))}
          {ties > 0 && (
            <div className="flex items-center gap-3">
              <span className="w-14 text-xs font-semibold text-slate-500">Draw</span>
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full bg-slate-400"
                  style={{ width: `${(ties / maxColour) * 100}%` }}
                />
              </div>
              <span className="w-6 text-right text-xs font-bold text-slate-500">{ties}</span>
            </div>
          )}
        </div>
      </Card>

      <p className="px-1 text-[10px] text-slate-300">
        Computed from the last {draws.length} settled draw{draws.length === 1 ? "" : "s"}.
      </p>
    </div>
  );
}
