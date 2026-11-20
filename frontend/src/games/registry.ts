import { type Address, getAddress, isAddress } from "viem";
import { type GameDefaults, type GameInstance } from "./types";
import { colorColorDefaults } from "./colorcolor/config";
import { raceDefaults } from "./race/config";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const KNOWN: Record<string, GameDefaults> = {
  colorcolor: colorColorDefaults,
  ...raceDefaults,
};

type RawEntry = { id: string; address: string; kind?: string; title?: string; tagline?: string };

/// `NEXT_PUBLIC_GAMES` accepts either a JSON array (`[{"id":"colorcolor","address":"0x…"}]`)
/// or a comma list (`colorcolor:0x…,greyhounds:0x…`). Order is lobby order.
function parseRaw(raw: string): RawEntry[] {
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? (parsed as RawEntry[]) : [];
    } catch {
      console.warn("NEXT_PUBLIC_GAMES is not valid JSON; ignoring it");
      return [];
    }
  }
  return text
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [id, address] = pair.split(":").map((s) => s.trim());
      return { id, address };
    });
}

function resolve(entry: RawEntry): GameInstance | null {
  const id = entry.id?.toLowerCase();
  const defaults = id ? KNOWN[id] : undefined;
  if (!defaults) {
    console.warn(`NEXT_PUBLIC_GAMES: unknown game id "${entry.id}"; skipped`);
    return null;
  }
  if (!entry.address || !isAddress(entry.address, { strict: false })) {
    console.warn(`NEXT_PUBLIC_GAMES: "${entry.id}" has an invalid address; skipped`);
    return null;
  }
  if (entry.kind && entry.kind !== defaults.kind) {
    console.warn(`NEXT_PUBLIC_GAMES: "${entry.id}" is a ${defaults.kind} game; kind ignored`);
  }
  return {
    ...defaults,
    id,
    // Normalised to the checksummed form: viem rejects a mis-cased address (all caps, say)
    // at call time, which would silently fail every read for that game.
    address: getAddress(entry.address.toLowerCase()),
    title: entry.title ?? defaults.title,
    tagline: entry.tagline ?? defaults.tagline,
  };
}

function load(): GameInstance[] {
  // Referenced literally so Next inlines it at build time.
  const games: GameInstance[] = [];
  for (const entry of parseRaw(process.env.NEXT_PUBLIC_GAMES ?? "")) {
    const game = resolve(entry);
    if (game && !games.some((g) => g.id === game.id)) games.push(game);
  }

  // Migration fallback: with NEXT_PUBLIC_GAMES unset (or yielding nothing), the old
  // single-game variable still configures ColorColor exactly as before.
  if (games.length === 0) {
    const legacy = process.env.NEXT_PUBLIC_COLORCOLOR_ADDRESS;
    games.push({
      ...colorColorDefaults,
      id: "colorcolor",
      address: legacy && isAddress(legacy, { strict: false }) ? getAddress(legacy.toLowerCase()) : ZERO,
    });
  }
  return games;
}

export const GAMES: readonly GameInstance[] = load();

export function getGame(id: string): GameInstance | undefined {
  return GAMES.find((g) => g.id === id);
}

export function playHref(game: GameInstance): string {
  return `/play/${game.id}`;
}

/// The ColorColor instance. `/bets`, `/results` and `/stats` still read only this game.
export const COLORCOLOR: GameInstance =
  GAMES.find((g) => g.kind === "colorcolor") ?? {
    ...colorColorDefaults,
    id: "colorcolor",
    address: ZERO,
  };
