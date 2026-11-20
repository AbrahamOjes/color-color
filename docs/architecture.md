# Architecture and operations

How the contracts, frontend and agent fit together, and the operational traps worth knowing
before you deploy anything. For hook signatures, encodings and race maths see
[`design.md`](design.md); for the operations services in `ops/` see [`ops.md`](ops.md).

## The game

**Fixed-odds** fast-draw virtual game. Six balls from 1–49 every draw interval, four colours.

| Colour | Range | Count (of 49) |
|--------|-------|---------------|
| Red    | 1–12  | 12 |
| Yellow | 13–24 | 12 |
| Green  | 25–36 | 12 |
| Blue   | 37–49 | **13** |

Dominant colour = strict highest count among the six drawn; any tie → "Draw" (id 4).

Six bet types: PICK1, PICK2, PICK3, COLOR, HILO, RAINBOW. Chainlink VRF v2.5 supplies the
randomness.

**Payouts are fixed odds, not parimutuel.** A bet's payout is known the moment it is placed
and depends only on the bet and the result, never on what anyone else wagered.

A second game, **VirtualRace** (races of 4–12 runners), runs on the same engine. Its pricing is
described in `design.md`.

---

## The odds table

Every outcome of this game is an exact rational over the same denominator, `C(49,6) =
13,983,816`. Odds are stored as `winCount`, the number of favourable 6-ball combinations,
and all payout maths is exact integer arithmetic with **zero rounding drift**:

```
payout = stake * 13_983_816 * (10_000 - houseEdgeBps) / (winCount * 10_000)
```

| Bet | winCount | Fair mult | At 8% edge |
|---|---:|---:|---:|
| PICK1 | 1,712,304 | 8.1667x | 7.5133x |
| PICK2 | 178,365 | 78.40x | 72.13x |
| PICK3 | 15,180 | 921.20x | 847.50x |
| COLOR Red / Yellow / Green | 1,909,578 | 7.3230x | 6.7372x |
| COLOR **Blue** | 2,351,778 | **5.9461x** | 5.4704x |
| COLOR Draw (tie) | 5,903,304 | 2.3688x | 2.1793x |
| HILO **Lo** (≤120) | 2,640,092 | **5.2967x** | 4.8729x |
| HILO Mid (121–159) | 5,907,089 | 2.3673x | 2.1779x |
| HILO **Hi** (≥160) | 5,436,635 | **2.5721x** | 2.3663x |
| RAINBOW (r,y,g,b) | `C(12,r)C(12,y)C(12,g)C(13,b)` | 18.86x – 15,134x | — |

### Two asymmetries that flat odds would get wrong

1. **Blue is not like the other colours.** It spans 37–49, thirteen numbers rather than
   twelve, so it wins ~23% more often and must pay less. A uniform "any colour pays 7.32x"
   leaks money on every Blue bet.
2. **The HILO bands are not symmetric.** The sum averages 150, so `Lo ≤120` sits 30 below it
   while `Hi ≥160` sits only 10 above. Hi is more than twice as likely as Lo.

Regenerate the table with `python3 contracts/script/odds/generate.py`. It is pinned by
**partition invariants** in `test/OddsLib.t.sol`: each bet type's win counts must sum to
exactly 13,983,816, which no single mistyped constant can satisfy. These are the
highest-value tests in the repo. Mispriced odds drain the bankroll silently and without
limit, and nothing else would notice.

---

## Contracts

| Contract | Role |
|---|---|
| `src/OddsLib.sol` | Pure odds library: win counts, payout maths, selection encoding/validation |
| `src/RaceOddsLib.sol` | Race pricing: runner strengths to win/place/forecast prices |
| `src/PredictionGameBase.sol` | The engine every game inherits: rounds, VRF draws, Automation, stakes, O(1) settlement, exposure, vault, claims |
| `src/ColorColorGame.sol` | ColorColor on the engine: balls, colours, markets, packed result |
| `src/VirtualRace.sol` | Virtual races (4–12 runners) on the engine |
| `src/HouseVault.sol` | The bankroll. Share-price accounting; LPs take the other side |
| `src/AgentMandate.sol` | Bounded delegation so an autonomous agent can play (see "Agents") |
| `src/GaslessEntry.sol` | Play with USDC only: EIP-3009 signature, relayer pays the gas |
| `src/ReferralManager.sol` | Two-tier sticky referrals |

### Settlement is O(1)

Because a fixed-odds payout depends only on the bet and the result, liability is bucketed per
selection at bet time, and the winning selections implied by a result are bounded:

| Bet type | Winning selections per result |
|---|---:|
| PICK1 | 6 (the drawn numbers) |
| PICK2 | C(6,2) = 15 |
| PICK3 | C(6,3) = 20 |
| COLOR / HILO / RAINBOW | 1 each |
| **Total** | **44 lookups** |

The VRF callback never walks the bet array, so it cannot run out of gas as volume grows.
Pinned by `test_settlementGasDoesNotGrowWithBetCount`.

Settling a draw carrying 258 bets across every bet type measured **~375k gas**. That is why
`callbackGasLimit` is set to 1,000,000 rather than the 2.5M maximum: VRF reserves
`limit × gasprice` from the subscription per request, so an oversized limit inflates the
balance you must keep funded for no benefit.

**PICK2/PICK3 selections are canonicalised (sorted ascending) at bet time.** This is a
solvency requirement, not cosmetics: if `(5,3)` and `(3,5)` keyed different liability buckets,
settlement would enumerate only the sorted one and undercount what the house owes.

### Solvency

- `maxPayoutPerBet`: hard cap per bet. **Mandatory**, because the rarest RAINBOW outcome pays
  over 13,000x, so an uncapped $1 bet would obligate the house for five figures.
- `maxExposureBps`: worst-case draw liability as a fraction of the bankroll. The bound is
  `min(maxSimultaneousWinners × largestBucket, totalLiability)` per bet type. The second term
  matters: PICK3 allows 20 simultaneous winners, so without it a single backed selection is
  throttled as though 20 had been.
- `HouseVault.lockCollateral`: LPs cannot withdraw below the open draw's worst case, so a
  winner can always be paid.
- `pullLoss` **caps rather than reverts**, and every vault call inside `fulfillRandomWords`
  is wrapped in `try/catch`. That callback must not be able to revert: a revert pins
  `drawPending` high forever and bricks the game. A broken vault therefore leaves the draw
  settled and the P&L unsettled (`HouseSettlementFailed`), which the owner can repair.
  Pinned by `test_drawStillSettlesIfVaultRejectsSettlement`.
- `fulfillRandomWords` settles only the request recorded in `pendingRequestId`, and only
  once. A late callback after `cancelPendingDraw` is ignored. Pinned by
  `test/StaleFulfilment.t.sol`.

### Edge split

The house edge (default 8%) is priced into the multiplier. Of the gross stake, 2% goes to
referrals and 1% to treasury at bet time; the remainder of the edge is the vault's expected
margin. LPs carry the variance in both directions: share price falls on a losing draw and
rises on a winning one.

### Draw gating

Draws fire on the clock, but only when the open draw has at least one bet. An empty draw
would spend a VRF request to decide nothing.

---

## USDC is the only token a player needs

`src/GaslessEntry.sol` lets someone bet holding **nothing but USDC**. The player signs one
EIP-3009 authorisation off-chain (free, no wallet gas); a relayer submits it and pays the
native gas; the house recovers that from the rake it already charges.

### One signature, not two

The bet parameters must be authenticated or a hostile relayer could take the stake and back a
different selection. Rather than ask for a second signature, the bet is committed **inside the
EIP-3009 nonce**:

    nonce = keccak256(betType, selection, stake, salt)

Nonces are arbitrary caller-chosen bytes32, so this is free. `GaslessEntry` recomputes the
nonce from the parameters it was handed; change any of them and the signature stops
verifying. `salt` keeps repeat bets on the same selection distinct.

An authorisation is safe to broadcast, protected twice: the recipient is part of the signed
struct (redirecting invalidates the signature), and the token separately refuses anyone but
the named payee to submit it. Both are pinned by tests.

- The game records `msg.sender` as the bet owner, so `GaslessEntry` places the bet,
  remembers who it was really for, and pays winnings straight to that player. Same pattern
  as `AgentMandate`.
- `claimFor` is **permissionless** and reads the payout address from storage, so the relayer
  can settle winnings for a player who has no gas, and cannot divert them.
- The contract never holds a player balance between actions: stake in, payout out.

---

## Agents

`src/AgentMandate.sol` lets a human hand an autonomous agent a bounded licence to play, and
`agent/` is an MCP server so an LLM agent can drive it. The agent holds its own key and acts
unattended, but it **never holds the money**: bets are funded from the mandate and winnings
are credited back to it.

Every limit is enforced in the EVM, not by the agent: `balance`, `maxStakePerBet`,
`dailyBudget` (a fixed 24h window), `cooldownSeconds`, a per-game `allowedMarkets` bitmask,
`expiry`, and one-transaction `revoke()`. `maxStakePerBet` cannot exceed `dailyBudget`, and
every limit is emitted when set so an auditor can read it off the chain. The cooldown is the
rail that matters most in practice: without it a looping agent drains the daily budget in a
single block.

### There is no winning strategy

Draws come from VRF and payouts are fixed odds with the edge priced in, so every draw is
independent and every bet is negative expected value **by construction**. Hot/cold numbers are
gambler's fallacy; bet sizing cannot turn negative EV positive. The side of this game holding
the edge is `HouseVault`, not the player.

The MCP server states this in its `instructions` and repeats it in tool descriptions, so a
connected model does not invent a system and present it as profitable.

### Backtesting popular strategies

Fast-draw colour games attract a body of strategy content: colour dominance across
24h / 100-draw / 10-draw windows, "flips", hot and cold phases, an "unusual draw" trick
claimed at 90%, and Martingale staking. The `backtest_strategy` MCP tool settles the question
with numbers: it replays a strategy over VRF-equivalent draws, prices bets with the contract's
own multipliers, and pairs every run with a **no-signal control**.

Over 300,000 draws, every strategy lands on the house edge and every difference from the
control is inside noise (≤1σ). The claimed 90% trick hits 84.75%; betting with no signal hits
84.64%. Martingale multiplied turnover ~3.3× and worst drawdown ~12× for the same −8%. Full
table in `agent/README.md`.

Results lead with **net % of turnover, not hit rate** (colours have different probabilities,
so hit rate flatters Draw-heavy strategies while the loss rate is identical), and every figure
carries a **standard error**.

---

## Frontend

| Route | Purpose |
|---|---|
| `/` | Live hero: countdown, last result, ticker |
| `/play/[gameId]` | A game board, with the exact payout shown before betting |
| `/bets` | My bets and claiming |
| `/stats` | Statistics: frequency, last-drawn, streaks, bands, per-number grid |
| `/results` | Draw history and colour stats |
| `/vault` | Back the house |
| `/referrals` | Referral links |

The board prices every bet by calling the contract's `quote()`. **Never recompute a multiplier
in JS.** `quote` is the same code path `claimPrize` pays from, so reading it is the only way
the displayed odds cannot drift from the paid odds.

### Which chain the frontend reads

`NEXT_PUBLIC_CHAIN` selects it: `polygon` | `amoy` | `local`. **The first chain in
`Web3Provider`'s list is wagmi's default for reads with no wallet connected**, so it must match
wherever the addresses in `.env.local` live. Get it wrong and every read silently returns
nothing rather than erroring.

`local` additionally offers a **Local Test Wallet** in the connect modal: Anvil auto-unlocks its
dev accounts, so transactions are signed by the node and no browser extension is needed.

### Signals

`/stats` and the collapsible **Strategy & signals** panel on the ColorColor board show live indicators and
a Martingale staking ladder. `frontend/src/lib/signals.ts` is the engine.
**Every signal displays its measured hit rate, and expanding it shows the rate independence
predicts for the same selections.** Signals do not change how often anyone wins; the copy is
written so the product never claims otherwise.

- **Bands are computed from the real distribution.** A colour's count over 100 draws is
  13.7 ± 3.4, so the UI shows σ-from-expected alongside every figure.
- **Hit rate is compared to the right baseline.** The five COLOR outcomes have different
  probabilities, so a signal drifting toward Blue posts a better hit rate with no predictive
  power. `SIGNAL_STATS` records hit rate *and* expected rate for this reason.

`agent/src/signals.ts` is a **verbatim copy** of the frontend engine (no shared workspace).
If you change one, copy it across.

---

## Local end-to-end

```bash
anvil &
export RPC=http://127.0.0.1:8545
cd contracts
cast rpc anvil_mine 2 --rpc-url $RPC            # blockhash(block.number-1) needs a parent
forge script script/DeployTestnet.s.sol:DeployTestnetInfra --rpc-url $RPC --broadcast
# follow the printed cast commands to create + fund a subscription, then:
USDC_ADDRESS=0x... VRF_COORDINATOR=0x... VRF_SUBSCRIPTION_ID=<real id> \
  forge script script/DeployTestnet.s.sol:DeployTestnet --rpc-url $RPC --broadcast
```

Then point the frontend at it with `NEXT_PUBLIC_CHAIN=local` and the printed addresses in
`frontend/.env.local`.

### Driving draws

`performUpkeep` is permissionless, so any keeper can drive draws. `script/keeper.sh` polls
`checkUpkeep`, calls `performUpkeep`, and calls `cancelPendingDraw` after a stall. It signs
from a keystore (see [`contracts/KEYS.md`](../contracts/KEYS.md)):

```bash
COLORCOLOR_ADDRESS=0x... HOUSE_VAULT_ADDRESS=0x... AMOY_RPC_URL=http://127.0.0.1:8545 \
KEEPER_ACCOUNT=keeper KEEPER_PASSWORD_FILE=~/.foundry/keeper.pass ./script/keeper.sh
```

---

## Deployment pitfalls

These each cost a full deploy cycle during development.

### Verify every address against the chain

Config addresses that are subtly wrong (right prefix, wrong tail) look correct at a glance.
A VRF request sent with an unregistered key hash is accepted by the coordinator but **served
by nobody**, so the callback never lands. Always verify against the coordinator itself:

```bash
cast call $VRF_COORDINATOR "s_provingKeyHashes(uint256)(bytes32)" 0 --rpc-url $RPC
```

The deploy scripts assert the chain id, that USDC and the coordinator have code, that the key
hash is registered, and that the subscription exists and is owned by the deployer.

### Never read a subscription id from `getActiveSubscriptionIds`

On a public network that returns the first subscriptions on the **entire coordinator**, which
belong to strangers. It appears to work locally only because yours is the only one. Read the id
from the `SubscriptionCreated` event in your own receipt:

```bash
cast receipt <tx> --rpc-url $RPC --json | python3 -c "
import json,sys
for l in json.load(sys.stdin)['logs']:
    if len(l['topics'])==2: print(int(l['topics'][1],16))"
```

`createSubscription` derives its id from `blockhash`, so forge's simulation and the real
broadcast disagree. Create the subscription first, read the real id, then pass it to the
deploy script.

### VRF billing on native gas

`setNativePayment(true)` bills the subscription's **native balance**, not LINK. Fund it with
`fundSubscriptionWithNative` and **monitor that balance**. An empty subscription does not
fail cleanly: the coordinator charges at *fulfilment*, so the request goes out, the callback
reverts, and the draw sits `drawPending` forever. `cancelPendingDraw()` is the way out.

A bad key hash, a keeper losing track of request ids, and an unfunded subscription all
produce an identically wedged draw. Check the balance before assuming anything more exotic.

### Chainlink Automation on Amoy

Automation upkeeps on Polygon Amoy were observed never to be served, even when registered,
funded and `checkUpkeep` returned true. Use a plain keeper (`script/keeper.sh` or `ops/`).

---

## Known limitations

- **Unaudited.** Highest-risk surfaces: `OddsLib` win counts (a wrong constant is silent,
  unbounded loss), `HouseVault` share maths, the exposure bound, and the `try/catch` in
  `fulfillRandomWords` that trades a bricked draw for an unsettled P&L.
- **Single-EOA owner.** Production use would need a multisig and timelock; `setHouseVault`
  alone lets the owner repoint where losses are drawn from.
- **Risk parameters** (`maxPayoutPerBet`, `maxExposureBps`) are conservative guesses, not
  modelled against a probability of ruin.
- **No indexer.** `/results`, `/stats` and `/bets` multicall recent draws directly; `/bets`
  only looks back twelve draws.
- **No compliance layer.** There is no geo-blocking, KYC, age verification or
  responsible-gambling tooling. See the disclaimer in the root README.

---

## Key files

```
contracts/
├── KEYS.md                            # Keystore setup and key-handling rules
├── src/OddsLib.sol                    # Exact odds. Never edit without re-running generate.py
├── src/PredictionGameBase.sol         # Game engine: rounds, VRF, O(1) settlement, claims
├── src/ColorColorGame.sol             # ColorColor on the engine (balls and colours only)
├── src/VirtualRace.sol                # Virtual races on the engine
├── src/HouseVault.sol                 # Bankroll, share-price accounting
├── src/AgentMandate.sol               # Bounded delegation for autonomous agents
├── src/GaslessEntry.sol               # EIP-3009 gasless betting
├── test/OddsLib.t.sol                 # Partition invariants: the load-bearing tests
├── test/mocks/FiatTokenMock.sol       # USDC with real EIP-3009 semantics
├── script/odds/generate.py            # Regenerates and cross-checks the odds table
├── script/DeployMainnet.s.sol         # Polygon mainnet deploy, with pre-flight assertions
├── script/DeployColorColor.s.sol      # Amoy / generic deploy
├── script/DeployTestnet.s.sol         # Local, three-step
└── script/keeper.sh                   # Minimal draw driver (keystore-signed)

frontend/
├── src/games/                         # Game registry, per-game boards and hooks
├── src/lib/contracts.ts               # Addresses, ABIs, bet-type ids
├── src/lib/signals.ts                 # Strategy indicator engine
└── src/components/providers/Web3Provider.tsx   # NEXT_PUBLIC_CHAIN selection

agent/
├── src/index.ts                       # MCP server, with the no-edge framing
├── src/backtest.ts                    # Strategy backtester with error bars
├── src/signals.ts                     # VERBATIM COPY of frontend/src/lib/signals.ts
└── README.md                          # Setup + mandate-opening commands

ops/                                   # doctor, keeper, verifier, relayer (see docs/ops.md)
```
