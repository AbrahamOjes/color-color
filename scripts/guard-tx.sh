#!/usr/bin/env bash
# PreToolUse guard for Bash commands run by a coding agent in this repo.
#
# Enforces the CLAUDE.md hard rules that no tool permission can express on its own:
#   - never send a transaction or broadcast a deploy anywhere but a local Anvil node;
#   - never read, print or copy a private key or an environment file that may hold one.
#
# Input: the hook JSON on stdin ({"tool_input": {"command": "..."}}).
# Exit 0 lets the command through. Exit 2 blocks it and returns the message on stderr.
# Any other exit code is a non-blocking error, so a bug in this script fails open; keep it
# simple and keep it tested (scripts/guard-tx.test.sh).

set -u

cmd=$(python3 -I -c 'import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
ti=d.get("tool_input") or {}
print(ti.get("command","") if isinstance(ti,dict) else "")')

[ -z "$cmd" ] && exit 0

block() {
  echo "Blocked by scripts/guard-tx.sh: $1" >&2
  echo "Rule (CLAUDE.md): $2" >&2
  exit 2
}

# ── 1. Key material and env files ───────────────────────────────────────────────────────
if printf '%s' "$cmd" | grep -Eq 'cast wallet (decrypt-keystore|private-key|export|derive-private-key)'; then
  block "a command that would print a private key" \
        "No private key goes in a file, a terminal or a transcript. See contracts/KEYS.md."
fi
if printf '%s' "$cmd" | grep -Eq '(^|[^A-Za-z0-9_])\.env(\.local)?($|[^A-Za-z0-9_.])|\.env\.local\.amoy-backup|\.env\.[a-z]+\.local'; then
  block "a reference to an environment file that may hold secrets" \
        "Environment files are operator-only. Use the .example files for key names."
fi
if printf '%s' "$cmd" | grep -Eq '~/\.foundry/keystores|\.foundry/keeper\.pass|keystores/'; then
  block "a reference to the Foundry keystore directory" \
        "Keystores are operator-only; pass --account <name> and let forge/cast prompt."
fi

# ── 2. Transactions and deploys ─────────────────────────────────────────────────────────
tx_re='(^|[^A-Za-z0-9_-])(cast (send|publish|mktx|rpc)|forge script|forge create|keeper\.sh|smoke-mainnet\.sh|fundSubscriptionWithNative|--account[ =]|--ledger|--trezor|--broadcast)'
if ! printf '%s' "$cmd" | grep -Eq "$tx_re"; then
  exit 0
fi

# forge script without --broadcast only simulates; let it through.
if printf '%s' "$cmd" | grep -Eq '(^|[^A-Za-z0-9_-])forge script' \
   && ! printf '%s' "$cmd" | grep -Eq -- '--broadcast|cast send|keeper\.sh|smoke-mainnet\.sh|--account|--ledger'; then
  exit 0
fi

# Collect every RPC the command names: --rpc-url X, --rpc-url=X, -r X, RPC_URL=X, RPC=X.
rpcs=$(printf '%s' "$cmd" | grep -Eo -- '(--rpc-url[ =]|-r )[^ ]+|(RPC_URL|RPC|AMOY_RPC_URL|POLYGON_RPC_URL)=[^ ]+' \
        | sed -E 's/^(--rpc-url[ =]|-r |[A-Z_]+=)//; s/^["'"'"']//; s/["'"'"']$//')

if [ -z "$rpcs" ]; then
  block "a transaction or deploy with no explicit --rpc-url" \
        "Do not deploy to any network or send transactions. Anvil only: pass --rpc-url http://127.0.0.1:8545 explicitly."
fi

local_re='^(https?://)?(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:[0-9]+)?(/.*)?$'
while IFS= read -r rpc; do
  [ -z "$rpc" ] && continue
  if ! printf '%s' "$rpc" | grep -Eq "$local_re"; then
    block "a transaction or deploy against '$rpc'" \
          "Do not deploy to any network or send transactions. Anvil only (127.0.0.1 / localhost). Variables and remote URLs are refused; the operator runs those by hand."
  fi
done <<< "$rpcs"

exit 0
