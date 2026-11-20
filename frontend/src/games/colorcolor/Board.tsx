"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { isAddress, type Address } from "viem";
import { usePredictionGame, usePlaceBet } from "@/hooks/usePredictionGame";
import { Countdown } from "@/components/Countdown";
import { TransakButton } from "@/components/TransakButton";
import { Card, Button, Pill } from "@/components/ui";
import { detectSignals, type HistoricDraw } from "@/lib/signals";
import { formatUSDC, formatUSD } from "@/lib/utils";
import {
  COLOURS,
  getColour,
  COLOUR_BG,
  COLOUR_ON_BG,
  COLOUR_GRAD,
  COLOUR_TEXT,
  COLOUR_RANGE,
} from "@/lib/colours";
import { type GameInstance } from "../types";
import { useColorColorQuote, useRecentDraws } from "./hooks";
import { BET_TYPE, encodeSelection, type BetType } from "./encode";
import { SignalsPanel } from "./SignalsPanel";
import { StakePlanner } from "./StakePlanner";

type GameTab = "COLOR" | "NUMBERS" | "HILO" | "RAINBOW";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const STAKE_PRESETS = [0.5, 1, 5, 10];

export function ColorColorBoard({ game }: { game: GameInstance }) {
  // useSearchParams still requires a Suspense boundary in Next 16 — a static client page
  // that calls it fails the production build without one.
  return (
    <Suspense fallback={<div className="py-20 text-center text-slate-400">Loading…</div>}>
      <BoardInner game={game} />
    </Suspense>
  );
}

function BoardInner({ game }: { game: GameInstance }) {
  const searchParams = useSearchParams();
  const refParam = searchParams.get("ref");
  const referrer: Address = refParam && isAddress(refParam) ? (refParam as Address) : ZERO;

  const { isConnected } = useAccount();
  const { currentDrawId, drawInterval, lastDrawTimestamp, drawPending, maxPayoutPerBet } =
    usePredictionGame(game);
  const { submitBet, executeBet, step, setStep, isApproved, isBetPlaced, balance, error } =
    usePlaceBet(game);

  const [tab, setTab] = useState<GameTab>("COLOR");
  const [stake, setStake] = useState(1);
  const [numbers, setNumbers] = useState<number[]>([]);
  const [colour, setColour] = useState<number | null>(null);
  const [hilo, setHilo] = useState<number | null>(null);
  const [rainbow, setRainbow] = useState([2, 1, 1, 2]);
  const [showStrategy, setShowStrategy] = useState(false);
  const [baseStake, setBaseStake] = useState(1);
  const [ladderLevel, setLadderLevel] = useState(0);

  const history = useRecentDraws(game, currentDrawId, 100) as HistoricDraw[];
  const detectedCount =
    history.length >= 12
      ? detectSignals(history, Math.min(100, history.length)).filter((s) => s.direction === "entry")
          .length
      : 0;

  // Resolve the current selection into a contract bet type + selection array.
  let betType: BetType | null = null;
  let selection: number[] | null = null;

  if (tab === "NUMBERS" && numbers.length > 0) {
    betType = numbers.length === 1 ? "PICK1" : numbers.length === 2 ? "PICK2" : "PICK3";
    selection = numbers;
  } else if (tab === "COLOR" && colour !== null) {
    betType = "COLOR";
    selection = [colour];
  } else if (tab === "HILO" && hilo !== null) {
    betType = "HILO";
    selection = [hilo];
  } else if (tab === "RAINBOW" && rainbow.reduce((a, b) => a + b, 0) === 6) {
    betType = "RAINBOW";
    selection = rainbow;
  }

  // Priced by the contract, never recomputed here.
  const quote = useColorColorQuote(game, betType, selection, stake);

  // Chain the approve into the bet once the approval confirms.
  useEffect(() => {
    if (isApproved && step === "approving" && betType && selection) {
      executeBet(
        BET_TYPE[betType],
        encodeSelection(betType, selection),
        BigInt(Math.round(stake * 1e6)),
        referrer,
      );
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
  const ready = betType !== null && selection !== null;
  const busy = step === "approving" || step === "betting";

  function resetSelection() {
    setNumbers([]);
    setColour(null);
    setHilo(null);
  }

  function toggleNumber(n: number) {
    setNumbers((prev) => {
      if (prev.includes(n)) return prev.filter((x) => x !== n);
      if (prev.length >= 3) return prev;
      return [...prev, n];
    });
  }

  function handleBet() {
    if (!betType || !selection) return;
    submitBet(BET_TYPE[betType], encodeSelection(betType, selection), stake, referrer);
  }

  /** A signal or market call jumps straight to that colour on the board. */
  function backSelection(id: number) {
    setTab("COLOR");
    setNumbers([]);
    setHilo(null);
    setColour(id);
    setShowStrategy(false);
  }

  return (
    <div className="mx-auto max-w-lg px-4 pb-16 pt-6">
      {/* Live bar */}
      <Card className="mb-5 flex items-center justify-between" >
        <div>
          <p className="text-xs text-slate-400">Draw #{currentDrawId.toString()}</p>
          <Link href="/results" className="text-sm font-semibold text-indigo-600 hover:text-indigo-700">
            Results &amp; stats →
          </Link>
        </div>
        <div className="text-right">
          <p className="text-xs text-slate-400">{drawPending ? "Settling" : "Closes in"}</p>
          <Countdown
            lastDrawTimestamp={lastDrawTimestamp}
            drawInterval={drawInterval}
            drawPending={drawPending}
          />
        </div>
      </Card>

      {/* Strategy surface — the signals players come here for */}
      <div className="mb-5">
        <button
          onClick={() => setShowStrategy((v) => !v)}
          className="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm transition-colors hover:border-slate-300"
        >
          <span className="flex items-center gap-2">
            <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 text-emerald-500 live-dot" />
            <span className="text-sm font-bold text-slate-900">Strategy &amp; signals</span>
            {history.length >= 12 && (
              <Pill>{detectedCount} live</Pill>
            )}
          </span>
          <span className="text-xs text-slate-400">{showStrategy ? "Hide ▲" : "Show ▼"}</span>
        </button>

        {showStrategy && (
          <div className="mt-3">
            <SignalsPanel draws={history} onPick={backSelection} />
            <StakePlanner
              baseStake={baseStake}
              level={ladderLevel}
              maxLevels={4}
              multiplier={quote?.multiplier ?? 0}
              onLevelChange={setLadderLevel}
              onUseStake={setStake}
            />
            <div className="mb-1 flex items-center justify-between px-1">
              <label className="text-xs font-semibold text-slate-500">Base stake for the ladder</label>
              <div className="flex gap-1.5">
                {[0.5, 1, 2, 5].map((v) => (
                  <button
                    key={v}
                    onClick={() => setBaseStake(v)}
                    className={`h-7 rounded-full px-2.5 text-[11px] font-bold transition-all ${
                      baseStake === v ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    ${v}
                  </button>
                ))}
              </div>
            </div>
            <Link
              href="/stats"
              className="mt-2 block text-center text-xs font-semibold text-indigo-600 hover:text-indigo-700"
            >
              Full statistics →
            </Link>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-5 flex gap-1 rounded-xl bg-slate-100 p-1">
        {(
          [
            ["COLOR", "Colour"],
            ["NUMBERS", "Numbers"],
            ["HILO", "Hi/Lo"],
            ["RAINBOW", "Rainbow"],
          ] as [GameTab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
              resetSelection();
            }}
            className={`flex-1 rounded-lg py-2 text-xs font-bold transition-all ${
              tab === id ? "bg-white text-slate-900 shadow-sm" : "text-slate-400 hover:text-slate-600"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Board */}
      <Card className="mb-5">
        {tab === "COLOR" && (
          <>
            <p className="mb-4 text-sm font-semibold text-slate-700">
              Which colour appears most among the six balls?
            </p>
            <div className="grid grid-cols-2 gap-3">
              {[
                ...COLOURS.map((name, idx) => ({
                  idx,
                  name: name as string,
                  cls: COLOUR_GRAD[name],
                  sub: COLOUR_RANGE[name],
                  dark: name === "Yellow",
                })),
                { idx: 4, name: "Draw", cls: "from-slate-300 to-slate-500", sub: "No single winner", dark: false },
              ].map(({ idx, name, cls, sub, dark }) => (
                <button
                  key={idx}
                  onClick={() => setColour(idx)}
                  className={`rounded-xl bg-gradient-to-br p-5 text-center font-bold transition-all ${cls} ${
                    dark ? "text-slate-900" : "text-white"
                  } ${colour === idx ? "scale-105 ring-4 ring-slate-900 ring-offset-2" : "opacity-80 hover:opacity-100"}`}
                >
                  <span className="text-lg">{name}</span>
                  <span className="mt-1 block text-xs opacity-75">{sub}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {tab === "NUMBERS" && (
          <>
            <p className="mb-3 text-sm font-semibold text-slate-700">
              Pick 1–3 numbers. Every one you pick must appear.
            </p>
            <div className="grid grid-cols-7 gap-1.5">
              {Array.from({ length: 49 }, (_, i) => i + 1).map((n) => {
                const c = getColour(n);
                const on = numbers.includes(n);
                return (
                  <button
                    key={n}
                    onClick={() => toggleNumber(n)}
                    className={`h-9 w-full rounded-lg text-xs font-bold transition-all ${
                      on
                        ? `${COLOUR_BG[c]} ${COLOUR_ON_BG[c]} scale-110 shadow-md`
                        : "bg-slate-50 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {n}
                  </button>
                );
              })}
            </div>
            {numbers.length > 0 && (
              <div className="mt-3 flex items-center justify-center gap-2">
                <Pill>
                  {numbers.length === 1 ? "Pick 1" : numbers.length === 2 ? "Pick 2" : "Pick 3"}
                </Pill>
                <span className="text-sm text-slate-500">
                  {[...numbers].sort((a, b) => a - b).join(", ")}
                </span>
              </div>
            )}
          </>
        )}

        {tab === "HILO" && (
          <>
            <p className="mb-4 text-sm font-semibold text-slate-700">
              Where will the six balls add up to?
            </p>
            <div className="grid grid-cols-3 gap-3">
              {[
                { idx: 0, label: "Lo", desc: "≤ 120", cls: "from-cyan-400 to-cyan-600" },
                { idx: 1, label: "Mid", desc: "121–159", cls: "from-violet-400 to-violet-600" },
                { idx: 2, label: "Hi", desc: "≥ 160", cls: "from-orange-400 to-orange-600" },
              ].map(({ idx, label, desc, cls }) => (
                <button
                  key={idx}
                  onClick={() => setHilo(idx)}
                  className={`rounded-xl bg-gradient-to-br p-6 text-center font-bold text-white transition-all ${cls} ${
                    hilo === idx ? "scale-105 ring-4 ring-slate-900 ring-offset-2" : "opacity-80 hover:opacity-100"
                  }`}
                >
                  <span className="text-xl">{label}</span>
                  <span className="mt-1 block text-xs opacity-75">{desc}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {tab === "RAINBOW" && (
          <>
            <p className="mb-4 text-sm font-semibold text-slate-700">
              Call the exact colour split. Must total 6.
            </p>
            <div className="space-y-3">
              {COLOURS.map((name, i) => (
                <div key={name} className="flex items-center justify-between">
                  <span className={`text-sm font-semibold ${COLOUR_TEXT[name]}`}>
                    {name} <span className="text-slate-400">({COLOUR_RANGE[name]})</span>
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() =>
                        setRainbow((r) => r.map((v, j) => (j === i ? Math.max(0, v - 1) : v)))
                      }
                      className="h-8 w-8 rounded-full bg-slate-100 font-bold text-slate-600 hover:bg-slate-200"
                    >
                      −
                    </button>
                    <span className="w-6 text-center text-lg font-bold">{rainbow[i]}</span>
                    <button
                      onClick={() =>
                        setRainbow((r) => r.map((v, j) => (j === i ? Math.min(6, v + 1) : v)))
                      }
                      className="h-8 w-8 rounded-full bg-slate-100 font-bold text-slate-600 hover:bg-slate-200"
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
              <p
                className={`text-center text-sm font-semibold ${
                  rainbow.reduce((a, b) => a + b, 0) === 6 ? "text-emerald-600" : "text-red-500"
                }`}
              >
                Total {rainbow.reduce((a, b) => a + b, 0)}/6
              </p>
            </div>
          </>
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

        {/* This block is the entire point of fixed odds: the exact return, before betting. */}
        <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-center">
          {quote ? (
            <>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
                You win
              </p>
              <p className="my-1 text-3xl font-black tabular-nums text-slate-900">
                {formatUSD(quote.payout)}
              </p>
              <p className="text-sm font-semibold text-slate-500">
                {quote.multiplier.toFixed(2)}× your ${stake} stake
              </p>
            </>
          ) : (
            <p className="py-3 text-sm text-slate-400">
              {ready ? "Pricing…" : "Make a selection to see your payout"}
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
            Referred by {refParam?.slice(0, 6)}…{refParam?.slice(-4)}
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
                  resetSelection();
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
              disabled={!ready || drawPending || !hasEnough || overCap || busy}
              className="w-full"
              size="lg"
            >
              {step === "approving"
                ? "Approving…"
                : step === "betting"
                  ? "Placing bet…"
                  : drawPending
                    ? "Draw in progress"
                    : !ready
                      ? "Make a selection"
                      : !hasEnough
                        ? "Insufficient USDC"
                        : `Bet $${stake}`}
            </Button>
            <p className="mt-2 text-center text-xs text-slate-400">
              Balance {formatUSDC(balance)} USDC
            </p>
            {/* Fiat on-ramp, surfaced exactly when the balance is the blocker. */}
            {!hasEnough && (
              <div className="mt-3">
                <TransakButton />
              </div>
            )}
          </>
        )}

        {error && (
          <p className="mt-3 break-words text-center text-xs text-red-500">
            {error.message.split("\n")[0]}
          </p>
        )}
      </Card>
    </div>
  );
}
