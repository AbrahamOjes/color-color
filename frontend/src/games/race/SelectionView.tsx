import { type Hex } from "viem";
import { type RaceSkin } from "../skins";
import { MARKET, decodeRaceSelection, hiLoLabel, oddEvenLabel } from "./encode";
import { RunnerToken } from "./RunnerToken";

/// A stored race bet, drawn the way the player picked it.
export function RaceSelectionView({ market, selection, skin }: { market: number; selection: Hex; skin: RaceSkin }) {
  const values = decodeRaceSelection(market, selection);

  if (market === MARKET.ODD_EVEN) return <span className="font-bold text-slate-700">{oddEvenLabel(values[0])}</span>;
  if (market === MARKET.HI_LO) {
    return <span className="font-bold text-slate-700">{hiLoLabel(values[0], skin.runners.length)}</span>;
  }

  const joiner = market === MARKET.REVERSE_FORECAST ? "&" : "→";
  return (
    <span className="flex items-center gap-1.5">
      {values.map((r, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-xs font-bold text-slate-400">{joiner}</span>}
          {skin.runners[r] ? <RunnerToken index={r} style={skin.runners[r]} size="sm" /> : `#${r + 1}`}
        </span>
      ))}
      {values.length === 1 && skin.runners[values[0]] && (
        <span className="text-sm font-semibold text-slate-700">{skin.runners[values[0]].name}</span>
      )}
    </span>
  );
}
