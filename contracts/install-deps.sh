#!/usr/bin/env bash
# Installs the pinned Foundry libraries into contracts/lib (git-ignored).
# Versions match what the suite was last green against; bump deliberately.
set -euo pipefail
cd "$(dirname "$0")"
install() { # <dir> <repo> <tag>
  if [ -d "lib/$1" ] && [ -n "$(ls -A "lib/$1" 2>/dev/null)" ]; then echo "lib/$1 present"; return; fi
  git clone --quiet --depth 1 --branch "$3" "https://github.com/$2.git" "lib/$1"
  rm -rf "lib/$1/.git"
  echo "lib/$1 <- $2@$3"
}
install forge-std                   foundry-rs/forge-std                           v1.15.0
install openzeppelin-contracts      OpenZeppelin/openzeppelin-contracts            v5.6.1
install chainlink-brownie-contracts smartcontractkit/chainlink-brownie-contracts   1.3.0
