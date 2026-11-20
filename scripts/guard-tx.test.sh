#!/usr/bin/env bash
# Exercises scripts/guard-tx.sh with the commands it must allow and block.
set -u
cd "$(dirname "$0")/.."
pass=0; fail=0
check() { # expected_exit, command
  local want=$1 cmd=$2
  printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(python3 -I -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$cmd")" \
    | ./scripts/guard-tx.sh >/dev/null 2>&1
  local got=$?
  if [ "$got" -eq "$want" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL want=$want got=$got :: $cmd"; fi
}
# allowed
check 0 'forge test -vvv'
check 0 'forge build'
check 0 'cast call 0xabc "drawPending()(bool)" --rpc-url https://polygon-rpc.com'
check 0 'cast send 0xabc "performUpkeep(bytes)" 0x --rpc-url http://127.0.0.1:8545 --private-key 0xac09'
check 0 'cast send 0xabc "f()" --rpc-url=http://localhost:8545'
check 0 'forge script script/DeployTestnet.s.sol:DeployTestnet --rpc-url http://127.0.0.1:8545 --broadcast'
check 0 'forge script script/DeployMainnet.s.sol --rpc-url https://polygon-rpc.com'
check 0 'cast rpc anvil_mine 2 --rpc-url http://127.0.0.1:8545'
check 0 'cat contracts/.env.example'
check 0 'cat frontend/.env.local.example'
check 0 'git status'
# blocked: transactions off-box
check 2 'cast send 0xabc "unpause()" --rpc-url https://polygon-rpc.com --account deployer'
check 2 'cast send 0xabc "unpause()" --rpc-url $POLYGON_RPC_URL'
check 2 'cast send 0xabc "unpause()" --rpc-url "$RPC"'
check 2 'cast send 0xabc "unpause()"'
check 2 'forge script script/DeployMainnet.s.sol --rpc-url https://polygon-rpc.com --broadcast'
check 2 'forge script script/DeployMainnet.s.sol --rpc-url $RPC --broadcast'
check 2 'cd contracts && ./script/keeper.sh'
check 2 'RPC=https://polygon-rpc.com ./script/smoke-mainnet.sh'
check 2 'cast send 0xcoord "fundSubscriptionWithNative(uint256)" 1 --value 1ether --rpc-url https://polygon-rpc.com'
check 2 'cast rpc eth_sendRawTransaction 0x.. --rpc-url https://polygon-rpc.com'
check 2 'forge create src/X.sol:X --rpc-url https://polygon-rpc.com --account deployer'
# blocked: secrets
check 2 'cat contracts/.env'
check 2 'cd contracts && set -a && source .env && set +a'
check 2 'grep PRIVATE frontend/.env.local'
check 2 'cat frontend/.env.local.amoy-backup'
check 2 'cast wallet decrypt-keystore deployer'
check 2 'cast wallet private-key --mnemonic "..."'
check 2 'ls ~/.foundry/keystores'
echo "guard-tx: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
