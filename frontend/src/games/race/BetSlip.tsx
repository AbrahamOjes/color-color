"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { type Address } from "viem";
import { usePlaceBet } from "@/hooks/usePredictionGame";
import { TransakButton } from "@/components/TransakButton";
import { Card, Button, Pill } from "@/components/ui";
import { formatUSD, formatUSDC } from "@/lib/utils";
import { type GameInstance } from "../types";
import { type RaceSkin } from "../skins";
import {
  MARKET,
  MARKET_LABEL,
  PICKS,
  encodeRaceSelection,
  hiLoLabel,
  isCompleteSelection,
  oddEvenLabel,
} from "./encode";
import { useRaceQuote, type RaceOdds } from "./hooks";
import { type Selection } from "./RaceCard";
import { RunnerToken } from "./RunnerToken";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const STAKE_PRESETS = [0.5, 1, 5, 10];

type Tab = "SINGLES" | "FORECAST" | "REVERSE_FORECAST" | "TRICAST" | "SPECIALS";

const TABS: [Tab, string][] = [
  ["SINGLES", "W/P/S"],
  ["FORECAST", "Forecast"],
  ["REVERSE_FORECAST", "Rev FC"],
  ["TRICAST", "Tricast"],
  ["SPECIALS", "Odd · Hi"],
];

const TAB_MARKET: Partial<Record<Tab, number>> = {
  FORECAST: MARKET.FORECAST,
  REVERSE_FORECAST: MARKET.REVERSE_FORECAST,
  TRICAST: MARKET.TRICAST,
};

const POSITION = ["1st", "2nd", "3rd"];

/// The bet slip: pickers for the exotic markets, then stake, the contract's exact quote,
/// and the approve-then-bet flow.
export function BetSlip({
  game,
  drawId,
  skin,
  odds,
  selection,
  onSelect,
  bettingOpen,
  closedReason,
  maxPayoutPerBet,
  referrer,
}: {
  game: GameInstance;
  drawId: bigint;
  skin: RaceSkin;
  odds: RaceOdds | null;
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  bettingOpen: boolean;
  closedReason: string;
  maxPayoutPerBet: bigint;
  referrer: Address;
}) {
  const { isConnected } = useAccount();
  const { submitBet, executeBet, step, setStep, isApproved, isBetPlaced, balance, error } =
    usePlaceBet(game);

  const [tab, setTab] = useState<Tab>("SINGLES");
  const [stake, setStake] = useState(1);
  const runners = skin.runners.length;

  // A tap on the race card selects a single, which always shows on the singles tab.
  const shownTab: Tab = selection && selection.market <= MARKET.SHOW ? "SINGLES" : tab;

  const complete = selection !== null && isCompleteSelection(selection.market, selection.picks, runners);
  const encoded = complete ? encodeRaceSelection(selection.market, selection.picks) : null;
  const quote = useRaceQuote(game, drawId, complete ? selection.market : null, encoded, stake);

  // Chain the approve into the bet once the approval confirms.
  useEffect(() => {
    if (isApproved && step === "approving" && complete && encoded) {
      executeBet(selection.market, encoded, BigInt(Math.round(stake * 1e6)), referrer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isApproved, step]);

  useEffect(() => {
    if (isBetPlaced) setStep("done");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBetPlaced]);

  const stakeWei = BigInt(Math.round(stake * 1e6));
  const hasEnough = balance >= stakeWei;
  const overCap = quote !== null && maxPayoutPerBet > 0n && quote.payout > maxPayoutPerBet;
  const busy = step === "approving" || step === "betting";

  function chooseTab(next: Tab) {
    setTab(next);
    const market = TAB_MARKET[next];
    onSelect(market === undefined ? null : { market, picks: [] });
  }

  /// Exotic pickers: tap runners in finishing order; tap a picked runner to drop it.
  function togglePick(runner: number) {
    const market = TAB_MARKET[shownTab];
    if (market === undefined) return;
    const picks = selection?.market === market ? selection.picks : [];
    if (picks.includes(runner)) {
      onSelect({ market, picks: picks.filter((p) => p !== runner) });
    } else if (picks.length < PICKS[market]) {
      onSelect({ market, picks: [...picks, runner] });
    }
  }

  function handleBet() {
    if (!complete || !encoded) return;
    submitBet(selection.market, encoded, stake, referrer);
  }

  const label = (r: number) => `${skin.runnerLabel} ${r + 1}`;
  const exoticMarket = TAB_MARKET[shownTab];
  const picks = exoticMarket !== undefined && selection?.market === exoticMarket ? selection.picks : [];

  return (
    <>
      <div className="mb-3 flex gap-1 rounded-xl bg-slate-100 p-1">
        {TABS.map(([id, text]) => (
          <button
            key={id}
            onClick={() => chooseTab(id)}
            className={`flex-1 rounded-lg py-2 text-[11px] font-bold transition-all ${
              shownTab === id ? "bg-white text-slate-900 shadow-sm" : "text-slate-400 hover:text-slate-600"
            }`}
          >
            {text}
          </button>
        ))}
      </div>

      <Card className="mb-5">
        {shownTab === "SINGLES" && (
          <p className="text-sm text-slate-500">
            {selection && selection.market <= MARKET.SHOW && complete ? (
              <span className="flex items-center gap-2">
                <RunnerToken index={selection.picks[0]} style={skin.runners[selection.picks[0]]} size="sm" />
                <span className="font-semibold text-slate-800">
                  {skin.runners[selection.picks[0]].name} to {MARKET_LABEL[selection.market].toLowerCase()}
                </span>
              </span>
            ) : (
              "Tap a Win, Place or Show price on the race card."
            )}
          </p>
        )}

        {exoticMarket !== undefined && (
          <>
            <p className="mb-3 text-sm font-semibold text-slate-700">
              {exoticMarket === MARKET.FORECAST && "Pick 1st and 2nd, in order."}
              {exoticMarket === MARKET.REVERSE_FORECAST && "Pick two to fill 1st and 2nd, either order."}
              {exoticMarket === MARKET.TRICAST && "Pick 1st, 2nd and 3rd, in order."}
            </p>
            <div className="mb-3 flex gap-2">
              {Array.from({ length: PICKS[exoticMarket] }, (_, slot) => {
                const r = picks[slot];
                return (
                  <div
                    key={slot}
                    className="flex flex-1 items-center gap-2 rounded-lg border border-dashed border-slate-200 px-2 py-1.5"
                  >
                    <span className="text-[10px] font-bold uppercase text-slate-400">
                      {exoticMarket === MARKET.REVERSE_FORECAST ? "Any" : POSITION[slot]}
                    </span>
                    {r !== undefined ? (
                      <RunnerToken index={r} style={skin.runners[r]} size="sm" />
                    ) : (
                      <span className="text-xs text-slate-300">—</span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="grid grid-cols-6 gap-2">
              {skin.runners.map((style, r) => {
                const at = picks.indexOf(r);
                return (
                  <button
                    key={r}
                    onClick={() => togglePick(r)}
                    disabled={!bettingOpen}
                    aria-label={`${label(r)} ${style.name}`}
                    className={`relative flex justify-center rounded-lg py-2 transition-all disabled:opacity-50 ${
                      at >= 0 ? "bg-slate-900" : "bg-slate-50 hover:bg-slate-100"
                    }`}
                  >
                    <RunnerToken index={r} style={style} />
                    {at >= 0 && exoticMarket !== MARKET.REVERSE_FORECAST && (
                      <span className="absolute -right-1 -top-1 rounded-full bg-amber-400 px-1 text-[9px] font-black text-slate-900">
                        {POSITION[at]}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {shownTab === "SPECIALS" && (
          <div className="space-y-4">
            {(
              [
                [MARKET.ODD_EVEN, "Winner's number", odds?.oddEven, oddEvenLabel],
                [MARKET.HI_LO, "Winner's half", odds?.hiLo, (c: number) => hiLoLabel(c, runners)],
              ] as const
            ).map(([market, title, prices, text]) => (
              <div key={market}>
                <p className="mb-2 text-sm font-semibold text-slate-700">{title}</p>
                <div className="grid grid-cols-2 gap-2">
                  {[0, 1].map((choice) => {
                    const on = selection?.market === market && selection.picks[0] === choice;
                    return (
                      <button
                        key={choice}
                        disabled={!bettingOpen}
                        onClick={() => onSelect({ market, picks: [choice] })}
                        className={`rounded-xl py-3 text-sm font-bold transition-all disabled:opacity-50 ${
                          on ? "bg-slate-900 text-white shadow-md" : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                        }`}
                      >
                        {text(choice)}
                        <span className="ml-2 tabular-nums opacity-70">{prices ? prices[choice].toFixed(2) : "—"}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Stake + fixed-odds quote */}
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-700">Stake</span>
          <div className="flex gap-1.5">
            {STAKE_PRESETS.map((v) => (
              <button
                key={v}
                onClick={() => setStake(v)}
                className={`h-8 rounded-full px-3 text-xs font-bold transition-all ${
                  stake === v ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                }`}
              >
                ${v}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-center">
          {quote && complete ? (
            <>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                {MARKET_LABEL[selection.market]} · you win
              </p>
              <p className="my-1 text-3xl font-black tabular-nums text-slate-900">{formatUSD(quote.payout)}</p>
              <p className="text-sm font-semibold text-slate-500">
                {quote.multiplier.toFixed(2)}× your ${stake} stake
              </p>
            </>
          ) : (
            <p className="py-3 text-sm text-slate-400">
              {complete ? "Pricing…" : "Make a selection to see your payout"}
            </p>
          )}
        </div>

        {overCap && (
          <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-center text-xs font-semibold text-amber-700">
            Payout exceeds the {formatUSD(maxPayoutPerBet)} per-bet cap. Lower your stake.
          </p>
        )}

        {referrer !== ZERO && (
          <p className="mb-3 text-center text-xs text-slate-400">
            Referred by {referrer.slice(0, 6)}…{referrer.slice(-4)}
          </p>
        )}

        {!isConnected ? (
          <div className="flex flex-col items-center gap-3 py-2">
            <p className="text-sm text-slate-400">Connect a wallet to play</p>
            <ConnectButton />
          </div>
        ) : step === "done" ? (
          <div className="py-2 text-center">
            <Pill tone="success">Bet placed</Pill>
            <div className="mt-3 flex justify-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setStep("idle");
                  onSelect(null);
                }}
              >
                Bet again
              </Button>
              <Link href="/bets">
                <Button variant="ghost" size="sm">
                  My bets
                </Button>
              </Link>
            </div>
          </div>
        ) : (
          <>
            <Button
              onClick={handleBet}
              disabled={!complete || !bettingOpen || !hasEnough || overCap || busy}
              className="w-full"
              size="lg"
            >
              {step === "approving"
                ? "Approving…"
                : step === "betting"
                  ? "Placing bet…"
                  : !bettingOpen
                    ? closedReason
                    : !complete
                      ? "Make a selection"
                      : !hasEnough
                        ? "Insufficient USDC"
                        : `Bet $${stake}`}
            </Button>
            <p className="mt-2 text-center text-xs text-slate-400">Balance {formatUSDC(balance)} USDC</p>
            {!hasEnough && (
              <div className="mt-3">
                <TransakButton />
              </div>
            )}
          </>
        )}

        {error && (
          <p className="mt-3 break-words text-center text-xs text-red-500">{error.message.split("\n")[0]}</p>
        )}
      </Card>
    </>
  );
}
