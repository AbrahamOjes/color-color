#!/usr/bin/env bash
# Fails when an ABI copy in frontend/ or agent/ no longer matches the Foundry build.
#
# CLAUDE.md: "When a contract ABI changes, update every copy of it." This makes the rule
# mechanical. Run `cd contracts && forge build` first. Pass --write to refresh the copies.
set -euo pipefail
cd "$(dirname "$0")/.."

write=0; [ "${1:-}" = "--write" ] && write=1

# copy path => artifact name
pairs=(
  "frontend/src/lib/abi/ColorColor.json=ColorColorGame"
  "frontend/src/lib/abi/HouseVault.json=HouseVault"
  "frontend/src/lib/abi/ReferralManager.json=ReferralManager"
  "frontend/src/lib/abi/VirtualRace.json=VirtualRace"
  "agent/src/abi/ColorColor.json=ColorColorGame"
  "agent/src/abi/AgentMandate.json=AgentMandate"
  "agent/src/abi/HouseVault.json=HouseVault"
  "agent/src/abi/VirtualRace.json=VirtualRace"
)

status=0
for pair in "${pairs[@]}"; do
  copy="${pair%%=*}"; name="${pair##*=}"
  artifact="contracts/out/${name}.sol/${name}.json"
  [ -f "$artifact" ] || { echo "missing build artifact $artifact (run forge build)"; exit 1; }
  if ! python3 -I - "$artifact" "$copy" "$write" <<'PY'
import json, sys
artifact, copy, write = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
built = json.load(open(artifact))["abi"]
canon = lambda x: json.dumps(x, sort_keys=True)
try:
    current = json.load(open(copy))
    current = current["abi"] if isinstance(current, dict) else current
except FileNotFoundError:
    current = None
if current is not None and canon(current) == canon(built):
    sys.exit(0)
if write:
    with open(copy, "w") as f:
        json.dump(built, f, indent=2); f.write("\n")
    print(f"updated {copy}")
    sys.exit(0)
print(f"ABI drift: {copy} does not match {artifact}. Run scripts/check-abi-copies.sh --write")
sys.exit(1)
PY
  then status=1; fi
done
[ $status -eq 0 ] && echo "ABI copies match the build."
exit $status
