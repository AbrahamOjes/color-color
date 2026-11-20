# Contracts

Foundry project for the game engine, the games, the house vault and the odds libraries.
See [`../docs/architecture.md`](../docs/architecture.md) for how they fit together and
[`../docs/design.md`](../docs/design.md) for the full design.

## Setup

```bash
./install-deps.sh   # pinned forge-std, OpenZeppelin and Chainlink into lib/ (git-ignored)
forge build
forge test -vvv
```

## Layout

| Path | Contents |
|---|---|
| `src/PredictionGameBase.sol` | Shared engine: rounds, VRF draws, O(1) settlement, exposure, claims |
| `src/ColorColorGame.sol`, `src/OddsLib.sol` | ColorColor and its exact odds |
| `src/VirtualRace.sol`, `src/RaceOddsLib.sol` | Virtual races and their pricing |
| `src/HouseVault.sol` | Shared bankroll with share-price accounting |
| `src/AgentMandate.sol` | Bounded on-chain delegation for autonomous agents |
| `src/GaslessEntry.sol` | EIP-3009 betting with USDC only |
| `src/ReferralManager.sol` | Two-tier referrals |
| `test/` | Foundry tests, including odds partition invariants and golden fixtures |
| `script/odds/` | `generate.py` (ColorColor) and `race.py` (race) regenerate and cross-check the odds |
| `script/Deploy*.s.sol` | Local, testnet and mainnet deploy scripts with pre-flight assertions |
| `script/keeper.sh` | Minimal draw driver |

## Changing pricing

Never edit a win count or pricing constant by hand. Regenerate with `script/odds/generate.py`
or `script/odds/race.py` and keep the partition invariants in `test/OddsLib.t.sol` green.
Mispriced odds drain the bankroll silently.

## Deploying

Read [`KEYS.md`](KEYS.md) first: deployment uses encrypted keystores (`--account`) or a
hardware wallet (`--ledger`), never a private key in a file. Copy `.env.example` to `.env` for
configuration, and read "Deployment pitfalls" in `docs/architecture.md` before deploying
anywhere but Anvil.

The contracts are **unaudited**.
