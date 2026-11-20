"use client";

import { useReadContract, useReadContracts } from "wagmi";
import { type GameInstance } from "../types";
import { BET_TYPE, encodeSelection, type BetType } from "./encode";

/// Exact payout for a prospective bet, priced by the contract itself.
///
/// This must never be recomputed in JS: `quote` is the same code path `claimPrize` pays
/// from, so reading it is the only way the displayed odds cannot drift from the paid odds.
export function useColorColorQuote(
  game: GameInstance,
  betType: BetType | null,
  selection: number[] | null,
  stakeUsdc: number,
) {
  const enabled =
    betType !== null && selection !== null && selection.length > 0 && stakeUsdc > 0;

  const { data } = useReadContract({
    address: game.address,
    abi: game.abi,
    functionName: "quote",
    args: enabled
      ? [BET_TYPE[betType], encodeSelection(betType, selection), BigInt(Math.round(stakeUsdc * 1e6))]
      : undefined,
    query: { enabled },
  });

  if (!data) return null;
  const [payout, multiplierBps] = data as [bigint, bigint];
  return { payout, multiplierBps, multiplier: Number(multiplierBps) / 10_000 };
}

export type DrawResult = {
  numbers: number[];
  colourCount: number[];
  sum: number;
  dominantColour: number;
  totalPayout: bigint;
  settled: boolean;
};

/// One settled draw.
export function useDrawResult(game: GameInstance, drawId: bigint | null) {
  const { data } = useReadContract({
    address: game.address,
    abi: game.abi,
    functionName: "getDrawResult",
    args: drawId !== null && drawId > 0n ? [drawId] : undefined,
    query: { enabled: drawId !== null && drawId > 0n, refetchInterval: 5_000 },
  });

  if (!data) return null;
  const [numbers, colourCount, sum, dominantColour, totalPayout, settled] = data as [
    readonly number[],
    readonly number[],
    number,
    number,
    bigint,
    boolean,
  ];
  return {
    numbers: [...numbers],
    colourCount: [...colourCount],
    sum,
    dominantColour,
    totalPayout,
    settled,
  } satisfies DrawResult;
}

/// A batch of recent draws, newest first. Multicalled in one round-trip.
///
/// A subgraph would replace this at scale, but it is fine at Amoy volumes.
export function useRecentDraws(game: GameInstance, currentDrawId: bigint, count = 10) {
  const ids: bigint[] = [];
  for (let i = 1n; i <= BigInt(count); i++) {
    const id = currentDrawId - i;
    if (id > 0n) ids.push(id);
  }

  const { data } = useReadContracts({
    contracts: ids.map((id) => ({
      address: game.address,
      abi: game.abi,
      functionName: "getDrawResult" as const,
      args: [id],
    })),
    query: { enabled: ids.length > 0, refetchInterval: 10_000 },
  });

  if (!data) return [];

  return ids
    .map((id, i) => {
      const r = data[i];
      if (r?.status !== "success") return null;
      const [numbers, colourCount, sum, dominantColour, totalPayout, settled] = r.result as [
        readonly number[],
        readonly number[],
        number,
        number,
        bigint,
        boolean,
      ];
      if (!settled) return null;
      return {
        drawId: id,
        numbers: [...numbers],
        colourCount: [...colourCount],
        sum,
        dominantColour,
        totalPayout,
        settled,
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);
}
