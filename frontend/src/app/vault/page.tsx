"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useHouseVault, useHouseVaultActions } from "@/hooks/useHouseVault";
import { Card, Button, Pill } from "@/components/ui";
import { formatUSD, formatUSDC, parseUSDC } from "@/lib/utils";

export default function VaultPage() {
  const { isConnected } = useAccount();
  const {
    totalAssets,
    sharePrice,
    lockedCollateral,
    availableToWithdraw,
    myShares,
    myAssets,
    refetch,
  } = useHouseVault();
  const {
    deposit,
    executeDeposit,
    withdraw,
    step,
    setStep,
    isApproved,
    isConfirmed,
    balance,
    error,
  } = useHouseVaultActions();

  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawShares, setWithdrawShares] = useState("");

  // Chain approve → deposit off the receipt, not a timer.
  useEffect(() => {
    if (isApproved && step === "approving" && depositAmount) {
      executeDeposit(parseUSDC(depositAmount));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isApproved, step]);

  useEffect(() => {
    if (isConfirmed) {
      setStep("done");
      setDepositAmount("");
      setWithdrawShares("");
      refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfirmed]);

  // Share price is scaled by 1e18 and starts at exactly 1.0.
  const price = Number(sharePrice) / 1e18;
  const pnlPct = (price - 1) * 100;
  const busy = step === "approving" || step === "depositing" || step === "withdrawing";

  return (
    <div className="mx-auto max-w-lg px-4 pb-16 pt-6">
      <h1 className="mb-1 text-2xl font-bold text-slate-900">House vault</h1>
      <p className="mb-6 text-sm leading-relaxed text-slate-400">
        Deposit USDC to bank the game. You take the other side of every bet and earn the house
        edge over time — and you carry the losses when players win.
      </p>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <Card className="text-center">
          <p className="text-2xl font-bold text-slate-900">{formatUSD(totalAssets)}</p>
          <p className="mt-1 text-xs text-slate-400">Bankroll</p>
        </Card>
        <Card className="text-center">
          <p
            className={`text-2xl font-bold tabular-nums ${
              pnlPct > 0 ? "text-emerald-600" : pnlPct < 0 ? "text-red-600" : "text-slate-900"
            }`}
          >
            {price.toFixed(4)}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Share price {pnlPct !== 0 && `(${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}%)`}
          </p>
        </Card>
      </div>

      {lockedCollateral > 0n && (
        <Card className="mb-4 bg-amber-50">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-amber-800">Reserved for the open draw</p>
              <p className="text-xs text-amber-700">
                {formatUSD(availableToWithdraw)} free to withdraw right now
              </p>
            </div>
            <span className="font-bold text-amber-800">{formatUSD(lockedCollateral)}</span>
          </div>
        </Card>
      )}

      {!isConnected ? (
        <Card className="flex flex-col items-center gap-3 py-10">
          <p className="text-sm text-slate-400">Connect a wallet to provide liquidity</p>
          <ConnectButton />
        </Card>
      ) : (
        <div className="space-y-4">
          {myShares > 0n && (
            <Card className="bg-slate-900 text-center">
              <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                Your position
              </p>
              <p className="my-1 text-3xl font-black text-white">{formatUSD(myAssets)}</p>
              <p className="text-xs text-slate-400">
                {formatUSDC(myShares)} shares
              </p>
            </Card>
          )}

          <Card>
            <h3 className="mb-3 font-semibold text-slate-900">Deposit</h3>
            <div className="flex gap-2">
              <input
                type="number"
                inputMode="decimal"
                placeholder="Amount in USDC"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-900 outline-none transition-colors focus:border-slate-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <Button
                onClick={() => depositAmount && deposit(parseUSDC(depositAmount))}
                disabled={busy || !depositAmount}
              >
                {step === "approving" ? "Approving…" : step === "depositing" ? "Depositing…" : "Deposit"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Balance {formatUSDC(balance)} USDC
            </p>
          </Card>

          {myShares > 0n && (
            <Card>
              <h3 className="mb-3 font-semibold text-slate-900">Withdraw</h3>
              <div className="flex gap-2">
                <input
                  type="number"
                  inputMode="decimal"
                  placeholder="Shares to burn"
                  value={withdrawShares}
                  onChange={(e) => setWithdrawShares(e.target.value)}
                  className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-900 outline-none transition-colors focus:border-slate-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <Button
                  variant="secondary"
                  onClick={() => withdrawShares && withdraw(parseUSDC(withdrawShares))}
                  disabled={busy || !withdrawShares}
                >
                  {step === "withdrawing" ? "…" : "Withdraw"}
                </Button>
              </div>
              <button
                onClick={() => setWithdrawShares(formatUSDC(myShares))}
                className="mt-2 text-xs font-semibold text-indigo-600 hover:text-indigo-700"
              >
                Withdraw everything
              </button>
            </Card>
          )}

          {step === "done" && (
            <div className="text-center">
              <Pill tone="success">Confirmed</Pill>
            </div>
          )}

          {error && (
            <p className="break-words text-center text-xs text-red-500">
              {error.message.split("\n")[0]}
            </p>
          )}
        </div>
      )}

      <Card className="mt-6 bg-slate-50">
        <h3 className="mb-2 text-sm font-bold text-slate-900">How the vault earns</h3>
        <ul className="space-y-1.5 text-xs leading-relaxed text-slate-500">
          <li>
            Every bet is priced with a house edge built into its payout multiplier. Over enough
            draws that edge is the vault&apos;s return.
          </li>
          <li>
            Winning draws are paid out of the bankroll, so share price falls on a bad draw and
            rises on a good one. Returns are real but not smooth.
          </li>
          <li>
            While a draw is open, the worst case it could cost is reserved and cannot be
            withdrawn — so a winner can always be paid.
          </li>
        </ul>
      </Card>
    </div>
  );
}
