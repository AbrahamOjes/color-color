/**
 * Backtester for the fast-draw colour-game strategy family that circulates on YouTube.
 *
 * These strategies read patterns out of past draws — dominance, flips, hot and cold streaks,
 * "unusual" draws — and stake on them, usually with a Martingale progression. ColorColor's
 * draws come from Chainlink VRF, so every draw is independent and none of that can predict
 * the next one. Rather than assert that, this module lets anyone measure it.
 *
 * Two things it is careful to get right:
 *
 *  1. Hit rate is a trap for comparing strategies. Colours do not share a probability
 *     (Draw wins 42% of the time, Red 13.7%), so a strategy that leans on Draw shows a far
 *     better hit rate while losing money at exactly the same rate. The invariant worth
 *     comparing is net as a percentage of turnover, which lands on the house edge for
 *     everything. Both are reported, and net% leads.
 *
 *  2. A strategy is only interesting if it beats betting without a signal. Every run is
 *     paired with a control that stakes on the same market with no pattern-reading at all.
 */

/** Colour ranges, matching OddsLib: Red 1-12, Yellow 13-24, Green 25-36, Blue 37-49. */
export function colourOfNumber(n: number): number {
  if (n <= 12) return 0;
  if (n <= 24) return 1;
  if (n <= 36) return 2;
  return 3;
}

export interface Draw {
  numbers: number[];
  counts: number[]; // [red, yellow, green, blue]
  dominant: number; // 0-3, or 4 for a tie ("Draw")
}

export function makeDraw(numbers: number[]): Draw {
  const counts = [0, 0, 0, 0];
  for (const n of numbers) counts[colourOfNumber(n)]++;
  const max = Math.max(...counts);
  const dominant = counts.filter((c) => c === max).length === 1 ? counts.indexOf(max) : 4;
  return { numbers: [...numbers].sort((a, b) => a - b), counts, dominant };
}

/** Deterministic PRNG so a backtest is reproducible from its seed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform 6-of-49, the same distribution the VRF path produces. */
export function simulateDraws(count: number, seed: number): Draw[] {
  const rng = mulberry32(seed);
  const out: Draw[] = [];
  for (let i = 0; i < count; i++) {
    const deck = Array.from({ length: 49 }, (_, k) => k + 1);
    const picked: number[] = [];
    for (let k = 0; k < 6; k++) {
      const idx = Math.floor(rng() * (49 - k));
      picked.push(deck[idx]);
      deck[idx] = deck[49 - k - 1];
    }
    out.push(makeDraw(picked));
  }
  return out;
}

export type StrategyName =
  | "unusual_draw"
  | "hot_colour"
  | "cold_colour"
  | "flip"
  | "double_flip"
  | "streak"
  | "always_draw"
  | "fixed_colour";

export const STRATEGY_DESCRIPTIONS: Record<StrategyName, string> = {
  unusual_draw:
    'The "90% trick": when the colour leading the 100-draw window fails to appear at all and the 49 ball is absent, bet that colour next.',
  hot_colour: "Bet whichever colour has been dominant most often in the recent window (momentum).",
  cold_colour: 'Bet whichever colour has been dominant least often recently ("due for recovery").',
  flip: 'Bet a colour in the draw after it overtakes another in the rolling window (a "flip").',
  double_flip:
    'Bet a colour that is ahead of one rival but still behind another after flipping — the videos\' "exit" pattern, tested as an entry.',
  streak: "Bet whichever colour is currently on a run of two or more consecutive wins.",
  always_draw: 'Always bet "Draw" (a tie). Control with a high hit rate and no pattern-reading.',
  fixed_colour: "Always bet the same colour. The purest control: no signal whatsoever.",
};

export type Staking = "flat" | "martingale";

export interface BacktestParams {
  draws: Draw[];
  strategy: StrategyName;
  staking: Staking;
  martingaleLevels: number;
  unitStake: number;
  window: number;
  /** Payout multiplier per selection id 0-4, read from the contract so it cannot drift. */
  multipliers: number[];
  fixedColour?: number;
}

export interface BacktestResult {
  strategy: StrategyName;
  staking: Staking;
  drawsConsidered: number;
  betsPlaced: number;
  wins: number;
  hitRate: number;
  /**
   * Hit rate independence predicts for the selections this strategy actually chose.
   *
   * Comparing a strategy's hit rate against a fixed control is misleading, because the five
   * COLOR selections do not share a probability — Blue is dominant more often than Red simply
   * because it holds thirteen numbers. A strategy that drifts toward Blue posts a better hit
   * rate with no predictive power at all. This is the number to compare against.
   */
  expectedHitRate: number;
  turnover: number;
  net: number;
  netPercentOfTurnover: number;
  /**
   * Standard error of `netPercentOfTurnover`. Essential for reading a result honestly:
   * a strategy that places few bets has wide error bars, and mistaking that spread for
   * skill (in either direction) is the same mistake the strategies themselves make.
   */
  netPercentStdErr: number;
  maxDrawdown: number;
  largestSingleStake: number;
}

/** Which selection (0-3 colour, 4 = Draw) the strategy backs before draw `i`, or null. */
function choose(params: BacktestParams, history: Draw[], i: number): number | null {
  const { strategy, window, fixedColour = 0 } = params;

  if (strategy === "always_draw") return 4;
  if (strategy === "fixed_colour") return fixedColour;

  if (i === 0) return null;
  const recent = history.slice(Math.max(0, i - window), i);
  if (recent.length < Math.min(window, 10)) return null;

  const tally = [0, 0, 0, 0];
  for (const d of recent) if (d.dominant < 4) tally[d.dominant]++;

  if (strategy === "hot_colour") return tally.indexOf(Math.max(...tally));
  if (strategy === "cold_colour") return tally.indexOf(Math.min(...tally));

  if (strategy === "unusual_draw") {
    const leader = tally.indexOf(Math.max(...tally));
    const prev = history[i - 1];
    // Signal: the leader appeared on no ball at all, and the 49 ball did not show.
    if (prev.counts[leader] === 0 && !prev.numbers.includes(49)) return leader;
    return null;
  }

  if (strategy === "streak") {
    // Whichever colour is on a live run of >= 2 at this point in history.
    let run = 0;
    const latest = history[i - 1].dominant;
    if (latest > 3) return null;
    for (let k = i - 1; k >= 0 && history[k].dominant === latest; k--) run++;
    return run >= 2 ? latest : null;
  }

  if (strategy === "double_flip") {
    const older = history.slice(Math.max(0, i - window - 1), i - 1);
    if (older.length < Math.min(window, 10)) return null;
    const before = [0, 0, 0, 0];
    for (const d of older) if (d.dominant < 4) before[d.dominant]++;
    for (let c = 0; c < 4; c++) {
      const flipped = [0, 1, 2, 3].some((o) => o !== c && before[c] <= before[o] && tally[c] > tally[o]);
      const stillBehind = [0, 1, 2, 3].some((o) => o !== c && tally[c] < tally[o]);
      if (flipped && stillBehind) return c;
    }
    return null;
  }

  if (strategy === "flip") {
    // A colour that moved ahead of another between the previous window and this one.
    const older = history.slice(Math.max(0, i - window - 1), i - 1);
    if (older.length < Math.min(window, 10)) return null;
    const before = [0, 0, 0, 0];
    for (const d of older) if (d.dominant < 4) before[d.dominant]++;
    for (let c = 0; c < 4; c++) {
      for (let o = 0; o < 4; o++) {
        if (c === o) continue;
        if (before[c] <= before[o] && tally[c] > tally[o]) return c;
      }
    }
    return null;
  }

  return null;
}

export function backtest(params: BacktestParams): BacktestResult {
  const { draws, staking, martingaleLevels, unitStake, multipliers } = params;

  let bank = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let turnover = 0;
  let bets = 0;
  let wins = 0;
  let stake = unitStake;
  let level = 0;
  let largestStake = 0;
  let sumX = 0;
  let sumX2 = 0;
  let sumExpected = 0;

  // multiplier = TOTAL*(1-edge)/winCount and p = winCount/TOTAL, so p = (1-edge)/multiplier.
  // Recovering the edge from the always-priced Draw selection keeps this exact.
  const edgeFactor = (multipliers[4] * 5_903_304) / 13_983_816;
  const probOf = (sel: number) => edgeFactor / multipliers[sel];

  for (let i = 0; i < draws.length; i++) {
    const selection = choose(params, draws, i);
    if (selection === null) continue;

    const s = staking === "flat" ? unitStake : stake;
    largestStake = Math.max(largestStake, s);
    turnover += s;
    bank -= s;
    bets++;

    const won = draws[i].dominant === selection;
    const x = won ? s * multipliers[selection] - s : -s; // this bet's net result
    sumX += x;
    sumX2 += x * x;
    sumExpected += probOf(selection);

    if (won) {
      wins++;
      bank += s * multipliers[selection];
      stake = unitStake;
      level = 0;
    } else if (staking === "martingale") {
      level++;
      // The videos cap the progression and tell you to take the loss. Modelled faithfully.
      if (level >= martingaleLevels) {
        stake = unitStake;
        level = 0;
      } else {
        stake = s * 2;
      }
    }

    peak = Math.max(peak, bank);
    maxDrawdown = Math.min(maxDrawdown, bank - peak);
  }

  // Standard error of the total, propagated onto net% of turnover.
  let netPercentStdErr = 0;
  if (bets > 1 && turnover > 0) {
    const variance = (sumX2 - (sumX * sumX) / bets) / (bets - 1);
    netPercentStdErr = (100 * Math.sqrt(Math.max(0, variance) * bets)) / turnover;
  }

  return {
    strategy: params.strategy,
    staking,
    drawsConsidered: draws.length,
    betsPlaced: bets,
    wins,
    hitRate: bets ? wins / bets : 0,
    expectedHitRate: bets ? sumExpected / bets : 0,
    turnover,
    net: bank,
    netPercentOfTurnover: turnover ? (100 * bank) / turnover : 0,
    netPercentStdErr,
    maxDrawdown,
    largestSingleStake: largestStake,
  };
}
