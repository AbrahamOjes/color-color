# Operations

How the platform is run unattended, and what keeps a coding agent from running it by accident.

## Repo guardrails

`.claude/settings.json` is committed. It runs `scripts/guard-tx.sh` before every shell command
a coding agent issues and denies reads of `.env` files and the Foundry keystore. The hook
refuses, with the CLAUDE.md rule it enforces:

- `cast send`, `forge script --broadcast`, `forge create`, `keeper.sh`, `smoke-mainnet.sh`,
  `fundSubscriptionWithNative`, `--account`, `--ledger`: unless `--rpc-url` names
  `127.0.0.1` or `localhost`. A variable (`$RPC`) or no RPC at all is refused.
- `cast wallet decrypt-keystore`, `cast wallet private-key`, any mention of `.env`,
  `.env.local` or `~/.foundry/keystores`.

A deny from the hook wins over any allow in `settings.local.json`. `scripts/guard-tx.test.sh`
pins the behaviour; CI runs it. Operators run real transactions by hand, from a keystore.

Two agents live in `.claude/agents/`: `callback-verifier` re-runs the suite and probes any
contract change before a session may claim success; `odds-auditor` re-derives pricing. Both
are read-only and end with a literal `VERDICT`.

## Doctor

`cd ops && npm run doctor` checks a deployment the way the deploy scripts' assertions do,
but on demand and against the live chain. Findings are `severity / issue / fix`; any
`blocking` finding exits 1, and the services use the same call to refuse to start.

| Check | Blocking when |
|---|---|
| Chain id | RPC chain differs from `CHAIN_ID` (reads against the wrong chain return empty values, not errors) |
| Code | any configured address has no code |
| Vault wiring | game points at a different vault; game not authorised; allocation 0 bps; allocations exceed 100% |
| VRF | key hash not registered on the coordinator; subscription missing; game not a consumer; runway under 5 draws (warning under `VRF_MIN_RUNWAY_DRAWS`) |
| Keeper gas | runway under 10 transactions (warning under `KEEPER_MIN_RUNWAY_TXS`) |
| Stale-fulfilment guard | warning: game predates `pendingRequestId()`, so it must never be auto-cancelled |
| Keeper identity | warning: keeper signs with the owner key |
| ABI copies | warning: `frontend/` or `agent/` copies drift from the build |

Environment (`ops/.env.example`): `RPC_URL`, `CHAIN_ID`, `GAMES` (same shape as
`NEXT_PUBLIC_GAMES`, optionally `id:address:race`), `HOUSE_VAULT_ADDRESS`, `VRF_COORDINATOR`,
`KEEPER_ADDRESS`, thresholds.

## Stale VRF callbacks

A request cancelled with `cancelPendingDraw` can still be fulfilled later; the coordinator
does not know about the cancel. Since O0 the engine records `pendingRequestId` and
`fulfillRandomWords` ignores any other request, or any callback for a draw already settled,
emitting `StaleFulfilment` instead of settling. Before this, a late callback after an automatic
cancel re-settled the same draw: a second outcome, doubled liability and P&L, and a re-seeded
race card. The 2026-08-09 mainnet deployment predates the guard.

## Phases

O0 (these guardrails), O1 (keeper and shared runtime), O2 (agent), O3 (verifier and stats)
and O4 (relayer) are the operations phases, built in that order.
