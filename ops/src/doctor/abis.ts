import { parseAbi } from "viem";

/// Only the views the doctor reads. Kept inline so the checks do not depend on the ABI
/// copies they are also verifying.
export const gameAbi = parseAbi([
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function drawPending() view returns (bool)",
  "function pendingRequestId() view returns (uint256)",
  "function currentDrawId() view returns (uint256)",
  "function houseVault() view returns (address)",
  "function usdc() view returns (address)",
  "function s_subscriptionId() view returns (uint256)",
  "function s_keyHash() view returns (bytes32)",
  "function s_nativePayment() view returns (bool)",
  "function s_vrfCoordinator() view returns (address)",
  "function drawInterval() view returns (uint256)",
]);

export const vaultAbi = parseAbi([
  "function authorizedGames(address) view returns (bool)",
  "function allocationBps(address) view returns (uint16)",
  "function totalAllocationBps() view returns (uint256)",
  "function bankroll() view returns (uint256)",
  "function lockedCollateral() view returns (uint256)",
]);

export const coordinatorAbi = parseAbi([
  "function s_provingKeyHashes(uint256) view returns (bytes32)",
  "function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] consumers)",
]);
