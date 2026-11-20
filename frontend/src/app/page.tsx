"use client";

import Link from "next/link";
import { usePredictionGame, useRoundActivity } from "@/hooks/usePredictionGame";
import { useHouseVault } from "@/hooks/useHouseVault";
import { Countdown } from "@/components/Countdown";
import { Card, Button } from "@/components/ui";
import { formatUSDCompact } from "@/lib/utils";
import { GAMES, playHref } from "@/games/registry";
import { type GameInstance } from "@/games/types";
import { ColorColorLobbyPanel } from "@/games/colorcolor/LobbyPanel";
import { RaceLobbyPanel } from "@/games/race/LobbyPanel";

const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Pick a game and a bet",
    desc: "Every game has its own markets, all banked by the same house.",
  },
  {
    step: "02",
    title: "See your payout",
    desc: "Fixed odds. You know exactly what you win before you stake a cent.",
  },
  {
    step: "03",
    title: "Draw every few minutes",
    desc: "Results from Chainlink VRF. Provably fair, settled on-chain.",
  },
];

/// One live game in the lobby. Each card is its own component so each game's hooks are
/// called once per card, however many games the registry lists.
function GameCard({ game }: { game: GameInstance }) {
  const { currentDrawId, drawInterval, lastDrawTimestamp, drawPending, bettingClosesAt } =
    usePredictionGame(game);
  const betCount = useRoundActivity(game, currentDrawId);

  return (
    <Card>
      <div className="text-center">
        <div className="mb-3 inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-slate-500">
          <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-red-500 text-red-500 live-dot" />
          Live · Draw #{currentDrawId.toString()}
        </div>

        {game.kind === "colorcolor" ? (
          <h2 className="mb-1 text-3xl font-black tracking-tight text-slate-900 sm:text-4xl">
            Color
            <span className="bg-gradient-to-r from-red-500 via-yellow-400 to-blue-500 bg-clip-text text-transparent">
              Color
            </span>
          </h2>
        ) : (
          <h2 className="mb-1 text-3xl font-black tracking-tight text-slate-900 sm:text-4xl">
            {game.title}
          </h2>
        )}
        <p className="mb-6 text-sm text-slate-500">{game.tagline}</p>

        <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-slate-400">
          {drawPending ? "Settling" : game.kind === "race" ? "Betting closes in" : "Next draw in"}
        </p>
        <div className="mb-3 flex justify-center">
          <Countdown
            lastDrawTimestamp={lastDrawTimestamp}
            drawInterval={drawInterval}
            drawPending={drawPending}
            size="lg"
            target={bettingClosesAt}
          />
        </div>
        <p className="mb-5 text-xs text-slate-400">
          {Number(drawInterval)}s draw cycle
          {betCount !== null && ` · ${betCount} bet${betCount === 1n ? "" : "s"} this round`}
        </p>

        <Link href={playHref(game)}>
          <Button size="lg">{game.kind === "race" ? "Bet on the race" : "Place a bet"}</Button>
        </Link>
      </div>

      {game.kind === "colorcolor" && (
        <ColorColorLobbyPanel
          game={game}
          currentDrawId={currentDrawId}
          drawPending={drawPending}
        />
      )}
      {game.kind === "race" && <RaceLobbyPanel game={game} currentDrawId={currentDrawId} />}
    </Card>
  );
}

export default function LobbyPage() {
  const { totalAssets } = useHouseVault();

  return (
    <div className="mx-auto max-w-2xl px-4 pb-16">
      <section className="pt-10">
        <h1 className="mb-6 text-center text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">
          Live games
        </h1>
        <div className="space-y-6">
          {GAMES.map((game) => (
            <GameCard key={game.id} game={game} />
          ))}
        </div>
      </section>

      {/* Stats */}
      <section className="mt-10 grid grid-cols-2 gap-3">
        <Card className="text-center">
          <p className="text-2xl font-bold text-slate-900">{GAMES.length}</p>
          <p className="mt-1 text-xs text-slate-400">Live game{GAMES.length === 1 ? "" : "s"}</p>
        </Card>
        <Card className="text-center">
          <p className="text-2xl font-bold text-slate-900">{formatUSDCompact(totalAssets)}</p>
          <p className="mt-1 text-xs text-slate-400">House bankroll</p>
        </Card>
      </section>

      {/* How it works */}
      <section className="mt-14">
        <h2 className="mb-6 text-center text-2xl font-bold text-slate-900">How it works</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          {HOW_IT_WORKS.map(({ step, title, desc }) => (
            <Card key={step} className="card-hover">
              <p className="mb-2 text-xs font-bold text-slate-300">{step}</p>
              <h3 className="mb-1.5 font-bold text-slate-900">{title}</h3>
              <p className="text-sm leading-relaxed text-slate-500">{desc}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* Back the house */}
      <section className="mt-10">
        <Card className="bg-slate-900 text-center" >
          <h3 className="mb-1.5 text-lg font-bold text-white">Back the house</h3>
          <p className="mx-auto mb-5 max-w-md text-sm leading-relaxed text-slate-300">
            Every bet is banked by the vault. Deposit USDC to take the other side and earn the
            house edge — you carry the variance in both directions.
          </p>
          <Link href="/vault">
            <Button variant="secondary">Open the vault</Button>
          </Link>
        </Card>
      </section>
    </div>
  );
}
