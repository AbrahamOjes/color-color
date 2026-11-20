"use client";

import { useState } from "react";
import { Card, Pill } from "@/components/ui";
import {
  detectSignals,
  recommendMarket,
  SIGNAL_STATS,
  SELECTION_LABELS,
  type HistoricDraw,
  type Signal,
} from "@/lib/signals";
import { COLOURS, COLOUR_BG } from "@/lib/colours";

function dot(id: number) {
  return id < 4 ? COLOUR_BG[COLOURS[id]] : "bg-slate-400";
}

function SignalRow({
  signal,
  onPick,
}: {
  signal: Signal;
  onPick?: (selection: number) => void;
}) {
  const stats = SIGNAL_STATS[signal.kind];
  const [open, setOpen] = useState(false);

  return (
    <div className="px-5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot(signal.selection)}`} />
            <span className="text-sm font-bold text-slate-900">{signal.label}</span>
            {signal.direction === "exit" ? (
              <Pill tone="danger">Exit</Pill>
            ) : (
              <Pill tone={signal.timing === "lagging" ? "success" : "warning"}>
                {signal.timing === "lagging" ? "Lagging entry" : "Leading entry"}
              </Pill>
            )}
          </div>
          <p className="text-xs leading-relaxed text-slate-500">{signal.detail}</p>

          <button
            onClick={() => setOpen((v) => !v)}
            className="mt-1.5 text-[11px] font-semibold text-indigo-600 hover:text-indigo-700"
          >
            {(100 * stats.hitRate).toFixed(2)}% hit rate · fires {stats.fires}
            <span className="ml-1 text-slate-400">{open ? "▲" : "▼"}</span>
          </button>

          {open && (
            <div className="mt-1.5 rounded-lg bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-500">
              Measured over 400,000 draws. This signal backs selections that win{" "}
              <b>{(100 * stats.baseRate).toFixed(2)}%</b> of the time on their own, and win{" "}
              <b>{(100 * stats.hitRate).toFixed(2)}%</b> of the time after the signal — a
              difference of{" "}
              <b>
                {stats.hitRate - stats.baseRate >= 0 ? "+" : ""}
                {(100 * (stats.hitRate - stats.baseRate)).toFixed(2)}
              </b>{" "}
              points. Every draw is independent VRF output, so the two converge.
            </div>
          )}
        </div>

        {onPick && signal.direction === "entry" && (
          <button
            onClick={() => onPick(signal.selection)}
            className="shrink-0 rounded-full bg-slate-900 px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-slate-800"
          >
            Back {SELECTION_LABELS[signal.selection]}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The strategy surface: live indicators plus the elimination-based market call, mirroring the
 * flow players know from fast-draw colour games.
 *
 * Each signal carries its measured hit rate, which is what makes the panel honest as well as
 * compelling: the headline number is real and independently checkable against on-chain draws.
 */
export function SignalsPanel({
  draws,
  onPick,
}: {
  draws: HistoricDraw[];
  onPick?: (selection: number) => void;
}) {
  if (draws.length < 12) {
    return (
      <Card className="mb-5">
        <h2 className="mb-1 text-sm font-bold text-slate-900">Signals</h2>
        <p className="text-xs text-slate-400">
          Needs at least 12 settled draws. {draws.length} so far.
        </p>
      </Card>
    );
  }

  const window = Math.min(100, draws.length);
  const signals = detectSignals(draws, window);
  const market = recommendMarket(draws, window);
  const entries = signals.filter((s) => s.direction === "entry");
  const exits = signals.filter((s) => s.direction === "exit");

  return (
    <Card className="mb-5" padded={false}>
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <h2 className="text-sm font-bold text-slate-900">Signals</h2>
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
          last {window} draws
        </span>
      </div>

      {/* Market call from the elimination rules */}
      <div className="border-b border-slate-100 bg-slate-50 px-5 py-3">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Market
          </span>
          {market.market === "wait" && <Pill>No setup</Pill>}
        </div>
        <p className="text-sm font-bold text-slate-900">{market.headline}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{market.rationale}</p>
        {market.focus.length > 0 && (
          <div className="mt-2 flex gap-1.5">
            {market.focus.map((id) => (
              <button
                key={id}
                onClick={() => onPick?.(id)}
                className={`rounded-full px-3 py-1 text-xs font-bold text-white transition-transform hover:scale-105 ${dot(id)}`}
              >
                {SELECTION_LABELS[id]}
              </button>
            ))}
          </div>
        )}
      </div>

      {exits.length > 0 && (
        <div className="divide-y divide-slate-50 border-b border-slate-100 bg-red-50/40">
          {exits.map((s, i) => (
            <SignalRow key={`exit-${i}`} signal={s} />
          ))}
        </div>
      )}

      <div className="divide-y divide-slate-50">
        {entries.length === 0 ? (
          <p className="px-5 py-4 text-xs text-slate-400">No entry signals right now.</p>
        ) : (
          entries.map((s, i) => <SignalRow key={`entry-${i}`} signal={s} onPick={onPick} />)
        )}
      </div>

      <p className="border-t border-slate-100 px-5 py-2.5 text-[10px] leading-relaxed text-slate-400">
        Indicators are computed from settled on-chain draws. Draws are generated by Chainlink
        VRF and are independent, so signals describe what has happened, not what will.
      </p>
    </Card>
  );
}
