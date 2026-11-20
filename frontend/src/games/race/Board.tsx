"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { isAddress, type Address } from "viem";
import { usePredictionGame } from "@/hooks/usePredictionGame";
import { formatClock, useCountdownTo } from "@/components/Countdown";
import { Card, Button } from "@/components/ui";
import { type GameInstance } from "../types";
import { decodeSkinId, resolveSkin, type RaceSkin } from "../skins";
import { useRaceCard, useRaceConfig, useRaceOdds, useRaceResult } from "./hooks";
import { RaceCard, type Selection } from "./RaceCard";
import { BetSlip } from "./BetSlip";
import { Replay } from "./Replay";
import { ResultView } from "./ResultView";
import { RunnerToken } from "./RunnerToken";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export function RaceBoard({ game }: { game: GameInstance }) {
  // useSearchParams needs a Suspense boundary in Next 16 for a prerendered page.
  return (
    <Suspense fallback={<div className="py-20 text-center text-slate-400">Loading…</div>}>
      <RaceBoardInner game={game} />
    </Suspense>
  );
}

function RaceBoardInner({ game }: { game: GameInstance }) {
  const searchParams = useSearchParams();
  const refParam = searchParams.get("ref");
  const referrer: Address = refParam && isAddress(refParam) ? (refParam as Address) : ZERO;
  // A shared link to /play/<game>?race=N replays race N.
  const raceParam = searchParams.get("race");
  const sharedRace = raceParam && /^\d+$/.test(raceParam) ? BigInt(raceParam) : null;

  const state = usePredictionGame(game);
  const { runners, skinId } = useRaceConfig(game);
  const skin = runners ? resolveSkin(decodeSkinId(skinId), game.skin, runners) : null;

  if (!skin) {
    return <div className="py-20 text-center text-slate-400">Loading the race card…</div>;
  }
  return <RaceBoardLoaded game={game} skin={skin} state={state} referrer={referrer} sharedRace={sharedRace} />;
}

function RaceBoardLoaded({
  game,
  skin,
  state,
  referrer,
  sharedRace,
}: {
  game: GameInstance;
  skin: RaceSkin;
  state: ReturnType<typeof usePredictionGame>;
  referrer: Address;
  sharedRace: bigint | null;
}) {
  const { currentDrawId, drawPending, bettingClosesAt, betCutoff, maxPayoutPerBet, isLoading } = state;

  const weights = useRaceCard(game, currentDrawId);
  const odds = useRaceOdds(game, currentDrawId, skin.runners.length);
  const [selection, setSelection] = useState<Selection | null>(null);

  // Betting window. With a cutoff, betting closes before the race goes off.
  const untilClose = useCountdownTo(bettingClosesAt);
  const untilOff = useCountdownTo(bettingClosesAt + betCutoff);
  const bettingOpen = !drawPending && (betCutoff === 0n || untilClose > 0);
  const closedReason = drawPending ? "Under starter's orders" : "Betting closed";

  // The race shown in the replay panel: a shared race, else the last one run.
  const lastRace = currentDrawId > 1n ? currentDrawId - 1n : null;
  const shownRace = sharedRace !== null && sharedRace < currentDrawId ? sharedRace : lastRace;
  const result = useRaceResult(game, shownRace);

  // When a race settles while the board is open, play it. Tracked during render (React's
  // "adjust state on prop change" pattern) rather than in an effect.
  const [seenDraw, setSeenDraw] = useState<bigint | null>(null);
  const [replaying, setReplaying] = useState(sharedRace !== null);
  const [replayDone, setReplayDone] = useState(false);
  if (!isLoading && seenDraw !== currentDrawId) {
    if (seenDraw !== null && currentDrawId > seenDraw && sharedRace === null) {
      setReplaying(true);
      setReplayDone(false);
    }
    setSeenDraw(currentDrawId);
  }

  function selectBet(next: Selection | null) {
    if (!bettingOpen && next !== null) return;
    setSelection(next);
  }

  return (
    <div className="mx-auto max-w-lg px-4 pb-16 pt-6">
      {/* Live bar */}
      <Card className="mb-5 flex items-center justify-between">
        <div>
          <p className="text-xs text-slate-400">
            {game.title} · Race #{currentDrawId.toString()}
          </p>
          <Link href="/" className="text-sm font-semibold text-indigo-600 hover:text-indigo-700">
            ← All games
          </Link>
        </div>
        <div className="text-right">
          {drawPending ? (
            <>
              <p className="text-xs text-slate-400">VRF in flight</p>
              <p className="animate-pulse text-lg font-bold text-amber-500">Under starter&apos;s orders</p>
            </>
          ) : bettingOpen ? (
            <>
              <p className="text-xs text-slate-400">Betting closes in</p>
              <p
                className={`font-mono text-2xl font-bold tabular-nums ${
                  betCutoff > 0n && untilClose <= 10 ? "text-red-500" : "text-slate-900"
                }`}
              >
                {formatClock(untilClose)}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-slate-400">Betting closed · off in</p>
              <p className="font-mono text-2xl font-bold tabular-nums text-amber-500">{formatClock(untilOff)}</p>
            </>
          )}
        </div>
      </Card>

      {/* Trap boxes while VRF is in flight */}
      {drawPending && (
        <Card className="mb-5 text-center">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-widest text-slate-400">
            In the {skin.runnerLabel.toLowerCase()}s
          </p>
          <div className="flex justify-center gap-2">
            {skin.runners.map((style, r) => (
              <span key={r} className="ball-pulse" style={{ animationDelay: `${r * 120}ms` }}>
                <RunnerToken index={r} style={style} size="lg" />
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* Last (or shared) race: replay, then result */}
      {shownRace !== null && (
        <Card className="mb-5">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">
              Race #{shownRace.toString()}
              {sharedRace !== null ? " · shared" : " · last race"}
            </p>
            {result?.settled && !replaying && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setReplaying(true);
                  setReplayDone(false);
                }}
              >
                Watch replay
              </Button>
            )}
          </div>

          {!result?.settled ? (
            <p className="py-6 text-center text-sm text-slate-400">
              {result ? "Waiting for the result…" : "Loading…"}
            </p>
          ) : (
            <>
              {replaying && (
                <div className="mb-4">
                  <Replay
                    key={`${shownRace}`}
                    finishingOrder={result.order}
                    replaySeed={result.replaySeed}
                    skin={skin}
                    onFinished={() => setReplayDone(true)}
                    onRestart={() => setReplayDone(false)}
                  />
                </div>
              )}
              {(!replaying || replayDone) && (
                <ResultView game={game} result={result} skin={skin} currentDrawId={currentDrawId} />
              )}
            </>
          )}
        </Card>
      )}

      <RaceCard
        skin={skin}
        weights={weights}
        odds={odds}
        selection={selection}
        onSelect={selectBet}
        disabled={!bettingOpen}
      />

      <BetSlip
        game={game}
        drawId={currentDrawId}
        skin={skin}
        odds={odds}
        selection={selection}
        onSelect={selectBet}
        bettingOpen={bettingOpen}
        closedReason={closedReason}
        maxPayoutPerBet={maxPayoutPerBet}
        referrer={referrer}
      />
    </div>
  );
}
