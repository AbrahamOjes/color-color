# From ColorColor to a Virtual Prediction Platform

**Status:** design proposal · **Date:** 2026-10-13 · **Branch at time of writing:** `fix/colorcolor-usdc-vrf-redeploy`

This document explains how to turn ColorColor, today a single 49-ball colour game, into a platform where colours, greyhounds, horses or any other themed game can run on the same engine. It covers the architecture, the maths for racing, contract changes, frontend changes, migration, testing and a phased plan.

---

## 1. Summary

ColorColor is not built around colours. It is a **6-from-49 ball draw**, and the colours are number bands painted on top of it (Red 1–12, Yellow 13–24, Green 25–36, Blue 37–49). Every bet is priced as an exact count of winning combinations out of C(49,6) = 13,983,816.

A virtual prediction platform needs three layers kept apart:

| Layer | What it is | Status today |
|---|---|---|
| **Engine** | Rounds, VRF, Automation, USDC stakes, liability buckets, exposure caps, house vault, referrals, claims, pause | Built and battle-tested, but fused into `ColorColor.sol` |
| **Outcome model** ("game") | How a random word becomes a result, which bets exist, their exact probabilities, who won | Hardcoded in `OddsLib.sol` and in `ColorColor.sol` |
| **Skin** | Names, art, colours, result animation, copy | Hardcoded in `frontend/src/lib/colours.ts`, `Ball.tsx` and `play/page.tsx` |

The proposal:

1. Extract the engine into an abstract `PredictionGameBase`.
2. Re-express ColorColor as the first game on it, with **unchanged odds and ABI**.
3. Add a **`VirtualRace`** game: N runners with per-race "form" weights, and Win / Place / Show / Forecast / Reverse Forecast / Tricast markets, all priced exactly from the weights.
4. Make the frontend skinnable, so "Greyhounds (6 traps)", "Horses (10 runners)", "Camels", "Motorbikes" and so on are **config plus art, not new contracts**.

---

## 2. What we have today (relevant facts)

Paths are relative to the repo root.

### 2.1 Contracts

- **`contracts/src/ColorColor.sol`** (about 750 lines) is engine and game in one file.
  - `placeBet(BetType, bytes32 selection, uint256 stake, address referrer)` runs validate → canonicalize → price → book liability in `liability[drawId][type][selection]` → check worst-case exposure against `houseVault.bankroll() * maxExposureBps` → pull USDC → distribute referral (2%) and treasury (1%) cuts → `houseVault.lockCollateral(exposure)`.
  - `_worstCaseExposure` sums, per bet type, `min(maxSimultaneousWinners × maxBucket, totalLiability)`. This is game-agnostic apart from `_maxSimultaneousWinners`.
  - `checkUpkeep` / `performUpkeep` request **one** VRF v2.5 word. A draw only happens when the interval has elapsed **and** at least one bet exists, so idle games cost nothing.
  - `fulfillRandomWords` runs `_deriveNumbers` (Fisher-Yates over a 49-ball deck), works out colour counts, the sum, the dominant colour and the HILO band, then `_totalPayoutFor`. That is **44 bounded bucket lookups**, never a walk over the bets. `_settleHousePnL` is try/catch-wrapped, because **the callback must never revert** (the v2 bricking lesson).
  - Players claim their own winnings with `claimPrize` / `_isWinner`.
  - Hardcoded shapes: `uint8[6] numbers`, `uint8[4] colourCount`, `dominantColour`, `NUM_BET_TYPES = 6`, `NUMBERS_DRAWN = 6`, the `DrawSettled` event and the `getDrawResult` return type.
- **`contracts/src/OddsLib.sol`** holds:
  - the `BetType` enum (PICK1, PICK2, PICK3, COLOR, HILO, RAINBOW);
  - `validate`, `canonicalize` and `winCount`;
  - `payoutFor = stake × TOTAL × (1 − edge) / winCount`, where truncation always favours the house.
- **`contracts/src/HouseVault.sol`** already supports several games through `authorizedGames`. However:
  - ⚠️ **`lockedCollateral` is a single global value set as an absolute by whichever game called last.** A second game would overwrite the first game's lock, and LPs could withdraw collateral that backs live bets. **This must be fixed before a second game goes live** (see §6.4).
  - The exposure check in each game uses the *whole* bankroll. Two games would each believe they could risk `maxExposureBps` of it.
- **`AgentMandate.sol`** stores `allowedBetTypes` as a `uint8` bitmask over the six ColorColor types (`& 0x3F`).
- **`GaslessEntry.sol`** imports `BetType` and signs `(betType, selection, stake, salt)` payloads.

### 2.2 Frontend (Next.js 16, wagmi/viem, RainbowKit)

- `src/lib/colours.ts` is the colour names, ranges and classes.
- `src/lib/contracts.ts` mirrors the bet-type enum and reads the single address `NEXT_PUBLIC_COLORCOLOR_ADDRESS`.
- `src/hooks/useColorColor.ts` encodes and decodes selections, polls state every 4s, and reads results.
- `src/app/play/page.tsx` has the COLOR / NUMBERS / HILO / RAINBOW tabs.
- `src/components/Ball.tsx` provides `BallRow`, `BallPlaceholders` and the drop animation.
- The stats, signals and stake-planner code assumes colours throughout.
- `agent/` keeps its own copies of the ABIs and signals.

### 2.3 Operational

- Polygon mainnet deployment since 2026-08-09, currently **paused**. Because nothing is live, this is a good time for a breaking refactor.
- VRF is billed in POL at about **0.26 POL per draw**.

---

## 3. Target architecture

```
                       ┌───────────────────────────────┐
                       │          HouseVault           │  shared LP bankroll
                       │  per-game collateral + caps   │  (USDC)
                       └──────────────▲────────────────┘
                                      │ pushProfit / pullLoss / lockCollateral
          ┌───────────────────────────┼────────────────────────────┐
          │                           │                            │
┌─────────┴─────────┐     ┌───────────┴──────────┐     ┌───────────┴──────────┐
│  ColorColorGame   │     │  VirtualRace (dogs)  │     │ VirtualRace (horses) │   one deployment
│  is PredictionBase│     │  N=6, 2-min rounds   │     │ N=10, 3-min rounds   │   per game instance
└─────────┬─────────┘     └───────────┬──────────┘     └───────────┬──────────┘
          │                           │                            │
          └──────────── Chainlink VRF v2.5 + Automation ───────────┘
                         ReferralManager (shared)
```

### 3.1 Why inheritance, not pluggable external modules

There are two ways to split engine and game.

| | **A. Abstract base + concrete games (recommended)** | B. One engine calling external `IGameModule` contracts |
|---|---|---|
| VRF callback safety | All logic inline; no external calls that could revert | An external call inside `fulfillRandomWords` is a new revert surface, the exact v2 failure mode |
| Gas | Same as today | Plus a cross-contract call per price and per settlement |
| Isolation | One bad game cannot affect another's rounds | Shared state; one module bug affects every game |
| Audit scope | Base audited once; each game is a small diff | Engine, registry and every module |
| Shared VRF word | Not automatic (see §3.3) | Natural |

Option A wins on the property that matters most here: **the callback must never revert**.

### 3.2 `PredictionGameBase`: engine with template hooks

The base keeps everything currently in `ColorColor.sol` that does not mention balls or colours, and declares these hooks:

```solidity
abstract contract PredictionGameBase is VRFConsumerBaseV2Plus, AutomationCompatibleInterface,
    ReentrancyGuard, Pausable
{
    // ── Game hooks: implemented by each concrete game ──────────────────
    function numMarkets() public pure virtual returns (uint8);

    /// Reverts on an invalid selection. `drawId` lets the game read its race card.
    function _validate(uint256 drawId, uint8 market, bytes32 sel) internal view virtual;
    function _canonicalize(uint8 market, bytes32 sel) internal pure virtual returns (bytes32);

    /// Exact payout for a winning bet, after `edgeBps`. Must round DOWN.
    function _payoutFor(uint256 drawId, uint8 market, bytes32 sel, uint256 stake, uint256 edgeBps)
        internal view virtual returns (uint256);

    /// Upper bound on how many distinct selections of `market` can win on one result.
    function _maxSimultaneousWinners(uint8 market) internal pure virtual returns (uint256);

    /// Turn a VRF word into a packed result. Must be pure or bounded, and never revert.
    function _deriveOutcome(uint256 drawId, uint256 word) internal view virtual returns (bytes32 outcome);

    /// Sum liability over every winning bucket implied by `outcome`. Bounded loop; never revert.
    function _totalPayoutFor(uint256 drawId, bytes32 outcome) internal view virtual returns (uint256);

    function _isWinner(uint256 drawId, bytes32 outcome, uint8 market, bytes32 sel)
        internal view virtual returns (bool);

    /// Optional: called after settlement, e.g. to commit the next race card.
    function _afterSettle(uint256 drawId, uint256 word) internal virtual {}
}
```

Generic storage replaces the ball-shaped storage:

```solidity
struct DrawResult {
    bytes32 outcome;     // game-specific packing (balls, finishing order, …)
    uint64  timestamp;
    uint256 totalPayout;
    bool    settled;
}
event DrawSettled(uint256 indexed drawId, bytes32 outcome, uint256 totalPayout);
```

Each concrete game adds **typed views** for the frontend. For example, `ColorColorGame.getDrawResult()` keeps returning `uint8[6] numbers, uint8[4] colourCount, …` by decoding `outcome`, so existing readers keep working.

> **ABI note:** Solidity encodes an `enum` parameter as `uint8`, so changing `placeBet(BetType,…)` to `placeBet(uint8,…)` leaves the **function selector and calldata unchanged** for ColorColor. Existing frontend encoding keeps working.

### 3.3 Sharing a VRF word across games (later optimisation)

Each game requesting its own VRF word costs about 0.26 POL per settled round. Rounds with no bets do not draw, so cost scales with real activity, not with the number of games. A "DrawHub" that requests one word and fans it out with `keccak256(word, gameAddress)` would cut this cost, but it adds a cross-contract callback path. **Defer it** until VRF spend is a measurable share of revenue.

---

## 4. The `VirtualRace` game

### 4.1 Concept

Each round is a race of **N runners** (6 for greyhound "traps", 8–12 for horses). Before betting opens, every runner gets a **form weight** that is published on-chain as the **race card**. Higher weight means more likely to win, so shorter odds. Weights change every race, so there is always a favourite, some mid-field runners and some longshots. The finishing order is drawn from the next VRF word.

Nothing in the maths knows about animals. "Greyhounds", "Horses" and "Space Pods" are frontend skins over the same contract configuration (`N`, weight range and round interval).

### 4.2 Race card: committed before betting opens

- At settlement of race *n*, `_afterSettle` stores `cardSeed[n+1] = keccak256(word_n, "card")`.
- Weights are a pure function of that seed, so nothing else needs storing:

  ```
  w_i = W_MIN + uint256(keccak256(cardSeed, i)) % (W_MAX − W_MIN + 1)     for i in 0..N-1
  ```

  Example configuration: `W_MIN = 5`, `W_MAX = 40`. That gives fair win odds of roughly 2× to 30× for 6 runners. A "favourite boost" (add a bonus to one seed-chosen runner) makes cards feel more like real racing. This is a tuning choice, not a correctness one.
- **Fairness argument:**
  - The card is public the moment race *n* settles, and identical for everyone.
  - The finishing order of race *n+1* comes from a **different, future** VRF word that nobody can see while betting is open.
  - Knowing the card gives no edge beyond the published odds.
- **Bootstrap:** the first race's seed is supplied at deployment. Either the deployer runs a dry first round, or the seed is set to `keccak256(blockhash(block.number-1), address(this))`. Document this choice.

### 4.3 Drawing the finishing order (weighted sampling without replacement)

```
remaining = W  (sum of weights)
for pos in 0..N-1:
    r = uint256(keccak256(word, pos)) % remaining
    walk the not-yet-placed runners, subtracting weights, until r < w_j
    place runner j at pos; remaining -= w_j
```

- **Cost:** O(N²) with N ≤ 12 is well under 20k gas. The method mirrors the existing `_deriveNumbers` keccak-per-step pattern.
- **Modulo bias:** `remaining < 2^16` against a 256-bit draw gives bias below 2⁻²⁴⁰, which is negligible.
- **Packing:** the result is one byte per position in `outcome`. For example `0x0503010004 02…` means trap 6 won, then trap 4, then trap 2, and so on.

This is the **Plackett–Luce** model. It gives simple, exact closed-form probabilities.

### 4.4 Markets and exact probabilities

Notation: `W = Σw`, and `wᵢ` is runner *i*'s weight.

| id | Market | Wins if… | Selection encoding | P(win) | Max simultaneous winners |
|---|---|---|---|---|---|
| 0 | **WIN** | *i* finishes 1st | `i` | wᵢ / W | 1 |
| 1 | **PLACE** | *i* finishes in the top 2 | `i` | wᵢ/W + Σⱼ≠ᵢ (wⱼ/W)·(wᵢ/(W−wⱼ)) | 2 |
| 2 | **SHOW** | *i* finishes in the top 3 | `i` | sum over ordered top-3 sequences containing *i* | 3 |
| 3 | **FORECAST** | *a* 1st and *b* 2nd, exact order | `a<<8 \| b` (not sorted) | (wₐ/W)·(w_b/(W−wₐ)) | 1 |
| 4 | **REVERSE FORECAST** | *a* and *b* fill 1st and 2nd in either order | sorted `a<<8 \| b` | FC(a,b) + FC(b,a) | 1 |
| 5 | **TRICAST** | *a*, *b*, *c* finish 1st, 2nd, 3rd exactly | `a<<16 \| b<<8 \| c` | (wₐ/W)·(w_b/(W−wₐ))·(w_c/(W−wₐ−w_b)) | 1 |
| 6 | **ODD/EVEN** | winner's number (1-based) is odd / even | `0` = odd, `1` = even | Σ WIN over odd (or even) runners | 1 |
| 7 | **HI/LO** | winner's number > N/2 / ≤ N/2 | `0` = lo, `1` = hi | Σ WIN over the band | 1 |

Settlement uses at most **1 + 2 + 3 + 1 + 1 + 1 + 1 + 1 = 11 bucket lookups**, bounded and independent of volume, the same property as ColorColor's 44.

**Exact arithmetic.** WIN, FORECAST, REVERSE FORECAST, TRICAST, ODD/EVEN and HI/LO are exact rationals with small integer numerators and denominators. With `W < 2^16` all of them fit easily in `uint256`, so the payout formula keeps ColorColor's style:

```
payout = stake × den × (10_000 − edgeBps) / (num × 10_000)     // truncation favours the house
```

PLACE and SHOW sum fractions with different denominators. Compute them in **1e18 fixed point, rounding each term up**: an overestimated probability means a slightly lower payout, so rounding stays in the house's favour, at under 1e-16 relative error. SHOW is O(N²) terms, about 100 for N = 10, and is only computed in `placeBet` and `quote`, never in the callback.

### 4.5 Worked example: 6-runner greyhound card, 8% edge

Weights `[30, 22, 16, 12, 11, 9]`, so W = 100 (computed exactly by enumerating every ordering):

| Trap | Weight | P(win) | WIN pays | P(top 2) | PLACE pays | P(top 3) | SHOW pays |
|---|---|---|---|---|---|---|---|
| 1 | 30 | 30.0% | 3.07× | 54.9% | 1.67× | 74.5% | 1.24× |
| 2 | 22 | 22.0% | 4.18× | 43.5% | 2.11× | 63.4% | 1.45× |
| 3 | 16 | 16.0% | 5.75× | 33.1% | 2.78× | 51.3% | 1.79× |
| 4 | 12 | 12.0% | 7.67× | 25.5% | 3.61× | 40.9% | 2.25× |
| 5 | 11 | 11.0% | 8.36× | 23.5% | 3.91× | 38.0% | 2.42× |
| 6 | 9 | 9.0% | 10.22× | 19.5% | 4.73× | 31.9% | 2.88× |

Exotics: Forecast 1→2 pays **9.76×**, Forecast 6→5 pays **84.6×**, Tricast 1→2→3 pays **29.3×** and Tricast 6→5→4 pays **563.8×**. Every market returns 92% of stake in expectation, matching ColorColor's 8% edge.

### 4.6 Exposure

The existing bound transfers unchanged:

```
exposure = Σ_market min(maxSimultaneousWinners[market] × maxBucket[market], totalLiability[market])
```

It stays conservative because it ignores correlation between markets. For example, a Trap 1 WIN and a Trap 1→2 FORECAST can both win in the same race, and the bound simply assumes that they do. This is safe. If it proves too tight with real volume, a later version can compute the true worst case over the top-3 orderings, which is N·(N−1)·(N−2) = 720 sequences for N = 10. That is too costly per bet on-chain, but a keeper could precompute it.

### 4.7 Round timing

Real virtual racing runs a race every 2–5 minutes. Recommended settings are `drawInterval = 120s` for dogs and `180s` for horses. Remember:

- Betting closes at `drawPending` (when upkeep fires), not a fixed 10 seconds before as in many fast-draw games. Consider adding an explicit `bettingClosesAt = lastDraw + interval − CUTOFF` so the countdown matches reality.
- Cost: at 0.26 POL per settled race, a dog game with bets in every 2-minute window costs about 190 POL a day in VRF. Watch the edge-versus-VRF break-even at low volume, and consider a minimum handle per round or a longer interval during quiet hours.

---

## 5. ColorColor on the new base

`ColorColorGame is PredictionGameBase` keeps:

- `OddsLib` as is (market ids 0–5 are the same numbers as the old `BetType` values);
- `_deriveNumbers`, `_dominantColour`, `_hiloBand`, and the 44-lookup `_totalPayoutFor`, re-shaped to take `bytes32 outcome`;
- packing: `outcome = numbers[0..5] ‖ colourCount[0..3] ‖ sum(uint16) ‖ dominant`, which is 13 bytes;
- typed views (`getDrawResult` with the same return types as today) so the frontend, agent and stats pages keep working.

**Acceptance criterion:** every existing test in `contracts/test/ColorColor.t.sol` and `OddsLib.t.sol` passes **without edits to its assertions**, and the same VRF word yields the same numbers and payouts as before.

---

## 6. Contract changes in detail

### 6.1 New and changed files

| File | Change |
|---|---|
| `contracts/src/PredictionGameBase.sol` | **New.** Engine extracted from `ColorColor.sol` |
| `contracts/src/ColorColor.sol` → `ColorColorGame.sol` | Thin game over the base; ball and colour logic only |
| `contracts/src/OddsLib.sol` | Unchanged maths. `BetType` stays for readability; the base uses `uint8 market` |
| `contracts/src/VirtualRace.sol` | **New.** Race card, sampler, settlement, `_isWinner` |
| `contracts/src/RaceOddsLib.sol` | **New.** Pure pricing: exact rationals plus fixed-point PLACE/SHOW |
| `contracts/src/HouseVault.sol` | Per-game collateral and allocation (§6.4) |
| `contracts/src/AgentMandate.sol` | Game-aware mandates (§6.5) |
| `contracts/src/GaslessEntry.sol` | Game address in the signed payload (§6.5) |
| `contracts/script/DeployRace.s.sol` | **New.** Parameters: N, weight range, interval, edge, caps, skin id |

### 6.2 `VirtualRace` configuration (immutable per deployment)

```solidity
uint8   public immutable RUNNERS;     // 6 for dogs, 8–12 for horses
uint16  public immutable W_MIN;       // e.g. 5
uint16  public immutable W_MAX;       // e.g. 40
bytes32 public immutable SKIN_ID;     // "greyhounds-v1", purely informational for frontends
```

Views for the frontend:

- `raceCard(drawId) → uint16[] weights`
- `quote(drawId, market, sel, stake) → payout`
- `getRaceResult(drawId) → uint8[] order, uint256 totalPayout, bool settled`
- `replaySeed(drawId) → bytes32`, which is `keccak256(word, "replay")` and drives the animation (§7.3)

### 6.3 Invariants the race game must keep

1. `fulfillRandomWords` never reverts. All loops are bounded by `RUNNERS`, and there are no external calls outside the existing try/catch around the vault.
2. Σ over runners of P(WIN) = 1; Σ over all ordered pairs of P(FORECAST) = 1; Σ over all ordered triples of P(TRICAST) = 1. These are the race equivalent of ColorColor's "win counts sum to C(49,6)" partition tests.
3. For every runner, P(PLACE) ≤ P(SHOW), and Σ P(PLACE) = 2 and Σ P(SHOW) = 3 (up to the fixed-point rounding bound).
4. `payoutFor` ≤ `stake × (1 − edge) / P` for every market, so rounding never favours the player.
5. A selection that is invalid for the current card (runner ≥ N, duplicate runners in a forecast or tricast) reverts in `_validate`.

### 6.4 HouseVault: fix before a second game

Today `lockCollateral(amount)` sets a single global `lockedCollateral`. With two games it becomes **whichever called last**, which under-locks LP funds. Required changes:

```solidity
mapping(address => uint256) public lockedBy;      // per game
uint256 public lockedCollateral;                  // Σ lockedBy, updated incrementally
mapping(address => uint16) public allocationBps;  // share of bankroll each game may risk; Σ ≤ 10_000

function lockCollateral(uint256 amount) external onlyAuthorizedGame {
    lockedCollateral = lockedCollateral - lockedBy[msg.sender] + amount;
    lockedBy[msg.sender] = amount;
}
function gameBankroll(address game) external view returns (uint256) {
    return totalAssets * allocationBps[game] / 10_000;
}
```

Each game's exposure check then uses `houseVault.gameBankroll(address(this)) × maxExposureBps` instead of the whole bankroll. Because the vault is not upgradeable, this means a **new vault plus LP migration**. That is acceptable while mainnet is paused; do it before relaunch rather than after.

### 6.5 AgentMandate and GaslessEntry

- **AgentMandate:** a mandate needs a `game` address and a `uint32 allowedMarkets` bitmask, interpreted per game. Without the game address, a mandate approved for low-risk colour bets could be pointed at a high-variance tricast market.
- **GaslessEntry:** add the `game` address to the signed struct (EIP-712 type hash). **Otherwise a signature for market 3 on ColorColor could be replayed as market 3 (FORECAST) on VirtualRace.** This is a security fix, not a nicety.

---

## 7. Frontend

### 7.1 Structure: games as config plus components

```
frontend/src/games/
  registry.ts                 // list of game instances shown in the lobby
  colorcolor/
    config.ts                 // address env var, markets, labels
    Board.tsx                 // current play/page.tsx tabs, moved here
    Result.tsx                // BallRow
    encode.ts                 // selection encode/decode (moved from useColorColor.ts)
  race/
    config.ts                 // markets, encoders
    RaceCard.tsx              // runners, form, live odds per market
    BetSlip.tsx               // WIN/PLACE/SHOW single taps; FC/RFC/TC pickers
    Replay.tsx                // deterministic race animation
    encode.ts
  skins/
    greyhounds.ts             // 6 traps: names, trap colours (UK standard), icon, sounds
    horses.ts                 // 10 runners: names, silks, jockeys
    ...
```

A **skin** is pure data:

```ts
export const greyhounds: RaceSkin = {
  id: "greyhounds-v1",
  title: "Dog Racing",
  runners: [
    { name: "Swift Bandit", colour: "#e11d48", pattern: "solid" },
    { name: "Midnight Rex", colour: "#0f172a", pattern: "solid" },
    // … exactly RUNNERS entries; validated against the contract on load
  ],
  track: { lengthM: 480, surface: "sand" },
  replay: { durationMs: 25_000, sprite: "/skins/greyhounds/dog.webp" },
};
```

Runner names can be shuffled per race from a larger pool using the card seed, so the same names don't run every race.

### 7.2 Routing and hooks

- `/` becomes the **lobby**: each game shows its next-race countdown, a recent-results ticker and pool activity.
- `/play/[gameId]` renders that game's board. `/results/[gameId]` and `/bets` are aggregated across games.
- `useColorColor.ts` is generalised to `usePredictionGame(game)`. The 4-second polling and multicall pattern stays, and the address and ABI come from the registry. `useQuote`, `usePlayerBets` and `useClaim` are already almost game-agnostic.
- Env: `NEXT_PUBLIC_GAMES` holds a JSON or comma list of `id:address`, replacing the single `NEXT_PUBLIC_COLORCOLOR_ADDRESS`. Keep the old variable as a fallback during migration.

### 7.3 Race replay: provably fair animation

The result is final when VRF fulfills. The animation **replays** that result; it does not decide it. This is how commercial virtual sports work, except that here anyone can verify the order on-chain.

- Inputs: `finishingOrder` and `replaySeed(drawId)`.
- A seeded PRNG creates per-runner speed curves (start, mid-race surges, fades) and then **constrains them** so the finishing times are strictly ordered as on-chain. A simple approach is to give each runner a target time from its finishing position, then add seeded noise to the intermediate checkpoints only.
- Because everything comes from on-chain data, **every viewer sees the identical race**, and a shared link to "Race #4123" replays exactly.
- States:
  - *Betting open*: race card and odds.
  - *Under starter's orders*: `drawPending`, VRF in flight; trap-box animation.
  - *Running*: replay for about 25 seconds.
  - *Result*: photo-finish frame, payouts, "claim" call to action.
- Optional extras: commentary text generated from the timeline ("Midnight Rex hits the front at the bend!"), sound, and canvas or Lottie first, with 3D later if worthwhile.
- Respect `prefers-reduced-motion`: jump straight to the result board.

### 7.4 Stats and signals

`lib/signals.ts`, `stats/page.tsx`, `SignalsPanel` and `StakePlanner` are colour-specific. For races, the natural equivalents are:

- favourite win rate versus implied probability, which shows the model is honest;
- trap or position bias over the last N races, which should be flat and is a good public fairness signal;
- longest-priced winner of the day.

Keep `agent/src/signals.ts` in sync or, better, move signals into a shared package so the two copies stop drifting.

---

## 8. Beyond racing: other games on the same base

Any game fits the base if it has (a) a bounded way to turn a word into a result, (b) exact or safely rounded probabilities, and (c) a small bounded set of winning buckets per result.

| Game | Result | Markets | Notes |
|---|---|---|---|
| **Greyhounds / Horses / Cars / Camels** | weighted finishing order | §4.4 | Same `VirtualRace` contract, different config and skin |
| **Virtual football** | score (h, a) from Poisson rates on a team card | 1X2, Over/Under 2.5, BTTS, Correct Score | Truncate goals at 9 and fold the tail into "other"; probabilities from a precomputed table per team-strength pair |
| **Dice / Sic Bo** | 3 dice | Big/Small, totals, triples | Exact counts out of 216 |
| **Wheel / Roulette** | one of 37 pockets | straight, splits, colours, dozens | Exact counts out of 37 |
| **Keno** | 20 from 80 | pick-k match-m | Hypergeometric; settlement buckets grow fast, so cap k |
| **Penalty shootout** | 5 kicks each, per-kick probability | winner, exact score | Small enumerable state space |

Only racing is needed to prove the platform. Football is the strongest second candidate commercially.

---

## 9. Testing and verification

### Contracts (Foundry)

- **Regression:** the full existing suite passes unchanged against `ColorColorGame`. Add a golden test showing that a fixed VRF word produces the same numbers and the same `totalPayout` as the old contract.
- **Race pricing:** partition invariants (§6.3), fuzzed over random weight vectors and N in [4, 12].
- **Sampler fairness:** for a fixed card, run 20,000 simulated words in a Foundry test and chi-square the winner distribution against wᵢ/W. Repeat for second place against the Plackett–Luce conditional distribution.
- **Settlement:** fuzz bets across all 8 markets, settle, and assert that `totalPayout` equals the sum of the payouts of bets where `_isWinner` is true. That catches any mismatch between bucket settlement and claim logic.
- **Callback safety:** with the vault de-authorised, migrated or empty, `fulfillRandomWords` still succeeds and opens the next round.
- **Vault:** with two games locking independently, `lockedCollateral` equals the sum, and LP withdrawals respect it.
- **GaslessEntry:** a signature for game A is rejected by game B.

### Off-chain odds checker

`contracts/script/odds/race.py`, modelled on the existing `generate.py`:

- enumerates every ordering exactly with `fractions.Fraction` (N ≤ 8 brute force; above that, the closed forms);
- cross-checks `RaceOddsLib.quote` against the exact values using `cast call` on Anvil;
- prints race-card tables like §4.5 for review.

### End to end (local)

Follow `docs/architecture.md` §"Local end-to-end":

1. Deploy vault, ColorColor and two `VirtualRace` instances (dogs and horses) to Anvil with the mock VRF coordinator.
2. Run `keeper.sh` against all three.
3. In the frontend, place bets of each market, fulfil, watch the replay finish in the on-chain order, and claim.
4. Confirm LP `availableToWithdraw` reflects both games' locks.

### Mainnet smoke

Extend `smoke-mainnet.sh` to place one minimal bet per market on each game, settle, and claim, with the same address-trap checks as today.

---

## 10. Migration and rollout

Mainnet is paused, so there are no live bets to honour.

1. Deploy the new `HouseVault` (per-game collateral). Ask LPs to withdraw from the old vault and deposit into the new one, or have the owner seed the new vault if LPs are only the team today.
2. Deploy `ColorColorGame` and authorise it with an allocation of, say, 60%.
3. Deploy `VirtualRace` greyhounds with an allocation of, say, 40%. Use low caps at first (`maxPayoutPerBet`, `maxExposureBps`).
4. Register an Automation upkeep and VRF consumer for each game, and fund the subscription.
5. Release the frontend lobby behind the existing password gate for private testing.
6. Watch for two weeks: realised edge per market against the theoretical 8%, VRF cost per round against the edge earned per round, and exposure-cap rejections.
7. Add horses (a new deployment of the same contract with different config) when dogs are stable.

---

## 11. Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Vault and signature fixes** | Per-game collateral and allocation in `HouseVault`; game address in `GaslessEntry`; game-scoped `AgentMandate` | Tests for multi-game locking and cross-game replay rejection pass |
| **1. Engine extraction** | `PredictionGameBase` plus `ColorColorGame` | Existing suite green with no assertion edits; golden-word test matches |
| **2. Race contract** | `RaceOddsLib`, `VirtualRace`, deploy script, `race.py` | Partition, sampler chi-square, settlement-equals-claims and callback-safety tests green; Anvil end to end |
| **3. Frontend platform** | Game registry, lobby, `usePredictionGame`, move ColorColor into `games/colorcolor` | ColorColor UI behaves identically; lobby lists games |
| **4. Race UI** | Race card, bet slip, replay, greyhound skin | Full local loop: bet, replay, claim, for every market |
| **5. Private mainnet** | Deploy, smoke, password-gated testing | Smoke script passes; realised metrics tracked |
| **6. More skins and games** | Horses skin and deployment; then football or dice | Each new skin is config plus art only |

---

## 12. Open questions

1. **Edge per game:** keep a flat 8%, or use a higher edge on exotics (tricast) as bookmakers do? `_payoutFor` can take a per-market edge.
2. **Weight model:** uniform random weights, or "form" carried between races (a runner's weight drifts based on recent results)? The latter adds narrative but needs stored per-runner state.
3. **Persistent runners:** should "Midnight Rex" exist across races with a visible record (and maybe be an NFT later), or are names cosmetic per race?
4. **Combination bets:** multi-selection forecasts and tricasts (for example, a "box" of 4 runners) mean one bet with several winning selections. This is supportable by expanding into several liability buckets at bet time.
5. **Bet cutoff:** add an explicit `CUTOFF` before the draw to match common fast-draw UX, or keep "closes on upkeep"?
6. **Licensing:** in many jurisdictions virtual sports are a distinct licensed betting category from lotteries and number games. Confirm the relevant jurisdictions' rules before launching race skins publicly.

---

## Appendix A: Plackett–Luce probabilities

For weights `w` with sum `W`, the probability of a specific ordered prefix (r₁, r₂, …, r_k) is:

```
P = Π_{t=1..k}  w_{r_t} / (W − Σ_{s<t} w_{r_s})
```

- WIN(i) = P((i)), FORECAST(a,b) = P((a,b)), TRICAST(a,b,c) = P((a,b,c)).
- PLACE(i) = Σ over ordered pairs containing *i* of P(pair). SHOW(i) = Σ over ordered triples containing *i* of P(triple).
- Property: the probability that *i* beats *j* overall is wᵢ/(wᵢ+wⱼ), independent of the other runners. This makes the model easy to explain ("a 30-rated dog beats a 10-rated dog 3 times in 4") and easy to test.

## Appendix B: Selection encodings (race)

| Market | `bytes32` value | Canonical rule |
|---|---|---|
| WIN / PLACE / SHOW | `i` (0-based) | `i < RUNNERS` |
| FORECAST | `a<<8 \| b` | `a ≠ b`, order kept |
| REVERSE FORECAST | `min<<8 \| max` | sorted ascending |
| TRICAST | `a<<16 \| b<<8 \| c` | distinct, order kept |
| ODD/EVEN, HI/LO | `0` or `1` | — |

The frontend displays runners 1-based (Trap 1–6); the contract uses 0-based indexes.
