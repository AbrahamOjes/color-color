// ⚠️ COPY OF frontend/src/lib/signals.ts — keep the two identical.
// The packages have no shared workspace, so this file is duplicated rather than imported.
// If you change one, copy it over: cp frontend/src/lib/signals.ts agent/src/signals.ts
// (then re-add these three lines).
// Indicator engine for the fast-draw strategy surface.
//
// This computes the signals the player community actually uses — dominance, flips, double
// flips, hot/cold phases, bands, streaks, the "unusual draw" trick, and the elimination rules
// that pick a market. It mirrors what players expect from a fast-draw statistics tab, plus the
// derived indicators the strategy videos teach.
//
// Every indicator here is a faithful implementation of the community method. What it is NOT
// is a predictor: draws come from Chainlink VRF and are independent, so no indicator shifts
// the odds of the next draw. That is why each signal ships with its measured hit rate and the
// base rate for the same bet — see `SIGNAL_STATS`. Showing both is the honest version of this
// feature and, for this audience, the more persuasive one: the numbers are real and checkable
// against the chain, which is something a conventional book cannot offer.

// Deliberately dependency-free so it can be copied verbatim into `agent/src/signals.ts`,
// which needs the identical indicators for the MCP surface. `colours.ts` remains the source
// of truth for how colours are rendered; this file only names them.

/** Exact probability that each COLOR selection wins, from OddsLib's win counts / C(49,6). */
export const TOTAL_COMBINATIONS = 13_983_816;
export const COLOUR_WIN_COUNTS = [1_909_578, 1_909_578, 1_909_578, 2_351_778, 5_903_304];
export const COLOUR_PROBABILITY = COLOUR_WIN_COUNTS.map((c) => c / TOTAL_COMBINATIONS);

/** Probability a specific number is among the six drawn. */
export const NUMBER_PROBABILITY = 6 / 49;

export interface HistoricDraw {
  drawId: bigint;
  numbers: number[];
  colourCount: number[];
  sum: number;
  dominantColour: number; // 0-3, or 4 for a tie ("Draw")
}

export type Band = "cold" | "low" | "normal" | "high" | "hot";

export interface ColourStat {
  id: number;
  label: string;
  /** Times this selection was the winning outcome in the window. */
  wins: number;
  frequency: number; // share of the window
  expected: number; // what independence predicts
  /** How many standard deviations from expected — the honest version of a "band". */
  sigma: number;
  band: Band;
  drawsSinceLastWin: number | null;
  currentStreak: number;
  maxStreak: number;
}

export interface NumberStat {
  n: number;
  appearances: number;
  frequency: number;
  drawsSinceSeen: number | null;
}

export type SignalKind =
  | "unusual_draw"
  | "flip"
  | "double_flip"
  | "hot"
  | "cold"
  | "streak";

export interface Signal {
  kind: SignalKind;
  /** The COLOR selection this points at (0-3, or 4 for Draw). */
  selection: number;
  label: string;
  detail: string;
  /** "entry" invites a bet; "exit" warns the run is over. */
  direction: "entry" | "exit";
  /** Draws since the signal first appeared — the videos' leading/lagging distinction. */
  age: number;
  timing: "lagging" | "leading";
}

/**
 * Measured performance of each signal — `agent/src/backtest.ts`, 400,000 draws × 3 seeds,
 * flat staking on the COLOR market.
 *
 * `hitRate` is how often the signal's bet actually won. `baseRate` is what independence
 * predicts **for the selections that signal chose**, which is the only fair comparison: the
 * five COLOR outcomes have different probabilities (Blue is dominant more often than Red,
 * because it holds thirteen numbers), so a signal that drifts toward Blue posts a higher hit
 * rate with no predictive power. Judging "hot colour" against a flat control shows a
 * flattering +1.5pp; against its own base rate the edge is +0.06pp.
 */
export const SIGNAL_STATS: Record<SignalKind, { hitRate: number; baseRate: number; fires: string }> = {
  unusual_draw: { hitRate: 0.1511, baseRate: 0.1513, fires: "~13% of draws" },
  flip: { hitRate: 0.144, baseRate: 0.1438, fires: "~18% of draws" },
  double_flip: { hitRate: 0.1422, baseRate: 0.142, fires: "~12% of draws" },
  hot: { hitRate: 0.1517, baseRate: 0.1511, fires: "every draw" },
  cold: { hitRate: 0.1384, baseRate: 0.1389, fires: "every draw" },
  streak: { hitRate: 0.1491, baseRate: 0.1472, fires: "~8% of draws" },
};

/** COLOR selection ids 0-4. Must match OddsLib's encoding. */
export const SELECTION_LABELS = ["Red", "Yellow", "Green", "Blue", "Draw"] as const;

function stdDev(p: number, n: number): number {
  return Math.sqrt(n * p * (1 - p));
}

function classify(sigma: number): Band {
  if (sigma <= -2) return "cold";
  if (sigma <= -1) return "low";
  if (sigma >= 2) return "hot";
  if (sigma >= 1) return "high";
  return "normal";
}

/**
 * Per-selection statistics over a window.
 * @param draws newest-first, as returned by useRecentDraws.
 */
export function colourStats(draws: HistoricDraw[], window = 100): ColourStat[] {
  const w = draws.slice(0, window);
  const n = w.length;

  return SELECTION_LABELS.map((label, id) => {
    const wins = w.filter((d) => d.dominantColour === id).length;
    const p = COLOUR_PROBABILITY[id];
    const expected = p * n;
    const sd = stdDev(p, n);
    const sigma = sd > 0 ? (wins - expected) / sd : 0;

    const sinceIdx = w.findIndex((d) => d.dominantColour === id);
    const drawsSinceLastWin = sinceIdx < 0 ? null : sinceIdx;

    // Streaks are read oldest-first so "current" means the run ending at the latest draw.
    const chrono = [...w].reverse();
    let maxStreak = 0;
    let run = 0;
    for (const d of chrono) {
      if (d.dominantColour === id) {
        run++;
        maxStreak = Math.max(maxStreak, run);
      } else {
        run = 0;
      }
    }
    let currentStreak = 0;
    for (const d of w) {
      if (d.dominantColour === id) currentStreak++;
      else break;
    }

    return {
      id,
      label,
      wins,
      frequency: n ? wins / n : 0,
      expected,
      sigma,
      band: classify(sigma),
      drawsSinceLastWin,
      currentStreak,
      maxStreak,
    };
  });
}

/** Per-number statistics over a window. @param draws newest-first. */
export function numberStats(draws: HistoricDraw[], window = 100): NumberStat[] {
  const w = draws.slice(0, window);
  const n = w.length;

  return Array.from({ length: 49 }, (_, i) => {
    const num = i + 1;
    const appearances = w.filter((d) => d.numbers.includes(num)).length;
    const idx = w.findIndex((d) => d.numbers.includes(num));
    return {
      n: num,
      appearances,
      frequency: n ? appearances / n : 0,
      drawsSinceSeen: idx < 0 ? null : idx,
    };
  });
}

/** Dominance ranking in a window, strongest first. @param draws newest-first. */
export function dominanceRanking(draws: HistoricDraw[], window = 100): ColourStat[] {
  return colourStats(draws, window)
    .filter((c) => c.id < 4)
    .sort((a, b) => b.wins - a.wins);
}

/** Rolling win tally per selection for the `window` draws ending `offset` draws back. */
function tallyAt(draws: HistoricDraw[], window: number, offset: number): number[] {
  const slice = draws.slice(offset, offset + window);
  const t = [0, 0, 0, 0, 0];
  for (const d of slice) t[d.dominantColour]++;
  return t;
}

/**
 * Detect the community's entry and exit signals.
 * @param draws newest-first.
 */
export function detectSignals(draws: HistoricDraw[], window = 100): Signal[] {
  const out: Signal[] = [];
  if (draws.length < 12) return out;

  const now = tallyAt(draws, window, 0);
  const prev = tallyAt(draws, window, 1);

  // ── Flips: a colour that has moved ahead of another since the previous draw.
  for (let c = 0; c < 4; c++) {
    for (let o = 0; o < 4; o++) {
      if (c === o) continue;
      if (prev[c] <= prev[o] && now[c] > now[o]) {
        // How long has it been ahead? Walk back to find when the flip happened.
        let age = 0;
        while (age < draws.length - window - 1) {
          const t = tallyAt(draws, window, age + 1);
          if (t[c] > t[o]) age++;
          else break;
        }
        out.push({
          kind: "flip",
          selection: c,
          label: `${SELECTION_LABELS[c]} flipped ${SELECTION_LABELS[o]}`,
          detail: `${SELECTION_LABELS[c]} moved ahead of ${SELECTION_LABELS[o]} in the last ${window} draws (${now[c]} v ${now[o]}).`,
          direction: "entry",
          age,
          timing: age <= 2 ? "lagging" : "leading",
        });
      }
    }
  }

  // ── Double flip: ahead of one rival, still behind another. The videos' exit signal.
  for (let c = 0; c < 4; c++) {
    const ahead = [0, 1, 2, 3].filter((o) => o !== c && now[c] > now[o]);
    const behind = [0, 1, 2, 3].filter((o) => o !== c && now[c] < now[o]);
    const flippedRecently = out.some((s) => s.kind === "flip" && s.selection === c);
    if (flippedRecently && ahead.length >= 1 && behind.length >= 1) {
      out.push({
        kind: "double_flip",
        selection: c,
        label: `${SELECTION_LABELS[c]} double flip`,
        detail: `${SELECTION_LABELS[c]} cleared ${SELECTION_LABELS[ahead[0]]} but is still behind ${SELECTION_LABELS[behind[0]]}. Traditionally read as a run running out.`,
        direction: "exit",
        age: 0,
        timing: "leading",
      });
    }
  }

  // ── Unusual draw: the window leader appeared on no ball, and the 49 did not show.
  const leader = dominanceRanking(draws, window)[0];
  const last = draws[0];
  if (leader && last.colourCount[leader.id] === 0 && !last.numbers.includes(49)) {
    out.push({
      kind: "unusual_draw",
      selection: leader.id,
      label: `${SELECTION_LABELS[leader.id]} missed entirely`,
      detail: `${SELECTION_LABELS[leader.id]} leads the last ${window} draws but appeared on no ball in draw #${last.drawId}, with no 49.`,
      direction: "entry",
      age: 0,
      timing: "lagging",
    });
  }

  // ── Hot and cold, from the short window the videos use for momentum.
  const short = colourStats(draws, Math.min(10, draws.length)).filter((c) => c.id < 4);
  const hot = [...short].sort((a, b) => b.wins - a.wins)[0];
  const cold = [...short].sort((a, b) => a.wins - b.wins)[0];

  if (hot && hot.wins > 0) {
    out.push({
      kind: "hot",
      selection: hot.id,
      label: `${SELECTION_LABELS[hot.id]} running hot`,
      detail: `${hot.wins} of the last ${Math.min(10, draws.length)} draws.`,
      direction: "entry",
      age: 0,
      timing: "leading",
    });
  }
  if (cold && cold.id !== hot?.id) {
    const stat = colourStats(draws, window).find((c) => c.id === cold.id);
    out.push({
      kind: "cold",
      selection: cold.id,
      label: `${SELECTION_LABELS[cold.id]} gone cold`,
      detail: `${cold.wins} of the last ${Math.min(10, draws.length)} draws; ${stat?.drawsSinceLastWin ?? "many"} since it last won.`,
      direction: "entry",
      age: 0,
      timing: "leading",
    });
  }

  // ── Live streak.
  const streaking = colourStats(draws, window).find((c) => c.currentStreak >= 2);
  if (streaking) {
    out.push({
      kind: "streak",
      selection: streaking.id,
      label: `${SELECTION_LABELS[streaking.id]} on a ${streaking.currentStreak} streak`,
      detail: `Best run in this window is ${streaking.maxStreak}.`,
      direction: "entry",
      age: streaking.currentStreak,
      timing: streaking.currentStreak <= 2 ? "lagging" : "leading",
    });
  }

  return out;
}

export interface MarketRecommendation {
  market: "winning_colour" | "single_colour" | "wait";
  eliminated: number[];
  focus: number[];
  headline: string;
  rationale: string;
}

/**
 * The elimination rule the videos use to pick a market: eliminate weak colours, and let the
 * count of survivors choose how you play.
 * @param draws newest-first.
 */
export function recommendMarket(draws: HistoricDraw[], window = 100): MarketRecommendation {
  const stats = colourStats(draws, window).filter((c) => c.id < 4);
  const eliminated = stats.filter((c) => c.sigma <= -1).map((c) => c.id);
  const focus = stats.filter((c) => c.sigma >= 1).map((c) => c.id);

  if (eliminated.length >= 2 && focus.length >= 1) {
    return {
      market: "single_colour",
      eliminated,
      focus,
      headline: `Back ${focus.map((i) => SELECTION_LABELS[i]).join(" / ")}`,
      rationale: `${eliminated.length} colours are running below their expected rate in the last ${window} draws, leaving ${focus.map((i) => SELECTION_LABELS[i]).join(" and ")} on top.`,
    };
  }

  if (eliminated.length === 1) {
    const survivors = stats.filter((c) => !eliminated.includes(c.id)).map((c) => c.id);
    return {
      market: "winning_colour",
      eliminated,
      focus: survivors,
      headline: `Drop ${SELECTION_LABELS[eliminated[0]]}, play the rest`,
      rationale: `${SELECTION_LABELS[eliminated[0]]} is below its expected rate. The classic play is to cover ${survivors.map((i) => SELECTION_LABELS[i]).join(", ")} and Draw.`,
    };
  }

  return {
    market: "wait",
    eliminated,
    focus,
    headline: "No clean setup",
    rationale: `Every colour is inside its normal range over the last ${window} draws — nothing to eliminate.`,
  };
}

// ──────────────────────────────────────────────
//  Martingale staking
// ──────────────────────────────────────────────

export interface StakePlan {
  level: number;
  nextStake: number;
  committed: number;
  /** Total staked if every remaining level also loses. */
  worstCaseExposure: number;
  atLimit: boolean;
  /** Payout needed for the sequence to come out ahead. */
  breakEvenPayout: number;
}

/**
 * The staking ladder the strategy videos teach: double after a loss, reset on a win, and stop
 * after `maxLevels`.
 *
 * The exposure figures are not decoration. Doubling does not change expected value — it
 * multiplies turnover, and every unit staked carries the house edge — so the honest way to
 * present this is with the committed and worst-case numbers in view.
 */
export function martingalePlan(
  baseStake: number,
  level: number,
  maxLevels = 4,
  multiplier = 1,
): StakePlan {
  const clamped = Math.max(0, Math.min(level, maxLevels));
  const nextStake = baseStake * 2 ** clamped;

  let committed = 0;
  for (let i = 0; i < clamped; i++) committed += baseStake * 2 ** i;

  let worstCase = committed;
  for (let i = clamped; i < maxLevels; i++) worstCase += baseStake * 2 ** i;

  return {
    level: clamped,
    nextStake,
    committed,
    worstCaseExposure: worstCase,
    atLimit: clamped >= maxLevels,
    breakEvenPayout: multiplier > 0 ? (committed + nextStake) / multiplier : 0,
  };
}
