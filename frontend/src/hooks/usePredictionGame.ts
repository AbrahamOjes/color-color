"use client";

import { useState } from "react";
import {
  useReadContract,
  useReadContracts,
  useWriteContract,
  useAccount,
  useWaitForTransactionReceipt,
} from "wagmi";
import { type Address, type Hex } from "viem";
import { CONTRACTS, ERC20_ABI } from "@/lib/contracts";
import { type GameInstance } from "@/games/types";

// Game-agnostic hooks: everything here reads only PredictionGameBase views, so it works for
// every game in the registry. Selection encoding, result decoding and `quote` (VirtualRace's
// takes a drawId, ColorColor's does not) live with each game.

/// Live draw state.
export function usePredictionGame(game: GameInstance) {
  const { address, abi } = game;
  const { data, refetch } = useReadContracts({
    contracts: [
      { address, abi, functionName: "currentDrawId" },
      { address, abi, functionName: "drawInterval" },
      { address, abi, functionName: "lastDrawTimestamp" },
      { address, abi, functionName: "drawPending" },
      { address, abi, functionName: "houseEdgeBps" },
      { address, abi, functionName: "maxPayoutPerBet" },
      // Not on the original mainnet ColorColor; the fallbacks below cover it.
      { address, abi, functionName: "betCutoff" },
      { address, abi, functionName: "bettingClosesAt" },
    ],
    query: { refetchInterval: 4_000 },
  });

  const value = <T,>(i: number, fallback: T): T =>
    (data?.[i]?.status === "success" ? (data[i].result as T) : fallback);

  const drawInterval = value<bigint>(1, 180n);
  const lastDrawTimestamp = value<bigint>(2, 0n);

  return {
    currentDrawId: value<bigint>(0, 1n),
    drawInterval,
    lastDrawTimestamp,
    drawPending: value<boolean>(3, false),
    houseEdgeBps: value<bigint>(4, 800n),
    maxPayoutPerBet: value<bigint>(5, 0n),
    betCutoff: value<bigint>(6, 0n),
    /// When betting on the open draw closes. With no cutoff it is the draw time.
    bettingClosesAt: value<bigint>(7, lastDrawTimestamp + drawInterval),
    isLoading: !data,
    refetch,
  };
}

/// Number of bets in a draw, for the lobby's pool activity. Null until it loads, or if the
/// deployment predates `getBetCount`.
export function useRoundActivity(game: GameInstance, drawId: bigint) {
  const { data } = useReadContract({
    address: game.address,
    abi: game.abi,
    functionName: "getBetCount",
    args: [drawId],
    query: { refetchInterval: 4_000 },
  });
  return data === undefined ? null : (data as bigint);
}

/// Approve-then-bet flow.
export function usePlaceBet(game: GameInstance) {
  const { address } = useAccount();
  const [step, setStep] = useState<"idle" | "approving" | "betting" | "done">("idle");

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: CONTRACTS.usdc,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 10_000 },
  });

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: CONTRACTS.usdc,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: address ? [address, game.address] : undefined,
    query: { enabled: !!address },
  });

  const { writeContract: approve, data: approveTx, error: approveError } = useWriteContract();
  const { writeContract: placeBet, data: betTx, error: betError } = useWriteContract();

  const { isSuccess: isApproved } = useWaitForTransactionReceipt({ hash: approveTx });
  const { isSuccess: isBetPlaced } = useWaitForTransactionReceipt({ hash: betTx });

  function executeBet(betType: number, selection: Hex, stake: bigint, referrer: Address) {
    setStep("betting");
    placeBet({
      address: game.address,
      abi: game.abi,
      functionName: "placeBet",
      args: [betType, selection, stake, referrer],
    });
  }

  function submitBet(betType: number, selection: Hex, stakeUsdc: number, referrer: Address) {
    const stake = BigInt(Math.round(stakeUsdc * 1e6));
    if (((allowance as bigint) ?? 0n) < stake) {
      setStep("approving");
      approve({
        address: CONTRACTS.usdc,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [game.address, stake],
      });
    } else {
      executeBet(betType, selection, stake, referrer);
    }
  }

  return {
    submitBet,
    executeBet,
    step,
    setStep,
    isApproved,
    isBetPlaced,
    balance: (balance as bigint) ?? 0n,
    allowance: (allowance as bigint) ?? 0n,
    refetchAllowance,
    refetchBalance,
    error: approveError || betError,
  };
}

export type PlayerBet = {
  drawId: bigint;
  betIndex: bigint;
  betType: number;
  stake: bigint;
  selection: `0x${string}`;
  claimed: boolean;
  payout: bigint;
  isWinner: boolean;
  settled: boolean;
};

/// Every bet the connected wallet has placed across the last `lookback` draws, with
/// win/claim status resolved. This is what makes claiming possible without an indexer.
export function usePlayerBets(game: GameInstance, currentDrawId: bigint, lookback = 12) {
  const { address } = useAccount();

  const drawIds: bigint[] = [];
  for (let i = 0n; i <= BigInt(lookback); i++) {
    const id = currentDrawId - i;
    if (id > 0n) drawIds.push(id);
  }

  // Pass 1: which bet indices belong to this player in each draw.
  const { data: indexData, refetch: refetchIndices } = useReadContracts({
    contracts: drawIds.map((id) => ({
      address: game.address,
      abi: game.abi,
      functionName: "getPlayerBets" as const,
      args: [id, address as Address],
    })),
    query: { enabled: !!address && drawIds.length > 0, refetchInterval: 10_000 },
  });

  const refs: { drawId: bigint; betIndex: bigint }[] = [];
  if (indexData) {
    drawIds.forEach((id, i) => {
      const r = indexData[i];
      if (r?.status === "success") {
        for (const betIndex of r.result as readonly bigint[]) {
          refs.push({ drawId: id, betIndex });
        }
      }
    });
  }

  // Pass 2: the bets themselves, plus whether each won.
  const { data: betData, refetch: refetchBets } = useReadContracts({
    contracts: refs.flatMap(({ drawId, betIndex }) => [
      {
        address: game.address,
        abi: game.abi,
        functionName: "getBet" as const,
        args: [drawId, betIndex],
      },
      {
        address: game.address,
        abi: game.abi,
        functionName: "isBetWinner" as const,
        args: [drawId, betIndex],
      },
      {
        address: game.address,
        abi: game.abi,
        functionName: "draws" as const,
        args: [drawId],
      },
    ]),
    query: { enabled: refs.length > 0, refetchInterval: 10_000 },
  });

  const bets: PlayerBet[] = [];
  if (betData) {
    refs.forEach(({ drawId, betIndex }, i) => {
      const bet = betData[i * 3];
      const winner = betData[i * 3 + 1];
      const draw = betData[i * 3 + 2];
      if (bet?.status !== "success") return;

      const [, betType, stake, selection, claimed, payout] = bet.result as [
        Address,
        number,
        bigint,
        `0x${string}`,
        boolean,
        bigint,
      ];

      // `draws` is the public mapping getter: (outcome, timestamp, totalPayout,
      // settled). `outcome` is the packed result; each game's result view decodes it.
      let settled = false;
      if (draw?.status === "success") {
        const tuple = draw.result as readonly unknown[];
        settled = Boolean(tuple[tuple.length - 1]);
      }

      bets.push({
        drawId,
        betIndex,
        betType,
        stake,
        selection,
        claimed,
        payout,
        isWinner: winner?.status === "success" ? (winner.result as boolean) : false,
        settled,
      });
    });
  }

  bets.sort((a, b) => (b.drawId === a.drawId ? Number(b.betIndex - a.betIndex) : Number(b.drawId - a.drawId)));

  return {
    bets,
    isLoading: !!address && !indexData,
    refetch: () => {
      refetchIndices();
      refetchBets();
    },
  };
}

/// Claim a winning bet.
export function useClaim(game: GameInstance) {
  const { writeContract, data: hash, error, isPending } = useWriteContract();
  const { isSuccess, isLoading } = useWaitForTransactionReceipt({ hash });

  function claim(drawId: bigint, betIndex: bigint) {
    writeContract({
      address: game.address,
      abi: game.abi,
      functionName: "claimPrize",
      args: [drawId, betIndex],
    });
  }

  return { claim, isPending: isPending || isLoading, isSuccess, error, hash };
}
