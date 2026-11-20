#!/usr/bin/env node
/**
 * MCP server exposing the ColorColor virtual game to autonomous agents.
 *
 * The agent holds its own key and acts unattended, but it never holds the money: every bet
 * is routed through an on-chain AgentMandate that enforces the principal's limits. Nothing
 * here relies on the agent behaving well — the limits live in the EVM.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Hex } from "viem";

import {
  ABI,
  BET_TYPE,
  BET_TYPE_NAME,
  COLOUR_NAMES,
  HILO_NAMES,
  type BetTypeName,
  colourOf,
  describeSelection,
  encodeSelection,
  fromUsdc,
  makeClients,
  toUsdc,
  usd,
} from "./chain.js";
import {
  backtest,
  makeDraw,
  simulateDraws,
  STRATEGY_DESCRIPTIONS,
  type Draw,
  type StrategyName,
} from "./backtest.js";
import {
  colourStats,
  detectSignals,
  recommendMarket,
  SELECTION_LABELS,
  SIGNAL_STATS,
  type HistoricDraw,
} from "./signals.js";

const clients = makeClients();
const { publicClient, walletClient, account, config } = clients;

/** Wrap a tool result as MCP text content. */
function text(body: unknown) {
  return {
    content: [
      { type: "text" as const, text: typeof body === "string" ? body : JSON.stringify(body, null, 2) },
    ],
  };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: `ERROR: ${message}` }], isError: true };
}

async function readGame<T>(functionName: string, args: unknown[] = []): Promise<T> {
  return (await publicClient.readContract({
    address: config.game,
    abi: ABI.game,
    functionName,
    args,
  })) as T;
}

async function readMandate<T>(functionName: string, args: unknown[] = []): Promise<T> {
  return (await publicClient.readContract({
    address: config.mandate,
    abi: ABI.mandate,
    functionName,
    args,
  })) as T;
}

/**
 * Turn agent-friendly arguments into the contract's encoded selection.
 * Accepts colour and band names as well as ids, because an LLM is far more likely to say
 * "Blue" than "3".
 */
function buildSelection(betType: BetTypeName, raw: (number | string)[]): number[] {
  if (betType === "COLOR") {
    const v = raw[0];
    if (typeof v === "string") {
      const idx = COLOUR_NAMES.findIndex((c) => c.toLowerCase() === v.toLowerCase());
      if (idx < 0) throw new Error(`Unknown colour "${v}". Use one of ${COLOUR_NAMES.join(", ")}.`);
      return [idx];
    }
    return [v];
  }

  if (betType === "HILO") {
    const v = raw[0];
    if (typeof v === "string") {
      const idx = HILO_NAMES.findIndex((c) => c.toLowerCase() === v.toLowerCase());
      if (idx < 0) throw new Error(`Unknown band "${v}". Use one of ${HILO_NAMES.join(", ")}.`);
      return [idx];
    }
    return [v];
  }

  const nums = raw.map((v) => (typeof v === "string" ? Number(v) : v));
  if (nums.some((n) => !Number.isInteger(n))) throw new Error("Selection must be whole numbers.");
  return nums;
}

const server = new McpServer(
  { name: "colorcolor-agent", version: "1.0.0" },
  {
    instructions: [
      "ColorColor is a fixed-odds virtual game: 6 balls drawn from 1-49 every few minutes.",
      "",
      "READ THIS BEFORE PLANNING A STRATEGY. Draws come from Chainlink VRF, so every draw is",
      "statistically independent, and payouts are fixed odds with a house edge priced into the",
      "multiplier. There is therefore NO edge to find and NO winning strategy:",
      "  - Hot and cold numbers are gambler's fallacy. Past draws say nothing about the next one.",
      "  - Every bet has negative expected value by construction. More analysis does not change this.",
      "  - Bet sizing (martingale and friends) cannot turn negative EV positive.",
      "Do not claim to have found an edge, and do not present a betting pattern as profitable.",
      "If asked to maximise returns, say plainly that the only non-losing option is not to bet,",
      "and that the vault (HouseVault) is the side that holds the edge.",
      "",
      "Your role is to play a pattern the human chose, within limits they set on-chain. Those",
      "limits — per-bet cap, daily budget, cooldown, allowed bet types, expiry — are enforced by",
      "the AgentMandate contract, not by you. Call check_can_bet before place_bet and respect a",
      "refusal instead of retrying in a loop.",
      "",
      "All amounts are USDC. Stakes and payouts are given in whole dollars (e.g. 1.5 = $1.50).",
    ].join("\n"),
  },
);

// ──────────────────────────────────────────────
//  Reads
// ──────────────────────────────────────────────

server.registerTool(
  "get_game_state",
  {
    title: "Get game state",
    description:
      "Current draw id, seconds until the next draw, whether betting is open, the house edge, and the per-bet payout cap.",
    inputSchema: {},
  },
  async () => {
    const [drawId, interval, lastDraw, pending, edgeBps, maxPayout] = await Promise.all([
      readGame<bigint>("currentDrawId"),
      readGame<bigint>("drawInterval"),
      readGame<bigint>("lastDrawTimestamp"),
      readGame<boolean>("drawPending"),
      readGame<bigint>("houseEdgeBps"),
      readGame<bigint>("maxPayoutPerBet"),
    ]);

    const now = Math.floor(Date.now() / 1000);
    const secondsUntilDraw = Math.max(0, Number(lastDraw) + Number(interval) - now);

    return text({
      currentDrawId: drawId.toString(),
      bettingOpen: !pending,
      drawPending: pending,
      secondsUntilDraw,
      drawIntervalSeconds: Number(interval),
      houseEdgePercent: Number(edgeBps) / 100,
      maxPayoutPerBet: usd(maxPayout),
      note: "The house edge is priced into every multiplier. Every bet is negative expected value.",
    });
  },
);

server.registerTool(
  "get_odds",
  {
    title: "Get the odds table",
    description:
      "Exact payout multipliers for every bet type, read from the contract. Note Blue pays less than the other colours (it holds 13 numbers, not 12) and HILO Lo pays more than Hi (the bands are not symmetric about the mean).",
    inputSchema: {},
  },
  async () => {
    const reference = toUsdc(1);
    const probes: { label: string; betType: BetTypeName; selection: number[] }[] = [
      { label: "PICK1 (one number appears)", betType: "PICK1", selection: [7] },
      { label: "PICK2 (both numbers appear)", betType: "PICK2", selection: [7, 21] },
      { label: "PICK3 (all three appear)", betType: "PICK3", selection: [7, 21, 35] },
      { label: "COLOR Red", betType: "COLOR", selection: [0] },
      { label: "COLOR Yellow", betType: "COLOR", selection: [1] },
      { label: "COLOR Green", betType: "COLOR", selection: [2] },
      { label: "COLOR Blue", betType: "COLOR", selection: [3] },
      { label: "COLOR Draw (tie)", betType: "COLOR", selection: [4] },
      { label: "HILO Lo (sum <= 120)", betType: "HILO", selection: [0] },
      { label: "HILO Mid (121-159)", betType: "HILO", selection: [1] },
      { label: "HILO Hi (sum >= 160)", betType: "HILO", selection: [2] },
      { label: "RAINBOW 2-1-1-2", betType: "RAINBOW", selection: [2, 1, 1, 2] },
      { label: "RAINBOW 3-1-1-1", betType: "RAINBOW", selection: [3, 1, 1, 1] },
    ];

    const rows = await Promise.all(
      probes.map(async (p) => {
        const [payout, multiplierBps] = await readGame<[bigint, bigint]>("quote", [
          BET_TYPE[p.betType],
          encodeSelection(p.betType, p.selection),
          reference,
        ]);
        return {
          bet: p.label,
          multiplier: `${(Number(multiplierBps) / 10_000).toFixed(4)}x`,
          payoutOnOneDollar: usd(payout),
        };
      }),
    );

    return text({
      odds: rows,
      colourRanges: { Red: "1-12", Yellow: "13-24", Green: "25-36", Blue: "37-49 (13 numbers)" },
      warning:
        "These multipliers already include the house edge. No combination of them is profitable in expectation.",
    });
  },
);

server.registerTool(
  "quote_bet",
  {
    title: "Quote a bet",
    description:
      "Exact payout for a prospective bet, priced by the contract itself. This is the same code path that pays a claim, so it cannot drift from what you would actually receive.",
    inputSchema: {
      bet_type: z.enum(["PICK1", "PICK2", "PICK3", "COLOR", "HILO", "RAINBOW"]),
      selection: z
        .array(z.union([z.number(), z.string()]))
        .describe(
          'PICK1/2/3: the numbers, e.g. [7] or [7,21,35]. COLOR: a colour name or id, e.g. ["Blue"] or [3]; "Draw" means no single colour dominates. HILO: ["Lo"|"Mid"|"Hi"]. RAINBOW: exact colour counts [R,Y,G,B] summing to 6.',
        ),
      stake: z.number().positive().describe("Stake in USDC, e.g. 1.5 for $1.50"),
    },
  },
  async ({ bet_type, selection, stake }) => {
    try {
      const sel = buildSelection(bet_type, selection);
      const encoded = encodeSelection(bet_type, sel);
      const [payout, multiplierBps] = await readGame<[bigint, bigint]>("quote", [
        BET_TYPE[bet_type],
        encoded,
        toUsdc(stake),
      ]);

      return text({
        betType: bet_type,
        selection: describeSelection(BET_TYPE[bet_type], encoded),
        stake: `$${stake.toFixed(2)}`,
        payoutIfWon: usd(payout),
        multiplier: `${(Number(multiplierBps) / 10_000).toFixed(4)}x`,
        netProfitIfWon: usd(payout - toUsdc(stake)),
      });
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  },
);

server.registerTool(
  "get_recent_draws",
  {
    title: "Get recent draws",
    description:
      "Recent settled results. Useful for reporting history to a human. NOT useful for prediction: draws are independent, so nothing here has any bearing on the next one.",
    inputSchema: { count: z.number().int().min(1).max(25).default(10) },
  },
  async ({ count }) => {
    const current = await readGame<bigint>("currentDrawId");
    const ids: bigint[] = [];
    for (let i = 1n; i <= BigInt(count); i++) {
      const id = current - i;
      if (id > 0n) ids.push(id);
    }

    const draws = await Promise.all(
      ids.map(async (id) => {
        const [numbers, colourCount, sum, dominant, totalPayout, settled] = await readGame<
          [readonly number[], readonly number[], number, number, bigint, boolean]
        >("getDrawResult", [id]);
        if (!settled) return null;
        return {
          drawId: id.toString(),
          numbers: [...numbers],
          colours: [...numbers].map(colourOf),
          counts: { Red: colourCount[0], Yellow: colourCount[1], Green: colourCount[2], Blue: colourCount[3] },
          sum,
          dominantColour: COLOUR_NAMES[dominant],
          hiloBand: sum <= 120 ? "Lo" : sum >= 160 ? "Hi" : "Mid",
          totalPaidOut: usd(totalPayout),
        };
      }),
    );

    return text({
      draws: draws.filter(Boolean),
      reminder: "Each draw is independent VRF output. Patterns here are noise.",
    });
  },
);

// ──────────────────────────────────────────────
//  Mandate
// ──────────────────────────────────────────────

server.registerTool(
  "get_mandate",
  {
    title: "Get my mandate",
    description:
      "The limits the human set for you, and how much of them is left: balance, per-bet cap, remaining daily budget, cooldown, permitted bet types, expiry, and whether it has been revoked.",
    inputSchema: {},
  },
  async () => {
    const m = await readMandate<{
      principal: string;
      agent: string;
      game: string;
      balance: bigint;
      maxStakePerBet: bigint;
      dailyBudget: bigint;
      cooldownSeconds: bigint;
      expiry: bigint;
      allowedMarkets: number;
      revoked: boolean;
    }>("getMandate", [config.mandateId]);

    const [remainingBudget, cooldown] = await Promise.all([
      readMandate<bigint>("remainingDailyBudget", [config.mandateId]),
      readMandate<bigint>("cooldownRemaining", [config.mandateId]),
    ]);

    const allowed = Object.entries(BET_TYPE)
      .filter(([, id]) => (m.allowedMarkets & (1 << id)) !== 0)
      .map(([name]) => name);

    return text({
      mandateId: config.mandateId.toString(),
      agentAddress: config.agentAddress,
      isMyMandate: m.agent.toLowerCase() === account.address.toLowerCase(),
      game: m.game,
      // Every game read in this server targets config.game; a mandate for another game
      // would bet there while quotes and results came from here.
      gameMatchesConfig: m.game.toLowerCase() === config.game.toLowerCase(),
      active: !m.revoked && BigInt(Math.floor(Date.now() / 1000)) < m.expiry,
      revoked: m.revoked,
      expiresAt: new Date(Number(m.expiry) * 1000).toISOString(),
      balance: usd(m.balance),
      maxStakePerBet: usd(m.maxStakePerBet),
      dailyBudget: usd(m.dailyBudget),
      remainingDailyBudget: usd(remainingBudget),
      cooldownSeconds: Number(m.cooldownSeconds),
      cooldownRemainingSeconds: Number(cooldown),
      allowedBetTypes: allowed,
      note: "These limits are enforced on-chain. You cannot exceed them, and the human can revoke at any time.",
    });
  },
);

server.registerTool(
  "check_can_bet",
  {
    title: "Check whether a bet is allowed",
    description:
      "Pre-flight check against your mandate and the game. Returns a reason when refused. Always call this before place_bet, and do not retry in a loop if it refuses.",
    inputSchema: {
      bet_type: z.enum(["PICK1", "PICK2", "PICK3", "COLOR", "HILO", "RAINBOW"]),
      stake: z.number().positive().describe("Stake in USDC"),
    },
  },
  async ({ bet_type, stake }) => {
    const [ok, reason] = await readMandate<[boolean, string]>("canBet", [
      config.mandateId,
      BET_TYPE[bet_type],
      toUsdc(stake),
    ]);
    return text({ allowed: ok, reason: ok ? "ok" : reason });
  },
);

// ──────────────────────────────────────────────
//  Writes
// ──────────────────────────────────────────────

server.registerTool(
  "place_bet",
  {
    title: "Place a bet",
    description:
      "Place a bet funded by your mandate. The stake comes from the mandate's balance, never from your own wallet. Reverts if any mandate limit would be exceeded.",
    inputSchema: {
      bet_type: z.enum(["PICK1", "PICK2", "PICK3", "COLOR", "HILO", "RAINBOW"]),
      selection: z
        .array(z.union([z.number(), z.string()]))
        .describe("Same format as quote_bet."),
      stake: z.number().positive().describe("Stake in USDC"),
    },
  },
  async ({ bet_type, selection, stake }) => {
    try {
      const sel = buildSelection(bet_type, selection);
      const encoded = encodeSelection(bet_type, sel);
      const stakeWei = toUsdc(stake);

      const [ok, reason] = await readMandate<[boolean, string]>("canBet", [
        config.mandateId,
        BET_TYPE[bet_type],
        stakeWei,
      ]);
      if (!ok) return fail(`Mandate refused this bet: ${reason}`);

      const { request } = await publicClient.simulateContract({
        address: config.mandate,
        abi: ABI.mandate,
        functionName: "placeBet",
        args: [config.mandateId, BET_TYPE[bet_type], encoded, stakeWei],
        account,
      });

      const hash = await walletClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") return fail(`Transaction reverted (${hash})`);

      const [payout] = await readGame<[bigint, bigint]>("quote", [
        BET_TYPE[bet_type],
        encoded,
        stakeWei,
      ]);

      return text({
        placed: true,
        txHash: hash,
        betType: bet_type,
        selection: describeSelection(BET_TYPE[bet_type], encoded),
        stake: `$${stake.toFixed(2)}`,
        payoutIfWon: usd(payout),
        next: "Wait for the draw to settle, then call list_my_bets and claim_winnings.",
      });
    } catch (e) {
      return fail(e instanceof Error ? e.message.split("\n")[0] : String(e));
    }
  },
);

server.registerTool(
  "list_my_bets",
  {
    title: "List my bets",
    description:
      "Every bet placed under your mandate, with whether its draw has settled, whether it won, and whether the winnings have been claimed.",
    inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
  },
  async ({ limit }) => {
    const refs = await readMandate<readonly { drawId: bigint; betIndex: bigint }[]>("getMandateBets", [
      config.mandateId,
    ]);

    const recent = [...refs].slice(-limit).reverse();

    const bets = await Promise.all(
      recent.map(async (ref) => {
        const [, betType, stakeWei, sel, claimed, payout] = await readGame<
          [string, number, bigint, Hex, boolean, bigint]
        >("getBet", [ref.drawId, ref.betIndex]);
        const [, , , , , settled] = await readGame<
          [readonly number[], readonly number[], number, number, bigint, boolean]
        >("getDrawResult", [ref.drawId]);
        const won = settled
          ? await readGame<boolean>("isBetWinner", [ref.drawId, ref.betIndex])
          : false;

        return {
          drawId: ref.drawId.toString(),
          betIndex: ref.betIndex.toString(),
          betType: BET_TYPE_NAME[betType],
          selection: describeSelection(betType, sel),
          stake: usd(stakeWei),
          status: !settled ? "awaiting draw" : won ? (claimed ? "won (claimed)" : "won (claimable)") : "lost",
          payoutIfWon: usd(payout),
          claimable: settled && won && !claimed,
        };
      }),
    );

    const claimable = bets.filter((b) => b.claimable);
    return text({
      bets,
      claimableCount: claimable.length,
      totalBets: refs.length,
    });
  },
);

server.registerTool(
  "claim_winnings",
  {
    title: "Claim winnings",
    description:
      "Claim a winning bet. The payout is credited to the mandate's balance, where the human can withdraw it — it is never sent to your own wallet.",
    inputSchema: {
      draw_id: z.union([z.number(), z.string()]).describe("Draw id from list_my_bets"),
      bet_index: z.union([z.number(), z.string()]).describe("Bet index from list_my_bets"),
    },
  },
  async ({ draw_id, bet_index }) => {
    try {
      const drawId = BigInt(draw_id);
      const betIndex = BigInt(bet_index);

      const { request } = await publicClient.simulateContract({
        address: config.mandate,
        abi: ABI.mandate,
        functionName: "claim",
        args: [config.game, drawId, betIndex],
        account,
      });

      const hash = await walletClient.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") return fail(`Transaction reverted (${hash})`);

      const m = await readMandate<{ balance: bigint }>("getMandate", [config.mandateId]);
      return text({
        claimed: true,
        txHash: hash,
        newMandateBalance: usd(m.balance),
      });
    } catch (e) {
      return fail(e instanceof Error ? e.message.split("\n")[0] : String(e));
    }
  },
);

// ──────────────────────────────────────────────
//  Backtesting
// ──────────────────────────────────────────────

/** Payout multiplier for each COLOR selection (0-3 colours, 4 = Draw), read from the game. */
async function colourMultipliers(): Promise<number[]> {
  const reference = toUsdc(1);
  return Promise.all(
    [0, 1, 2, 3, 4].map(async (id) => {
      const [, multiplierBps] = await readGame<[bigint, bigint]>("quote", [
        BET_TYPE.COLOR,
        encodeSelection("COLOR", [id]),
        reference,
      ]);
      return Number(multiplierBps) / 10_000;
    }),
  );
}

/** Every settled draw currently on chain, oldest first, with its real id preserved. */
async function onChainHistory(max: number): Promise<HistoricDraw[]> {
  const current = await readGame<bigint>("currentDrawId");
  const ids: bigint[] = [];
  for (let id = current - 1n; id > 0n && ids.length < max; id--) ids.push(id);
  ids.reverse();

  const results = await Promise.all(
    ids.map(async (id) => {
      const [numbers, colourCount, sum, dominantColour, , settled] = await readGame<
        [readonly number[], readonly number[], number, number, bigint, boolean]
      >("getDrawResult", [id]);
      if (!settled) return null;
      return {
        drawId: id,
        numbers: [...numbers],
        colourCount: [...colourCount],
        sum,
        dominantColour,
      } satisfies HistoricDraw;
    }),
  );
  return results.filter((d): d is HistoricDraw => d !== null);
}

/** The same history in the shape the backtester replays. */
function toBacktestDraws(history: HistoricDraw[]): Draw[] {
  return history.map((d) => makeDraw(d.numbers));
}

server.registerTool(
  "get_signals",
  {
    title: "Get live strategy signals",
    description:
      "The indicators the player community uses — dominance, flips, double flips, hot/cold, streaks, the 'unusual draw' trick — computed from settled on-chain draws, plus the elimination rule that picks a market. Each signal reports its measured hit rate AND the rate independence predicts for the selections it backs; compare those two, not the raw hit rate. Use backtest_strategy before acting on any of them.",
    inputSchema: { window: z.number().int().min(10).max(100).default(100) },
  },
  async ({ window }) => {
    const history = await onChainHistory(100);
    if (history.length < 12) {
      return text({
        available: false,
        settledDraws: history.length,
        note: "Needs at least 12 settled draws before indicators mean anything.",
      });
    }

    const w = Math.min(window, history.length);
    // onChainHistory returns oldest-first; the indicator helpers expect newest-first.
    const newestFirst = [...history].reverse();
    const signals = detectSignals(newestFirst, w);
    const market = recommendMarket(newestFirst, w);
    const stats = colourStats(newestFirst, w);

    return text({
      window: w,
      market: { call: market.headline, rationale: market.rationale, focus: market.focus.map((i) => SELECTION_LABELS[i]) },
      selections: stats.map((c) => ({
        selection: c.label,
        wins: c.wins,
        frequency: `${(100 * c.frequency).toFixed(1)}%`,
        expected: c.expected.toFixed(1),
        sigmaFromExpected: c.sigma.toFixed(2),
        band: c.band,
        drawsSinceLastWin: c.drawsSinceLastWin,
        currentStreak: c.currentStreak,
        maxStreak: c.maxStreak,
      })),
      signals: signals.map((s) => ({
        kind: s.kind,
        backs: SELECTION_LABELS[s.selection],
        label: s.label,
        detail: s.detail,
        direction: s.direction,
        timing: s.timing,
        measuredHitRate: `${(100 * SIGNAL_STATS[s.kind].hitRate).toFixed(2)}%`,
        expectedHitRate: `${(100 * SIGNAL_STATS[s.kind].baseRate).toFixed(2)}%`,
        measuredEdge: `${(100 * (SIGNAL_STATS[s.kind].hitRate - SIGNAL_STATS[s.kind].baseRate)).toFixed(2)} pp`,
      })),
      howToRead:
        "measuredHitRate minus expectedHitRate is the signal's actual worth. Across 400,000 draws every one of these sits within a fifth of a percentage point of zero, because VRF draws are independent. A high raw hit rate usually just means the signal favours Blue or Draw, which win more often anyway.",
    });
  },
);

server.registerTool(
  "backtest_strategy",
  {
    title: "Backtest a betting strategy",
    description:
      "Run one of the circulating fast-draw colour-game strategies (hot/cold colours, flips, the 'unusual draw' 90% trick) with flat or Martingale staking, and measure what it would actually have returned. Every run is paired with a no-signal control so you can see whether the pattern-reading added anything. Use this instead of reasoning about whether a strategy works — it settles the question with numbers.",
    inputSchema: {
      strategy: z
        .enum(["unusual_draw", "hot_colour", "cold_colour", "flip", "always_draw", "fixed_colour"])
        .describe("Which strategy to test."),
      staking: z.enum(["flat", "martingale"]).default("flat"),
      martingale_levels: z
        .number()
        .int()
        .min(2)
        .max(8)
        .default(4)
        .describe("How many times to double before accepting the loss. The videos advise 3-4."),
      draws: z
        .number()
        .int()
        .min(1_000)
        .max(500_000)
        .default(100_000)
        .describe("Simulated draws to run. More draws means a tighter answer."),
      window: z.number().int().min(10).max(200).default(100).describe("Lookback window, in draws."),
      unit_stake: z.number().positive().default(1).describe("Base stake in USDC."),
      seed: z.number().int().default(1).describe("Seed, so a run is reproducible."),
    },
  },
  async ({ strategy, staking, martingale_levels, draws, window, unit_stake, seed }) => {
    try {
      const multipliers = await colourMultipliers();
      const simulated = simulateDraws(draws, seed);

      const common = {
        draws: simulated,
        staking,
        martingaleLevels: martingale_levels,
        unitStake: unit_stake,
        window,
        multipliers,
      };

      const tested = backtest({ ...common, strategy: strategy as StrategyName });
      // Control: same market and staking, no pattern-reading at all.
      const control = backtest({ ...common, strategy: "fixed_colour", fixedColour: 0 });

      // Real on-chain draws, when there are any, for provenance.
      const realHistory = await onChainHistory(200);
      const real = toBacktestDraws(realHistory);
      const onChain =
        real.length >= 20
          ? backtest({ ...common, draws: real, strategy: strategy as StrategyName })
          : null;

      const fmt = (r: ReturnType<typeof backtest>) => ({
        betsPlaced: r.betsPlaced,
        hitRate: `${(100 * r.hitRate).toFixed(2)}%`,
        turnover: `$${r.turnover.toFixed(2)}`,
        net: `$${r.net.toFixed(2)}`,
        netPercentOfTurnover: `${r.netPercentOfTurnover.toFixed(2)}% ± ${r.netPercentStdErr.toFixed(2)}`,
        maxDrawdown: `$${r.maxDrawdown.toFixed(2)}`,
        largestSingleStake: `$${r.largestSingleStake.toFixed(2)}`,
      });

      const edge = Number(await readGame<bigint>("houseEdgeBps")) / 100;
      const delta = tested.netPercentOfTurnover - control.netPercentOfTurnover;
      // Both arms are independent runs, so their errors add in quadrature.
      const deltaErr = Math.hypot(tested.netPercentStdErr, control.netPercentStdErr);
      const sigma = deltaErr > 0 ? Math.abs(delta) / deltaErr : 0;

      return text({
        strategy,
        description: STRATEGY_DESCRIPTIONS[strategy as StrategyName],
        staking: staking === "martingale" ? `martingale x2, ${martingale_levels} levels` : "flat",
        simulatedDraws: draws,
        result: fmt(tested),
        noSignalControl: fmt(control),
        onChainDraws: onChain
          ? { drawsAvailable: real.length, result: fmt(onChain) }
          : `only ${real.length} settled draws on chain so far — too few to measure, simulated results above`,
        verdict: {
          houseEdge: `${edge.toFixed(2)}%`,
          strategyVsControl: `${delta >= 0 ? "+" : ""}${delta.toFixed(2)} ± ${deltaErr.toFixed(2)} percentage points of turnover (${sigma.toFixed(1)} sigma)`,
          reading:
            sigma < 2
              ? "Indistinguishable from betting with no signal at all. The pattern-reading added nothing, which is what independent draws predict."
              : "This gap exceeds 2 sigma. Before reading anything into it, re-run with several different seeds — with independent draws it must converge to zero, and an apparent edge that moves with the seed is noise.",
          warnings: [
            "Compare net% of turnover, not hit rate. Hit rate differs only because colours have different probabilities (Draw wins ~42% of draws, a single colour ~14%); all of them lose the house edge.",
            staking === "martingale"
              ? "Martingale does not change the edge, it multiplies turnover — so it multiplies the expected loss and the drawdown. Check largestSingleStake and maxDrawdown above."
              : "Staking pattern cannot change expected value; only turnover changes.",
          ],
        },
      });
    } catch (e) {
      return fail(e instanceof Error ? e.message.split("\n")[0] : String(e));
    }
  },
);

// ──────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; anything human-facing must go to stderr.
  console.error(
    `colorcolor-agent ready — agent ${config.agentAddress}, mandate #${config.mandateId}, game ${config.game}`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
