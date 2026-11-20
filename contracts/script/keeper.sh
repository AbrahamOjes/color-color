#!/usr/bin/env bash
#
# Standalone draw keeper for ColorColor.
#
# Chainlink Automation is registered on Amoy but has never served the upkeep
# (lastPerformedBlockNumber stays 0 with the upkeep funded, unpaused and
# checkUpkeep true for many minutes). performUpkeep is permissionless, so this
# polls and calls it directly. Run it instead of, or alongside, Automation --
# if the DON ever does start serving, whichever fires first simply wins and the
# other's call reverts harmlessly with NotReadyToDraw.
#
# It also recovers a draw whose VRF callback never lands: after STUCK_AFTER
# seconds of drawPending, it calls cancelPendingDraw (owner only) to re-arm.
# That is the failure mode that permanently bricked ColorColor v2.
#
# Draws fire on the clock but only when the open draw has at least one bet -- an
# empty draw would spend a VRF request to decide nothing. So idle periods showing
# "nothing to do" are expected, not a stall.
#
# Usage:
#   cd contracts && set -a && source .env && set +a
#   COLORCOLOR_ADDRESS=0x... ./script/keeper.sh
#
# Env:
#   AMOY_RPC_URL         required
#   KEEPER_ACCOUNT       keystore name to sign with (see contracts/KEYS.md)
#   KEEPER_PASSWORD_FILE file holding that keystore's password (chmod 600)
#   PRIVATE_KEY          legacy fallback - discouraged, see KEYS.md
#   COLORCOLOR_ADDRESS   required
#   HOUSE_VAULT_ADDRESS  optional; enables a bankroll warning
#   POLL_INTERVAL        seconds between checks (default 20)
#   STUCK_AFTER          seconds of drawPending before recovery (default 600)
#   NO_RECOVER=1         disable cancelPendingDraw (use if not the owner)

set -uo pipefail

: "${AMOY_RPC_URL:?set AMOY_RPC_URL}"
: "${COLORCOLOR_ADDRESS:?set COLORCOLOR_ADDRESS}"

# Signing: prefer an encrypted keystore. Give the keeper its OWN key, never the deployer's --
# performUpkeep is permissionless, so this wallet needs gas and nothing else. If it is drained
# the game keeps running; if the owner key were used here, losing it would lose the game.
if [ -n "${KEEPER_ACCOUNT:-}" ]; then
  SIGNER=(--account "$KEEPER_ACCOUNT")
  [ -n "${KEEPER_PASSWORD_FILE:-}" ] && SIGNER+=(--password-file "$KEEPER_PASSWORD_FILE")
elif [ -n "${PRIVATE_KEY:-}" ]; then
  echo "WARNING: signing with a plaintext PRIVATE_KEY. See contracts/KEYS.md -- two keys have"
  echo "         already been drained from this project that way."
  SIGNER=(--private-key "$PRIVATE_KEY")
else
  echo "set KEEPER_ACCOUNT (preferred) or PRIVATE_KEY"; exit 1
fi
POLL_INTERVAL="${POLL_INTERVAL:-20}"
STUCK_AFTER="${STUCK_AFTER:-600}"
NO_RECOVER="${NO_RECOVER:-0}"

CC="$COLORCOLOR_ADDRESS"
RPC="$AMOY_RPC_URL"

log() { echo "[$(date +%H:%M:%S)] $*"; }

# Fails closed: on RPC error the value is empty and no branch below matches,
# so a flaky endpoint means we skip a tick rather than act on garbage.
call() { cast call "$CC" "$@" --rpc-url "$RPC" 2>/dev/null | head -1; }

pending_since=0

log "keeper started on $CC (poll ${POLL_INTERVAL}s, recover after ${STUCK_AFTER}s)"

# An empty bankroll is silent but fatal: the exposure cap is a fraction of it, so
# every bet is rejected and no draw is ever armed. Surface it once at startup
# rather than leaving someone to debug "nothing happens".
if [ -n "${HOUSE_VAULT_ADDRESS:-}" ]; then
  bankroll=$(cast call "$HOUSE_VAULT_ADDRESS" "bankroll()(uint256)" --rpc-url "$RPC" 2>/dev/null | head -1 | awk '{print $1}')
  if [ -n "$bankroll" ] && [ "$bankroll" = "0" ]; then
    log "WARNING: HouseVault bankroll is 0 -- every bet will be rejected until it is seeded"
  else
    log "bankroll: ${bankroll:-unknown}"
  fi
fi

while true; do
  pending=$(call "drawPending()(bool)")
  upkeep=$(call "checkUpkeep(bytes)(bool,bytes)" 0x)

  if [ "$pending" = "true" ]; then
    now=$(date +%s)
    [ "$pending_since" -eq 0 ] && pending_since=$now
    stuck_for=$((now - pending_since))

    if [ "$stuck_for" -ge "$STUCK_AFTER" ] && [ "$NO_RECOVER" != "1" ]; then
      log "VRF callback missing for ${stuck_for}s -- calling cancelPendingDraw"
      if cast send "$CC" "cancelPendingDraw()" \
           --rpc-url "$RPC" "${SIGNER[@]}" >/dev/null 2>&1; then
        log "recovered; draw re-armed"
        pending_since=0
      else
        log "cancelPendingDraw failed (not owner?) -- will retry"
      fi
    else
      log "draw pending ${stuck_for}s, awaiting VRF"
    fi

  elif [ "$upkeep" = "true" ]; then
    pending_since=0
    draw=$(call "currentDrawId()(uint256)")
    log "draw $draw is due -- calling performUpkeep"
    if cast send "$CC" "performUpkeep(bytes)" 0x \
         --rpc-url "$RPC" "${SIGNER[@]}" >/dev/null 2>&1; then
      log "performUpkeep sent for draw $draw"
    else
      log "performUpkeep failed (raced by Automation, or out of gas funds)"
    fi

  else
    pending_since=0
  fi

  sleep "$POLL_INTERVAL"
done
