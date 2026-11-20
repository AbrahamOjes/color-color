"use client";

import { getGame } from "./registry";
import { ColorColorBoard } from "./colorcolor/Board";
import { RaceBoard } from "./race/Board";

/// Picks the board for a game. Looked up on the client because a game's ABI is too large to
/// pass from the server page as a prop.
export function GameBoard({ gameId }: { gameId: string }) {
  const game = getGame(gameId);
  if (!game) return null;
  return game.kind === "colorcolor" ? <ColorColorBoard game={game} /> : <RaceBoard game={game} />;
}
