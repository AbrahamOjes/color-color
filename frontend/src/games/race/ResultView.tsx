"use client";

import { useEffect } from "react";
import { usePlayerBets, useClaim, type PlayerBet } from "@/hooks/usePredictionGame";
import { Card, Button, Pill } from "@/components/ui";
import { formatUSD } from "@/lib/utils";
import { type GameInstance } from "../types";
import { type RaceSkin } from "../skins";
import { MARKET_LABEL } from "./encode";
import { type RaceResult } from "./hooks";
import { RunnerToken } from "./RunnerToken";
import { RaceSelectionView } from "./SelectionView";
import { ordinal } from "./Replay";

/// Bets older than this many races are not looked up here; /bets covers recent history.
const MAX_LOOKBACK = 24;

/// The result board: placings, what the race paid, and the player's bets on it with claim.
export function ResultView({
  game,
  result,
  skin,
  currentDrawId,
}: {
  game: GameInstance;
  result: RaceResult;
  skin: RaceSkin;
  currentDrawId: bigint;
}) {
  const age = currentDrawId - result.drawId;
  const lookback = age >= 0n && age <= BigInt(MAX_LOOKBACK) ? Number(age) : 0;
  const { bets, refetch } = usePlayerBets(game, currentDrawId, lookback);
  const mine = age <= BigInt(MAX_LOOKBACK) ? bets.filter((b) => b.drawId === result.drawId) : [];

  return (
    <>
      <div className="space-y-1.5">
        {result.order.map((r, p) => (
          <div key={r} className="flex items-center gap-3 rounded-lg px-1 py-1">
            <span className="w-8 text-xs font-bold text-slate-400">{ordinal(p + 1)}</span>
            <RunnerToken index={r} style={skin.runners[r]} size="sm" />
            <span className={`text-sm ${p === 0 ? "font-bold text-slate-900" : "text-slate-600"}`}>
              {skin.runners[r].name}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-center text-xs text-slate-400">
        Race paid {formatUSD(result.totalPayout)} to winners
      </p>

      {mine.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
          <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Your bets</p>
          {mine.map((bet) => (
            <BetLine key={bet.betIndex.toString()} game={game} bet={bet} skin={skin} onClaimed={refetch} />
          ))}
        </div>
      )}
    </>
  );
}

function BetLine({
  game,
  bet,
  skin,
  onClaimed,
}: {
  game: GameInstance;
  bet: PlayerBet;
  skin: RaceSkin;
  onClaimed: () => void;
}) {
  const { claim, isPending, isSuccess, error } = useClaim(game);

  useEffect(() => {
    if (isSuccess) onClaimed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess]);

  return (
    <Card padded={false} className="flex items-center justify-between gap-3 p-3">
      <div className="min-w-0">
        <div className="mb-1 flex items-center gap-2">
          <Pill>{MARKET_LABEL[bet.betType]}</Pill>
          <span className="text-xs text-slate-400">Stake {formatUSD(bet.stake)}</span>
        </div>
        <RaceSelectionView market={bet.betType} selection={bet.selection} skin={skin} />
        {error && <p className="mt-1 break-words text-xs text-red-500">{error.message.split("\n")[0]}</p>}
      </div>
      <div className="shrink-0 text-right">
        {!bet.isWinner ? (
          <Pill>Not a winner</Pill>
        ) : bet.claimed ? (
          <Pill tone="success">Claimed {formatUSD(bet.payout)}</Pill>
        ) : (
          <Button size="sm" disabled={isPending} onClick={() => claim(bet.drawId, bet.betIndex)}>
            {isPending ? "Claiming…" : `Claim ${formatUSD(bet.payout)}`}
          </Button>
        )}
      </div>
    </Card>
  );
}
