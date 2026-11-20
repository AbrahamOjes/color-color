"use client";

import { useState } from "react";
import {
  useReadContract,
  useReadContracts,
  useWriteContract,
  useAccount,
  useWaitForTransactionReceipt,
} from "wagmi";
import { type Address } from "viem";
import { CONTRACTS, ABIS, ERC20_ABI } from "@/lib/contracts";

/// The house bankroll. LPs take the other side of every bet: unlike the retired LPVault,
/// share price here moves in both directions — a losing draw dilutes it.
export function useHouseVault() {
  const { address } = useAccount();

  const { data, refetch } = useReadContracts({
    contracts: [
      { address: CONTRACTS.houseVault, abi: ABIS.houseVault, functionName: "totalAssets" },
      { address: CONTRACTS.houseVault, abi: ABIS.houseVault, functionName: "totalShares" },
      { address: CONTRACTS.houseVault, abi: ABIS.houseVault, functionName: "sharePrice" },
      { address: CONTRACTS.houseVault, abi: ABIS.houseVault, functionName: "lockedCollateral" },
      { address: CONTRACTS.houseVault, abi: ABIS.houseVault, functionName: "availableToWithdraw" },
    ],
    query: { refetchInterval: 8_000 },
  });

  const { data: position, refetch: refetchPosition } = useReadContracts({
    contracts: [
      {
        address: CONTRACTS.houseVault,
        abi: ABIS.houseVault,
        functionName: "shares",
        args: [address as Address],
      },
      {
        address: CONTRACTS.houseVault,
        abi: ABIS.houseVault,
        functionName: "assetsOf",
        args: [address as Address],
      },
    ],
    query: { enabled: !!address, refetchInterval: 8_000 },
  });

  // The two multicalls return differently-shaped tuples, so read them through a
  // structurally-typed accessor rather than either specific tuple type.
  type Slot = { status: "success"; result: unknown } | { status: "failure"; error: Error };
  const value = <T,>(src: readonly Slot[] | undefined, i: number, fallback: T): T => {
    const slot = src?.[i];
    return slot?.status === "success" ? (slot.result as T) : fallback;
  };

  return {
    totalAssets: value<bigint>(data, 0, 0n),
    totalShares: value<bigint>(data, 1, 0n),
    sharePrice: value<bigint>(data, 2, 10n ** 18n),
    lockedCollateral: value<bigint>(data, 3, 0n),
    availableToWithdraw: value<bigint>(data, 4, 0n),
    myShares: value<bigint>(position, 0, 0n),
    myAssets: value<bigint>(position, 1, 0n),
    isLoading: !data,
    refetch: () => {
      refetch();
      refetchPosition();
    },
  };
}

/// Deposit (approve-then-deposit) and withdraw.
export function useHouseVaultActions() {
  const { address } = useAccount();
  const [step, setStep] = useState<"idle" | "approving" | "depositing" | "withdrawing" | "done">(
    "idle",
  );

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
    args: address ? [address, CONTRACTS.houseVault] : undefined,
    query: { enabled: !!address },
  });

  const { writeContract: approve, data: approveTx, error: approveError } = useWriteContract();
  const { writeContract: act, data: actTx, error: actError } = useWriteContract();

  const { isSuccess: isApproved } = useWaitForTransactionReceipt({ hash: approveTx });
  const { isSuccess: isConfirmed } = useWaitForTransactionReceipt({ hash: actTx });

  function executeDeposit(amount: bigint) {
    setStep("depositing");
    act({
      address: CONTRACTS.houseVault,
      abi: ABIS.houseVault,
      functionName: "deposit",
      args: [amount],
    });
  }

  function deposit(amount: bigint) {
    if (((allowance as bigint) ?? 0n) < amount) {
      setStep("approving");
      approve({
        address: CONTRACTS.usdc,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [CONTRACTS.houseVault, amount],
      });
    } else {
      executeDeposit(amount);
    }
  }

  function withdraw(shares: bigint) {
    setStep("withdrawing");
    act({
      address: CONTRACTS.houseVault,
      abi: ABIS.houseVault,
      functionName: "withdraw",
      args: [shares],
    });
  }

  return {
    deposit,
    executeDeposit,
    withdraw,
    step,
    setStep,
    isApproved,
    isConfirmed,
    balance: (balance as bigint) ?? 0n,
    refetchAllowance,
    refetchBalance,
    error: approveError || actError,
  };
}
