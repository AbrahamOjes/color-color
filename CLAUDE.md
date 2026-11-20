# Project: Virtual Prediction Platform (ColorColor → multi-game)

Read these before any contract or frontend change:
- `docs/design.md` is the technical design: hook signatures, race maths, encodings, vault changes. It is the source of truth.
- `docs/architecture.md` covers how the pieces fit, the solvency rules, local end-to-end and deployment pitfalls.
- `docs/ops.md` covers the operations services in `ops/` (doctor, keeper, verifier, relayer) and the repo guardrails.

## Hard rules
- `fulfillRandomWords` must NEVER revert. Use bounded loops only, and make no external calls outside the existing try/catch around the vault.
- All payout rounding favours the house. Never round in the player's favour.
- Settlement reads a fixed number of liability buckets. Never iterate over bets.
- ColorColor odds, ABI and results for a given VRF word must not change.
- Do not deploy to any network, and do not run scripts that send transactions (`smoke-mainnet.sh`, `keeper.sh` against a live RPC, `forge script --broadcast` to a non-local RPC). Anvil only.
- Do not edit assertions in existing tests to make them pass.
  - Setup changes are allowed when a new required parameter needs a value (for example, setting a vault allocation). Each one must be listed in the session summary.
  - If an assertion fails, fix the code, or stop and report.
- When a contract ABI changes, update every copy of it: `frontend/src/lib/abi/` and `agent/src/abi/`. `scripts/check-abi-copies.sh --write` does it; CI fails on drift.- `fulfillRandomWords` settles a draw only on the request recorded in `pendingRequestId`, and only once. Keep that guard; a late callback after `cancelPendingDraw` must be ignored, never settled.
- Any change under `contracts/src` needs a `callback-verifier` agent run (`.claude/agents/callback-verifier.md`) that ends in `VERDICT: PASS` before the session summary. Do not hand it your own test output; it runs the suite itself. Pricing changes also need `odds-auditor`.
- These rules are enforced mechanically where they can be: `.claude/settings.json` runs `scripts/guard-tx.sh` before every shell command and refuses transactions, broadcasts and key reads against anything but a local node. Do not weaken the hook to get a command through; stop and report instead.

## Commands
- Contracts: `cd contracts && forge build && forge test -vvv`
- Gas: `cd contracts && forge test --gas-report`
- Odds: `python3 contracts/script/odds/generate.py` (ColorColor); `contracts/script/odds/race.py` (race, Phase 2)
- Frontend: `cd frontend && npm run build && npm run lint`
- Ops: `cd ops && npm test`; self-check a deployment with `cd ops && npm run doctor` (needs `RPC_URL`, `CHAIN_ID`, `GAMES`)
- Guardrails: `scripts/guard-tx.test.sh`; ABI copies: `scripts/check-abi-copies.sh`

## Working style
- One change per branch, off `main`.
- Finish each session with: what changed, test results, setup edits made to existing tests, and anything left open.
- If the design doc is ambiguous or wrong, stop and ask rather than guess.
