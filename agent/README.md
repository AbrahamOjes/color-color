# ColorColor agent

An MCP server that lets an autonomous agent play the ColorColor virtual game, bounded by an
on-chain mandate.

The agent holds its own key, so it can act unattended. It never holds the money: every bet is
routed through `AgentMandate`, which enforces the human's limits in the EVM. Nothing here
depends on the agent behaving well.

---

## Read this before writing a strategy

Draws come from Chainlink VRF, so every draw is statistically independent, and payouts are
fixed odds with the house edge priced into the multiplier.

**There is no edge to find and no winning strategy.**

- Hot and cold numbers are gambler's fallacy. Past draws say nothing about the next one.
- Every bet has negative expected value by construction. More analysis does not change this.
- Bet sizing — martingale and friends — cannot turn negative EV positive.

An agent that genuinely maximised expected value would decline to bet at all. That is not a
flaw in the game; it is what "provably fair" means. The side of this game that holds the edge
is the vault (`HouseVault`), not the player.

So treat an agent here as **automation under a budget**: it plays a pattern a human chose,
within limits the human set. That is exactly why the limits live on-chain and not in the
agent's prompt. The MCP server states all of this in its instructions so a connected model
does not invent a system.

---

## What the mandate enforces

Set by the principal when they open the mandate, changeable only by them:

| Limit | Purpose |
|---|---|
| `balance` | The agent can never spend money that was not deposited for it |
| `maxStakePerBet` | Caps a single bet |
| `dailyBudget` | Caps total stake per 24h window. The window is fixed, not rolling: it starts at the first bet and resets 24h later, so up to two budgets can be spent across a boundary |
| `cooldownSeconds` | Minimum gap between bets — the practical stop on a runaway loop |
| `allowedMarkets` | Bitmask over the game's markets (six ColorColor bet types, eight race markets) |
| `expiry` | The licence dies on its own |
| `revoke()` | And the principal can kill it sooner, in one transaction |

Winnings are credited back to the mandate, never to the agent's wallet. Revoking stops future
play; it does not forfeit funds or bets already in flight.

---

## Setup

```bash
cd agent
npm install
npm run build
```

The agent needs its own address funded with **gas only**. Never send it USDC — that would
defeat the whole design.

Then have the principal open a mandate (from the wallet holding the USDC):

```bash
# openMandate(agent, game, funding, maxStakePerBet, dailyBudget, cooldownSeconds, expiry, allowedMarkets, referrer)
# allowedMarkets is a uint32 bitmask over the game's markets: 63 (0x3F) = all six ColorColor
# bet types; 255 (0xFF) = all eight race markets. Bit i = market i.
# Sign from the principal's keystore (see contracts/KEYS.md); never pass a raw key.
cast send $USDC "approve(address,uint256)" $AGENT_MANDATE_ADDRESS 500000000 \
  --rpc-url $RPC_URL --account principal

cast send $AGENT_MANDATE_ADDRESS \
  "openMandate(address,address,uint256,uint256,uint256,uint256,uint64,uint32,address)" \
  $AGENT_ADDRESS $GAME_ADDRESS 500000000 25000000 100000000 60 $(($(date +%s) + 2592000)) 63 \
  0x0000000000000000000000000000000000000000 \
  --rpc-url $RPC_URL --account principal

# the id is the mandate index; the first is 0
cast call $AGENT_MANDATE_ADDRESS "mandateCount()(uint256)" --rpc-url $RPC_URL
```

That example grants: $500 funded, $25 per bet, $100 a day, one bet a minute, all bet types,
expiring in 30 days.

---

## Environment

| Variable | Required | Notes |
|---|---|---|
| `RPC_URL` | yes | |
| `CHAIN_ID` | no | 80002 (Amoy, default), 137, or 31337 |
| `AGENT_PRIVATE_KEY` | yes | The agent's own key. Gas only — no USDC. |
| `COLORCOLOR_ADDRESS` | yes | |
| `AGENT_MANDATE_ADDRESS` | yes | |
| `HOUSE_VAULT_ADDRESS` | no | |
| `MANDATE_ID` | yes | Usually `0` for the first mandate |

## Connect it to Claude Code

```json
{
  "mcpServers": {
    "colorcolor": {
      "command": "node",
      "args": ["/absolute/path/to/lotto/agent/dist/index.js"],
      "env": {
        "RPC_URL": "https://polygon-amoy.g.alchemy.com/v2/YOUR_KEY",
        "CHAIN_ID": "80002",
        "AGENT_PRIVATE_KEY": "0x...",
        "COLORCOLOR_ADDRESS": "0x...",
        "AGENT_MANDATE_ADDRESS": "0x...",
        "MANDATE_ID": "0"
      }
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `get_game_state` | Draw id, countdown, whether betting is open, house edge, payout cap |
| `get_odds` | Full multiplier table, read from the contract |
| `quote_bet` | Exact payout for a prospective bet |
| `get_recent_draws` | Settled history (for reporting, not prediction) |
| `get_mandate` | Limits and how much of them is left |
| `check_can_bet` | Pre-flight check; returns a reason when refused |
| `place_bet` | Place a bet funded by the mandate |
| `list_my_bets` | The mandate's bets with win/claim status |
| `claim_winnings` | Claim into the mandate's balance |
| `get_signals` | Live strategy indicators, each with its measured and expected hit rate |
| `backtest_strategy` | Measure what a popular fast-draw strategy would actually have returned |

Selections accept human-friendly values: `["Blue"]` or `[3]` for COLOR, `["Lo"]` for HILO,
`[7, 21]` for PICK2, `[2,1,1,2]` (R,Y,G,B summing to 6) for RAINBOW.

Agents should call `check_can_bet` before `place_bet` and respect a refusal rather than
retrying — the cooldown exists precisely to make retry loops unproductive.

## Backtesting popular strategies

There is a large body of YouTube content teaching strategies for this style of game: reading
colour dominance over 24h / 100-draw / 10-draw windows, "flips" and "double flips", hot and
cold phases, an "unusual draw" trick claimed at 90%, and Martingale staking. Players will
arrive believing these work, and an agent asked about them should not guess.

`backtest_strategy` settles it with numbers. It replays a strategy over draws with the same
distribution the VRF path produces, prices every bet with the contract's own multipliers, and
pairs the run with a **no-signal control** so you can see whether the pattern-reading added
anything. Real on-chain draws are included once enough have settled.

`get_signals` computes the same indicators the app shows players — dominance, flips, double
flips, hot/cold, streaks, the "unusual draw" trick, and the elimination rule that picks a
market — and returns each with two numbers: the hit rate it actually achieves, and the hit
rate independence predicts **for the selections it chose**.

That second number is the one that matters, and it is easy to get wrong. Judged against a
flat control, "hot colour" posts 15.17% against 13.63% — a flattering +1.5 points. But hot
colour drifts toward Blue, which is dominant more often than Red because it holds thirteen
numbers. Against its own base rate of 15.11%, the edge is **+0.06 points**. Measured across
400,000 draws every signal sits within a fifth of a point of zero:

| Signal | Fires | Hit rate | Expected | Edge |
|---|---:|---:|---:|---:|
| `unusual_draw` | 13% of draws | 15.11% | 15.13% | −0.02 pp |
| `flip` | 18% | 14.40% | 14.38% | +0.02 pp |
| `double_flip` | 12% | 14.22% | 14.20% | +0.02 pp |
| `hot` | every draw | 15.17% | 15.11% | +0.06 pp |
| `cold` | every draw | 13.84% | 13.89% | −0.06 pp |
| `streak` | 8% | 14.91% | 14.72% | +0.19 pp |

Measured over 300,000 draws (`net % of turnover`, house edge 8%):

| Strategy | Staking | Strategy | No-signal control | Difference |
|---|---|---:|---:|---:|
| `unusual_draw` (seed 1) | flat | −8.95% ± 1.10 | −7.81% ± 0.42 | −1.13 ± 1.18 (1.0σ) |
| `unusual_draw` (seed 99) | flat | −8.43% ± 1.11 | −7.96% ± 0.42 | −0.47 ± 1.19 (0.4σ) |
| `flip` | flat | −8.81% ± 0.96 | −7.81% ± 0.42 | −1.00 ± 1.05 (1.0σ) |
| `hot_colour` | martingale ×2, 4 | −8.81% ± 0.62 | −8.51% ± 0.65 | −0.30 ± 0.90 (0.3σ) |

Every strategy lands on the house edge, and every difference is inside noise — note the
"edge" moving between seeds, which is what noise looks like. Two things the tool is
deliberately careful about:

- **Read net% of turnover, not hit rate.** Colours do not share a probability (Draw is
  dominant in ~42% of draws, a single colour in ~14%), so a strategy that leans on Draw shows
  a much better hit rate while losing at exactly the same rate.
- **Error bars matter.** Strategies that bet selectively place far fewer bets and so have far
  wider bars. Mistaking that spread for skill — in either direction — is the same mistake the
  strategies make.

Martingale deserves its own note: it cannot change expected value, only turnover. In the run
above it multiplied turnover ~3.3× and the worst drawdown ~12×, for the same −8%.

## Smoke test

Verifies the wiring against a live chain and asserts the mandate actually refuses an
over-cap stake. Read-only unless you pass `--bet`.

```bash
npm run build
RPC_URL=... AGENT_PRIVATE_KEY=... COLORCOLOR_ADDRESS=... \
  AGENT_MANDATE_ADDRESS=... MANDATE_ID=0 node smoke.mjs
```

## Regenerating ABIs

`src/abi/*.json` is extracted from the Foundry build. After changing a contract:

```bash
cd ../contracts && forge build
python3 - <<'PY'
import json
for n in ["ColorColor","AgentMandate","HouseVault"]:
    abi = json.load(open(f"out/{n}.sol/{n}.json"))["abi"]
    json.dump(abi, open(f"../agent/src/abi/{n}.json","w"), indent=2)
PY
```
