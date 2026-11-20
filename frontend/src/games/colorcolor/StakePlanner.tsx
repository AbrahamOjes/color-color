"use client";

import { Card, Pill } from "@/components/ui";
import { martingalePlan } from "@/lib/signals";

/**
 * The staking ladder from the strategy videos: double after a loss, reset on a win, stop after
 * a set number of levels.
 *
 * Committed and worst-case exposure are shown at every step rather than buried. Doubling does
 * not change the odds of any single bet — it changes how much is at stake when the run breaks
 * — so those two figures are the only ones that actually move, and hiding them would make the
 * ladder look safer than it is.
 */
export function StakePlanner({
  baseStake,
  level,
  maxLevels,
  multiplier,
  onLevelChange,
  onUseStake,
}: {
  baseStake: number;
  level: number;
  maxLevels: number;
  multiplier: number;
  onLevelChange: (level: number) => void;
  onUseStake: (stake: number) => void;
}) {
  const plan = martingalePlan(baseStake, level, maxLevels, multiplier);
  const ladder = Array.from({ length: maxLevels }, (_, i) => baseStake * 2 ** i);

  return (
    <Card className="mb-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-slate-900">Staking plan</h2>
        <Pill tone={plan.atLimit ? "danger" : "neutral"}>
          Step {plan.level + 1} of {maxLevels}
        </Pill>
      </div>

      <div className="mb-3 flex gap-1.5">
        {ladder.map((stake, i) => (
          <button
            key={i}
            onClick={() => onLevelChange(i)}
            className={`flex-1 rounded-lg py-2 text-xs font-bold transition-all ${
              i === plan.level
                ? "bg-slate-900 text-white"
                : i < plan.level
                  ? "bg-red-50 text-red-600"
                  : "bg-slate-100 text-slate-400 hover:bg-slate-200"
            }`}
          >
            ${stake.toFixed(2)}
          </button>
        ))}
      </div>

      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-slate-50 p-2">
          <p className="text-sm font-bold tabular-nums text-slate-900">${plan.nextStake.toFixed(2)}</p>
          <p className="text-[10px] text-slate-400">Next stake</p>
        </div>
        <div className="rounded-lg bg-slate-50 p-2">
          <p className="text-sm font-bold tabular-nums text-slate-900">${plan.committed.toFixed(2)}</p>
          <p className="text-[10px] text-slate-400">Already down</p>
        </div>
        <div className="rounded-lg bg-amber-50 p-2">
          <p className="text-sm font-bold tabular-nums text-amber-700">
            ${plan.worstCaseExposure.toFixed(2)}
          </p>
          <p className="text-[10px] text-amber-600">If all fail</p>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => onUseStake(plan.nextStake)}
          className="flex-1 rounded-full bg-slate-900 px-4 py-2.5 text-xs font-bold text-white transition-colors hover:bg-slate-800"
        >
          Use ${plan.nextStake.toFixed(2)}
        </button>
        <button
          onClick={() => onLevelChange(0)}
          className="rounded-full bg-slate-100 px-4 py-2.5 text-xs font-bold text-slate-600 transition-colors hover:bg-slate-200"
        >
          Reset
        </button>
      </div>

      {plan.atLimit && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[11px] font-semibold text-red-700">
          Final step. The plan says take the loss here and start again rather than doubling on.
        </p>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
        Doubling changes how much is staked, not the chance of any bet winning. Across a full
        ladder it roughly triples turnover for the same edge, so the drawdown grows with it.
      </p>
    </Card>
  );
}
