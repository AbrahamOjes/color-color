#!/usr/bin/env bash
#
# Mainnet smoke test: the first real VRF request -> callback -> settle -> claim cycle,
# and the first real USDC path. Run it against your own deployment only.
#
# Covers all three HILO bands at $0.50 each. Exactly one band MUST win, so the claim
# path is exercised deterministically rather than by luck.
#
# Every step checks chain state first, so the script is safe to re-run after a
# failure -- it skips what is already done. The game is open (unpaused) only for the
# three placeBet transactions; if anything fails inside that window, the EXIT trap
# pauses it again.
#
# Signs with the deployer keystore; cast prompts for its password on every send.
#
# Usage:
#   cd contracts && set -a && source .env && set +a
#   ./script/smoke-mainnet.sh
#
# Env:
#   POLYGON_RPC_URL   required (or RPC to override)
#   ACCOUNT           keystore name (default: deployer)
#   GAME              ColorColor address (required)
#   VAULT             HouseVault address (required)
#   OWNER             game owner address (required)

set -euo pipefail

RPC="${RPC:-${POLYGON_RPC_URL:?set POLYGON_RPC_URL}}"
ACCOUNT="${ACCOUNT:-deployer}"

GAME="${GAME:?set GAME to the ColorColor address}"
VAULT="${VAULT:?set VAULT to the HouseVault address}"
OWNER="${OWNER:?set OWNER to the game owner address}"
USDC=0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359   # native USDC on Polygon

HILO=4
STAKE=500000          # $0.50 per band
WITHDRAW=3000000      # $3.00 out of the vault to play with
NEED=$((STAKE * 3))
BANDS=(Lo Mid Hi)

log() { echo "[$(date +%H:%M:%S)] $*"; }
die() { log "ABORT: $*"; exit 1; }

# Retries because public Polygon RPCs drop requests under load; a read that still
# fails aborts rather than letting an empty value steer the next step.
call() {
  local out
  for _ in 1 2 3 4 5; do
    if out=$(cast call "$@" --rpc-url "$RPC" 2>/dev/null); then
      echo "$out" | awk 'NR==1{print $1}'; return 0
    fi
    sleep 2
  done
  die "read failed: $*"
}
send() {
  log "signing: $*"
  cast send "$@" --rpc-url "$RPC" --account "$ACCOUNT" >/dev/null
}
# Arrays print as "[0, 1, 2]", which call()'s first-field trim would cut short.
my_bets() { cast call $GAME "getPlayerBets(uint256,address)(uint256[])" "$1" $OWNER --rpc-url "$RPC"; }
usd() { awk -v v="$1" 'BEGIN{printf "$%.4f", v/1e6}'; }
sel() { cast to-uint256 "$1"; }

# ── Preflight ────────────────────────────────────────────────────────────────
[ "$(cast chain-id --rpc-url "$RPC")" = "137" ] || die "RPC is not Polygon mainnet"
lc() { echo "$1" | tr "[:upper:]" "[:lower:]"; }
[ "$(lc "$(call $GAME "owner()(address)")")" = "$(lc $OWNER)" ] || die "game owner is not $OWNER"
[ "$(call $GAME "drawPending()(bool)")" = "false" ] || die "a draw is already pending -- resolve it first"

draw=$(call $GAME "currentDrawId()(uint256)")
log "draw #$draw, paused=$(call $GAME "paused()(bool)"), bankroll $(usd "$(call $VAULT "bankroll()(uint256)")")"

# ── 1. Fund the deployer from the vault ──────────────────────────────────────
mine=$(call $GAME "getPlayerBets(uint256,address)(uint256[])" "$draw" $OWNER)
bal=$(call $USDC "balanceOf(address)(uint256)" $OWNER)
if [ "$mine" = "[]" ] && [ "$bal" -lt "$NEED" ]; then
  ta=$(call $VAULT "totalAssets()(uint256)")
  ts=$(call $VAULT "totalShares()(uint256)")
  shares=$(( WITHDRAW * ts / ta ))
  log "1/6 withdrawing $(usd $WITHDRAW) from the vault ($shares shares)"
  send $VAULT "withdraw(uint256)" "$shares"
  bal=$(call $USDC "balanceOf(address)(uint256)" $OWNER)
fi
log "deployer USDC: $(usd "$bal")"

# ── 2. Approve the game ──────────────────────────────────────────────────────
if [ "$mine" = "[]" ] && [ "$(call $USDC "allowance(address,address)(uint256)" $OWNER $GAME)" -lt "$NEED" ]; then
  log "2/6 approving $(usd $NEED) to the game"
  send $USDC "approve(address,uint256)" $GAME $NEED
fi

# ── 3. Open, bet all three bands, close ──────────────────────────────────────
if [ "$mine" = "[]" ]; then
  bankroll=$(call $VAULT "bankroll()(uint256)")
  allowed=$(( bankroll * $(call $GAME "maxExposureBps()(uint256)") / 10000 ))
  lo=$(call $GAME "quote(uint8,bytes32,uint256)(uint256,uint256)" $HILO "$(sel 0)" $STAKE)
  [ "$lo" -le "$allowed" ] || die "Lo payout $(usd "$lo") exceeds exposure cap $(usd "$allowed")"
  for b in 0 1 2; do
    log "quote ${BANDS[$b]}: $(usd "$(call $GAME "quote(uint8,bytes32,uint256)(uint256,uint256)" $HILO "$(sel $b)" $STAKE)")"
  done

  repause() {
    if [ "$(call $GAME "paused()(bool)")" = "false" ]; then
      log "re-pausing the game"
      send $GAME "pause()"
    fi
  }
  trap repause EXIT

  log "3/6 unpausing -- the game is OPEN until the pause below"
  send $GAME "unpause()"
  for b in 0 1 2; do
    send $GAME "placeBet(uint8,bytes32,uint256,address)" $HILO "$(sel $b)" $STAKE 0x0000000000000000000000000000000000000000
  done
  repause
  trap - EXIT
fi
[ "$(call $GAME "paused()(bool)")" = "true" ] || die "game is not paused"
log "game paused; my bets in draw #$draw: $(my_bets "$draw")"

# ── 4. Draw ──────────────────────────────────────────────────────────────────
if [ "$(call $GAME "drawPending()(bool)")" = "false" ]; then
  wait=$(call $GAME "timeUntilDraw()(uint256)")
  [ "$wait" -gt 0 ] && { log "waiting ${wait}s for the draw interval"; sleep "$wait"; }
  log "4/6 performUpkeep -- requesting VRF"
  send $GAME "performUpkeep(bytes)" 0x
fi

# ── 5. Wait for the VRF callback ─────────────────────────────────────────────
log "5/6 waiting for Chainlink VRF (normally 1-3 min)"
for i in $(seq 1 60); do
  settled=$(cast call $GAME "getDrawResult(uint256)(uint8[6],uint8[4],uint16,uint8,uint256,bool)" "$draw" --rpc-url "$RPC" 2>/dev/null | tail -1 || true)
  [ "$settled" = "true" ] && break
  sleep 10
done
[ "$settled" = "true" ] || die "draw #$draw not settled after 10 min. Check the subscription's native balance, then consider cancelPendingDraw()"

result=$(cast call $GAME "getDrawResult(uint256)(uint8[6],uint8[4],uint16,uint8,uint256,bool)" "$draw" --rpc-url "$RPC")
log "draw #$draw settled:"; echo "$result" | sed 's/^/    /'

# ── 6. Claim the winning band ────────────────────────────────────────────────
for idx in $(my_bets "$draw" | tr -d '[],'); do
  if [ "$(call $GAME "isBetWinner(uint256,uint256)(bool)" "$draw" "$idx")" = "true" ]; then
    before=$(call $USDC "balanceOf(address)(uint256)" $OWNER)
    log "6/6 bet #$idx won -- claiming"
    send $GAME "claimPrize(uint256,uint256)" "$draw" "$idx"
    after=$(call $USDC "balanceOf(address)(uint256)" $OWNER)
    log "claimed $(usd $((after - before)))"
  fi
done

log "done. bankroll $(usd "$(call $VAULT "bankroll()(uint256)")"), share price $(call $VAULT "sharePrice()(uint256)"), deployer USDC $(usd "$(call $USDC "balanceOf(address)(uint256)" $OWNER)")"
log "game is paused. VRF + USDC paths verified on mainnet."
