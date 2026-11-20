import { hexToString, type Hex } from "viem";
import { type RaceSkin } from "./types";
import { greyhounds } from "./greyhounds";
import { danfo } from "./danfo";

export const SKINS: Record<string, RaceSkin> = {
  [greyhounds.id]: greyhounds,
  [danfo.id]: danfo,
};

const PALETTE = ["#dc2626", "#2563eb", "#16a34a", "#0f172a", "#f97316", "#9333ea", "#0891b2", "#db2777", "#65a30d", "#78716c", "#ca8a04", "#4f46e5"];

/// Used when no known skin matches the deployment: plain numbered runners.
function genericSkin(runners: number): RaceSkin {
  return {
    id: "generic",
    title: "Virtual Race",
    runnerLabel: "Runner",
    runners: Array.from({ length: runners }, (_, i) => ({
      name: `Runner ${i + 1}`,
      colour: PALETTE[i % PALETTE.length],
      accent: PALETTE[i % PALETTE.length],
      text: "#ffffff",
      pattern: "solid" as const,
    })),
    track: { lengthM: 480, surface: "sand" },
    replay: { durationMs: 25_000 },
  };
}

/// SKIN_ID is the skin's id string, left-aligned in a bytes32 (`bytes32(bytes("…"))`).
export function decodeSkinId(skinId: Hex | undefined): string | undefined {
  if (!skinId) return undefined;
  return hexToString(skinId).replace(/\0+$/, "") || undefined;
}

/// The skin for a deployment: the contract's SKIN_ID first, then the registry's fallback.
/// A skin is only used if it has exactly one entry per runner.
export function resolveSkin(onChainId: string | undefined, fallbackId: string | undefined, runners: number): RaceSkin {
  for (const id of [onChainId, fallbackId]) {
    const skin = id ? SKINS[id] : undefined;
    if (!skin) continue;
    if (skin.runners.length === runners) return skin;
    console.warn(`Skin "${id}" has ${skin.runners.length} runners; the contract has ${runners}`);
  }
  return genericSkin(runners);
}

export type { RaceSkin, RunnerStyle } from "./types";
