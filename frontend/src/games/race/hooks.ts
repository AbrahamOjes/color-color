"use client";

import { useReadContract, useReadContracts } from "wagmi";
import { type Hex } from "viem";
import { type GameInstance } from "../types";
import { decodeSkinId, resolveSkin, type RaceSkin } from "../skins";
import { MARKET } from "./encode";

const ONE_USDC = 1_000_000n;

/// Deployment constants: runner count and skin. Read once.
export function useRaceConfig(game: GameInstance) {
  const { address, abi } = game;
  const { data } = useReadContracts({
    contracts: [
      { address, abi, functionName: "RUNNERS" },
      { address, abi, functionName: "SKIN_ID" },
    ],
    query: { staleTime: Infinity, enabled: game.kind === "race" },
  });
  const runners = data?.[0]?.status === "success" ? Number(data[0].result) : null;
  const skinId = data?.[1]?.status === "success" ? (data[1].result as Hex) : undefined;
  return { runners, skinId };
}

/// The skin for a race game, once its runner count is known. Null for other kinds.
export function useRaceSkin(game: GameInstance): RaceSkin | null {
  const { runners, skinId } = useRaceConfig(game);
  return runners ? resolveSkin(decodeSkinId(skinId), game.skin, runners) : null;
}

/// The race card: one form weight per runner. Committed when the previous race settled.
export function useRaceCard(game: GameInstance, drawId: bigint) {
  const { data } = useReadContract({
    address: game.address,
    abi: game.abi,
    functionName: "raceCard",
    args: [drawId],
    query: { enabled: drawId > 0n },
  });
  return data ? (data as readonly number[]).map(Number) : null;
}

export type RaceOdds = {
  /// Multipliers per runner (index), e.g. 3.07 for 3.07×.
  win: number[];
  place: number[];
  show: number[];
  oddEven: [number, number];
  hiLo: [number, number];
};

/// Every single-tap price on the card, read from `quote` in one multicall. Displayed odds
/// are never computed in JS: `quote` is the code path `claimPrize` pays from.
export function useRaceOdds(game: GameInstance, drawId: bigint, runners: number | null) {
  const n = runners ?? 0;
  const calls: { market: number; selection: number }[] = [];
  for (const market of [MARKET.WIN, MARKET.PLACE, MARKET.SHOW]) {
    for (let i = 0; i < n; i++) calls.push({ market, selection: i });
  }
  if (n > 0) {
    calls.push({ market: MARKET.ODD_EVEN, selection: 0 }, { market: MARKET.ODD_EVEN, selection: 1 });
    calls.push({ market: MARKET.HI_LO, selection: 0 }, { market: MARKET.HI_LO, selection: 1 });
  }

  const { data } = useReadContracts({
    contracts: calls.map(({ market, selection }) => ({
      address: game.address,
      abi: game.abi,
      functionName: "quote" as const,
      args: [drawId, market, `0x${selection.toString(16).padStart(64, "0")}`, ONE_USDC],
    })),
    query: { enabled: n > 0 && drawId > 0n, refetchInterval: 15_000 },
  });

  if (!data || n === 0) return null;
  const mult = (i: number) =>
    data[i]?.status === "success" ? Number((data[i].result as [bigint, bigint])[1]) / 10_000 : 0;
  return {
    win: Array.from({ length: n }, (_, i) => mult(i)),
    place: Array.from({ length: n }, (_, i) => mult(n + i)),
    show: Array.from({ length: n }, (_, i) => mult(2 * n + i)),
    oddEven: [mult(3 * n), mult(3 * n + 1)],
    hiLo: [mult(3 * n + 2), mult(3 * n + 3)],
  } satisfies RaceOdds;
}

/// Exact payout for a prospective bet on `drawId`, priced by the contract.
export function useRaceQuote(
  game: GameInstance,
  drawId: bigint,
  market: number | null,
  selection: Hex | null,
  stakeUsdc: number,
) {
  const enabled = market !== null && selection !== null && stakeUsdc > 0 && drawId > 0n;
  const { data } = useReadContract({
    address: game.address,
    abi: game.abi,
    functionName: "quote",
    args: enabled ? [drawId, market, selection, BigInt(Math.round(stakeUsdc * 1e6))] : undefined,
    query: { enabled },
  });
  if (!data) return null;
  const [payout, multiplierBps] = data as [bigint, bigint];
  return { payout, multiplierBps, multiplier: Number(multiplierBps) / 10_000 };
}

export type RaceResult = {
  drawId: bigint;
  /// Runner index per finishing position. Empty until settled.
  order: number[];
  totalPayout: bigint;
  settled: boolean;
  replaySeed: Hex;
};

/// A race's finishing order and replay seed. Polls until it settles.
export function useRaceResult(game: GameInstance, drawId: bigint | null) {
  const enabled = drawId !== null && drawId > 0n;
  const { data } = useReadContracts({
    contracts: enabled
      ? [
          { address: game.address, abi: game.abi, functionName: "getRaceResult", args: [drawId] },
          { address: game.address, abi: game.abi, functionName: "replaySeed", args: [drawId] },
        ]
      : [],
    query: { enabled, refetchInterval: 5_000 },
  });
  if (!enabled || !data || data[0]?.status !== "success" || data[1]?.status !== "success") return null;
  const [order, totalPayout, settled] = data[0].result as [readonly number[], bigint, boolean];
  return {
    drawId,
    order: order.map(Number),
    totalPayout,
    settled,
    replaySeed: data[1].result as Hex,
  } satisfies RaceResult;
}
