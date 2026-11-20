"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import {
  usePredictionGame,
  usePlayerBets,
  useClaim,
  type PlayerBet,
} from "@/hooks/usePredictionGame";
import { GAMES, playHref } from "@/games/registry";
import { type GameInstance } from "@/games/types";
import { type RaceSkin } from "@/games/skins";
import { BET_TYPE, BET_TYPE_LABEL, decodeSelection } from "@/games/colorcolor/encode";
import { MARKET_LABEL } from "@/games/race/encode";
import { useRaceSkin } from "@/games/race/hooks";
import { RaceSelectionView } from "@/games/race/SelectionView";
import { Card, Button, Pill, EmptyState } from "@/components/ui";
import { Ball } from "@/games/colorcolor/Result";
import { formatUSD } from "@/lib/utils";
import { DOMINANT_LABELS, COLOURS, COLOUR_TEXT } from "@/lib/colours";

const HILO_LABELS = ["Lo (≤120)", "Mid (121–159)", "Hi (≥160)"];

/// Render a stored selection the way the player chose it.
function Selection({ game, bet, skin }: { game: GameInstance; bet: PlayerBet; skin: RaceSkin | null }) {
  if (game.kind === "race") {
    return skin ? <RaceSelectionView market={bet.betType} selection={bet.selection} skin={skin} /> : null;
  }
  return <ColorColorSelection bet={bet} />;
}

function ColorColorSelection({ bet }: { bet: PlayerBet }) {
  const values = decodeSelection(bet.betType, bet.selection);

  if (bet.betType === BET_TYPE.COLOR) {
    const idx = values[0];
    const cls = idx < 4 ? COLOUR_TEXT[COLOURS[idx]] : "text-slate-500";
    return <span className={`font-bold ${cls}`}>{DOMINANT_LABELS[idx] ?? "—"}</span>;
  }

  if (bet.betType === BET_TYPE.HILO) {
    return <span className="font-bold text-slate-700">{HILO_LABELS[values[0]] ?? "—"}</span>;
  }

  if (bet.betType === BET_TYPE.RAINBOW) {
    return (
      <span className="flex items-center gap-1.5">
        {COLOURS.map((name, i) => (
          <span key={name} className={`text-xs font-bold ${COLOUR_TEXT[name]}`}>
            {name[0]}
            {values[i]}
          </span>
        ))}
      </span>
    );
  }

  return (
    <span className="flex gap-1">
      {values.map((n, i) => (
        <Ball key={i} n={n} size="sm" />
      ))}
    </span>
  );
}

function BetRow({
  game,
  bet,
  skin,
  onClaimed,
}: {
  game: GameInstance;
  bet: PlayerBet;
  skin: RaceSkin | null;
  onClaimed: () => void;
}) {
  const { claim, isPending, isSuccess, error } = useClaim(game);
  const isRace = game.kind === "race";

  useEffect(() => {
    if (isSuccess) onClaimed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess]);

  const status = !bet.settled
    ? "pending"
    : !bet.isWinner
      ? "lost"
      : bet.claimed
        ? "claimed"
        : "won";

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center gap-2">
            <Pill>{(isRace ? MARKET_LABEL : BET_TYPE_LABEL)[bet.betType]}</Pill>
            <span className="text-xs text-slate-400">
              {isRace ? "Race" : "Draw"} #{bet.drawId.toString()}
            </span>
          </div>
          <Selection game={game} bet={bet} skin={skin} />
        </div>

        <div className="shrink-0 text-right">
          <p className="text-xs text-slate-400">Stake {formatUSD(bet.stake)}</p>
          <p className="text-sm font-bold text-slate-900">
            {status === "lost" ? "—" : formatUSD(bet.payout)}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-slate-100 pt-3">
        {status === "pending" && <Pill tone="warning">{isRace ? "Awaiting race" : "Awaiting draw"}</Pill>}
        {status === "lost" && <Pill>Not a winner</Pill>}
        {status === "claimed" && <Pill tone="success">Claimed</Pill>}
        {status === "won" && <Pill tone="success">Winner</Pill>}

        {status === "won" && (
          <Button size="sm" disabled={isPending} onClick={() => claim(bet.drawId, bet.betIndex)}>
            {isPending ? "Claiming…" : `Claim ${formatUSD(bet.payout)}`}
          </Button>
        )}
      </div>

      {error && (
        <p className="break-words text-xs text-red-500">{error.message.split("\n")[0]}</p>
      )}
    </Card>
  );
}

/// One game's bets. With a single game the page looks exactly as it did before races.
function GameBets({
  game,
  showTitle,
  hideWhenEmpty,
}: {
  game: GameInstance;
  showTitle: boolean;
  hideWhenEmpty: boolean;
}) {
  const { currentDrawId } = usePredictionGame(game);
  const { bets, isLoading, refetch } = usePlayerBets(game, currentDrawId);
  const skin = useRaceSkin(game);

  const unclaimed = bets.filter((b) => b.settled && b.isWinner && !b.claimed);
  const totalUnclaimed = unclaimed.reduce((sum, b) => sum + b.payout, 0n);

  // With several games, only the first shows "No bets yet"; the rest stay out of the way.
  if (hideWhenEmpty && !isLoading && bets.length === 0) return null;

  return (
    <section className={showTitle ? "mb-8" : ""}>
      {showTitle && <h2 className="mb-3 text-lg font-bold text-slate-900">{game.title}</h2>}

      {totalUnclaimed > 0n && (
        <Card className="mb-5 bg-emerald-50 text-center" >
          <p className="text-xs font-bold uppercase tracking-widest text-emerald-700">
            Unclaimed winnings
          </p>
          <p className="my-1 text-3xl font-black text-emerald-700">
            {formatUSD(totalUnclaimed)}
          </p>
          <p className="text-xs text-emerald-600">
            across {unclaimed.length} bet{unclaimed.length === 1 ? "" : "s"}
          </p>
        </Card>
      )}

      {isLoading ? (
        <EmptyState title="Loading your bets…" />
      ) : bets.length === 0 ? (
        <EmptyState
          title="No bets yet"
          hint="Your bets from the last dozen draws will show up here."
        />
      ) : (
        <div className="space-y-3">
          {bets.map((b) => (
            <BetRow
              key={`${b.drawId}-${b.betIndex}`}
              game={game}
              bet={b}
              skin={skin}
              onClaimed={refetch}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export default function BetsPage() {
  const { isConnected } = useAccount();
  const several = GAMES.length > 1;

  return (
    <div className="mx-auto max-w-lg px-4 pb-16 pt-6">
      <h1 className="mb-1 text-2xl font-bold text-slate-900">My bets</h1>
      <p className="mb-6 text-sm text-slate-400">Your recent bets and anything left to claim.</p>

      {!isConnected ? (
        <Card className="flex flex-col items-center gap-3 py-10">
          <p className="text-sm text-slate-400">Connect a wallet to see your bets</p>
          <ConnectButton />
        </Card>
      ) : (
        <>
          {GAMES.map((game, i) => (
            <GameBets key={game.id} game={game} showTitle={several} hideWhenEmpty={i > 0} />
          ))}

          <div className="mt-8 text-center">
            <Link href={several ? "/" : playHref(GAMES[0])}>
              <Button variant="secondary">Place another bet</Button>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
