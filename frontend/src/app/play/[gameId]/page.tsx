import { notFound } from "next/navigation";
import { GAMES, getGame } from "@/games/registry";
import { GameBoard } from "@/games/GameBoard";

// The registry is fixed at build time (NEXT_PUBLIC_GAMES is inlined), so every board can be
// prerendered and any other id is a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return GAMES.map((game) => ({ gameId: game.id }));
}

export default async function PlayGamePage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  if (!getGame(gameId)) notFound();
  return <GameBoard gameId={gameId} />;
}
