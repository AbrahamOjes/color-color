# ColorColor

**On-chain games built for AI agents.** An LLM agent connects over MCP, holds its own key and
plays unattended, but it never holds the money. A human opens an on-chain **mandate** that
funds the agent's bets and caps what it can do, and every limit is enforced by the contract,
not by the agent's prompt.

It is a working reference for a question that matters well beyond games: **how do you let an
autonomous agent spend money without trusting it?**

## Agents under an on-chain mandate

The human (the *principal*) deposits USDC into [`AgentMandate`](contracts/src/AgentMandate.sol)
and sets the rules. The agent's wallet holds gas only. Bets are paid from the mandate, and
winnings go back to the mandate, never to the agent.

| Limit | What it stops |
|---|---|
| `balance` | Spending money that was not deposited for the agent |
| `maxStakePerBet` | One oversized bet |
| `dailyBudget` | Running through the funds in a day |
| `cooldownSeconds` | A runaway loop draining the budget in one block |
| `allowedMarkets` | Bets outside the markets the human approved |
| `expiry` + `revoke()` | A licence that outlives its welcome; one transaction ends it |

The [MCP server](agent/) exposes the game to any MCP client (Claude Code, Claude Desktop and
others): read state and odds, quote a bet, check the mandate, place bets, claim winnings, and
**backtest** a strategy. It tells the connected model plainly that there is no winning
strategy. The backtester shows it with numbers: over 300,000 simulated draws, every popular
strategy lands on the house edge, with any difference from a no-signal control inside the
noise. An agent here is automation under a budget, which is why the budget lives on-chain.

See [`agent/README.md`](agent/README.md) to connect one.

## The games

Fixed-odds virtual games on EVM chains. Draws come from Chainlink VRF, every payout is exact
integer maths over a known denominator, and settlement costs the same whether a draw carries
one bet or ten thousand. Two games run on a shared engine:

- **ColorColor**: six balls from 1–49, four colours. Bet on numbers, the dominant colour, the
  sum band (HILO) or the exact colour split (RAINBOW).
- **VirtualRace**: races of 4–12 runners with win, place, show, forecast, reverse forecast and
  tricast markets, with a 3D replay that always finishes in the on-chain order.

Liquidity providers back the house through a shared `HouseVault`, and humans can play from the
web app, betting with only USDC through EIP-3009 (`GaslessEntry`).

> [!WARNING]
> **Unaudited, experimental software, published for educational and research purposes.** It is
> not a gambling service and is not offered to anyone in any jurisdiction. Real-money betting is
> regulated almost everywhere; running these contracts with real funds may require licences,
> geo-blocking, KYC, age verification and responsible-gambling controls, none of which are
> included. There is no winning strategy: every bet is negative expected value by construction.

## Repository layout

| Path | What it is |
|---|---|
| [`agent/`](agent/) | MCP server that lets an LLM agent play under an on-chain mandate, plus a strategy backtester |
| [`contracts/`](contracts/) | Foundry project: game engine, games, mandate, vault, odds libraries, deploy scripts |
| [`frontend/`](frontend/) | Next.js app: game boards, results, stats, vault, 3D race replay |
| [`ops/`](ops/) | Operations services: deployment doctor, keeper, settlement verifier, relayer |
| [`scripts/`](scripts/) | Repo guardrails: ABI copy check, transaction guard for coding agents |
| [`docs/`](docs/) | Design and architecture |

## Quick start (local chain)

Requirements: [Foundry](https://book.getfoundry.sh/), Node 22, Python 3.

```bash
# Contracts
cd contracts
./install-deps.sh
forge build
forge test

# Odds tables match the contracts
python3 script/odds/generate.py
```

To run the whole stack against Anvil, follow
[`docs/architecture.md` → Local end-to-end](docs/architecture.md#local-end-to-end), then:

```bash
cd frontend
cp .env.local.example .env.local   # set NEXT_PUBLIC_CHAIN=local and the printed addresses
npm ci
npm run dev
```

With `NEXT_PUBLIC_CHAIN=local`, the connect modal offers a **Local Test Wallet** backed by
Anvil's unlocked accounts, so no browser extension is needed.

## How it works

- **Exact odds.** Every ColorColor outcome is a count of 6-ball combinations out of
  `C(49,6) = 13,983,816`, so payouts are exact and the tables are pinned by partition
  invariants (`contracts/test/OddsLib.t.sol`).
- **O(1) settlement.** Liability is bucketed per selection at bet time; the VRF callback reads
  a fixed 44 buckets and never iterates over bets.
- **The callback never reverts.** Vault calls in `fulfillRandomWords` are wrapped in
  `try/catch`, and only the request recorded in `pendingRequestId` can settle a draw.
- **Bounded risk.** A per-bet payout cap, a worst-case exposure limit as a fraction of the
  bankroll, and collateral locking so LPs cannot withdraw below the open draw's worst case.

Read more in [`docs/architecture.md`](docs/architecture.md) and the full technical design in
[`docs/design.md`](docs/design.md).

## Development

| Task | Command |
|---|---|
| Contracts | `cd contracts && forge build && forge test -vvv` |
| Gas report | `cd contracts && forge test --gas-report` |
| Frontend | `cd frontend && npm run lint && npm test && npm run build` |
| Agent | `cd agent && npm run typecheck` |
| Ops | `cd ops && npm test` |
| ABI copies | `scripts/check-abi-copies.sh` (`--write` to refresh) |
| Guardrails | `scripts/guard-tx.test.sh` |

When a contract ABI changes, refresh the copies in `frontend/src/lib/abi/` and
`agent/src/abi/` with `scripts/check-abi-copies.sh --write`. CI fails on drift.

Never put a private key in a file. Deployment uses encrypted Foundry keystores or a hardware
wallet; see [`contracts/KEYS.md`](contracts/KEYS.md).

## Security

See [`SECURITY.md`](SECURITY.md). Please report vulnerabilities privately.

## Licence

[MIT](LICENSE). Third-party files keep their own licences; see [`NOTICE`](NOTICE).
