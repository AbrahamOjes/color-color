// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VirtualRace} from "../src/VirtualRace.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {ReferralManager} from "../src/ReferralManager.sol";

/// @notice Deploys one VirtualRace instance (greyhounds by default) onto an existing
///         HouseVault and ReferralManager, then authorises it and gives it its share of
///         the bankroll. One run per skin: horses, danfo, okada and keke are the same
///         contract with different RACE_* values.
///
/// Usage (signs from an encrypted keystore - see contracts/KEYS.md; never a plaintext key):
///   source .env
///   export DEPLOYER=$(cast wallet address --account deployer)
///   HOUSE_VAULT=0x... REFERRAL_MANAGER=0x... \
///   forge script script/DeployRace.s.sol:DeployRace \
///     --rpc-url $RPC_URL --account deployer --sender $DEPLOYER --broadcast --slow -vvvv
///
/// Without --broadcast this only simulates. Phase 2 runs it against Anvil only.
///
/// The vault's allocations must leave room: with ColorColor at 10_000 bps, first drop it to
/// 6_000 (`vault.setAllocation(colorColor, 6000)`) so Greyhounds can take 4_000.
///
/// BEFORE BROADCASTING, verify by hand (see docs/architecture.md, "Deployment pitfalls"):
///   cast code $HOUSE_VAULT --rpc-url $RPC_URL
///   cast call $VRF_COORDINATOR "s_provingKeyHashes(uint256)(bytes32)" 0 --rpc-url $RPC_URL
contract DeployRace is Script {
    function run() external returns (VirtualRace race) {
        address deployer = msg.sender;
        address treasury = vm.envOr("TREASURY", deployer);

        HouseVault vault = HouseVault(vm.envAddress("HOUSE_VAULT"));
        ReferralManager rm = ReferralManager(vm.envAddress("REFERRAL_MANAGER"));
        require(address(vault).code.length > 0, "HOUSE_VAULT has no code on this chain");
        require(address(rm).code.length > 0, "REFERRAL_MANAGER has no code on this chain");

        // A vault or RM bound to a different USDC reverts every bet; that is how v3 shipped broken.
        address usdc = address(vault.usdc());
        require(address(rm.usdc()) == usdc, "HOUSE_VAULT and REFERRAL_MANAGER bind different USDC");
        require(vault.owner() == deployer, "HOUSE_VAULT is owned by another account");
        require(rm.owner() == deployer, "REFERRAL_MANAGER is owned by another account");

        address vrfCoordinator = vm.envAddress("VRF_COORDINATOR");
        uint256 subscriptionId = vm.envUint("VRF_SUBSCRIPTION_ID");
        bytes32 keyHash = vm.envBytes32("VRF_KEY_HASH");
        require(keyHash != bytes32(0), "VRF_KEY_HASH unset");
        uint32 callbackGasLimit = uint32(vm.envOr("VRF_CALLBACK_GAS_LIMIT", uint256(1_000_000)));

        VirtualRace.Config memory config = VirtualRace.Config({
            runners: uint8(vm.envOr("RACE_RUNNERS", uint256(6))),
            wMin: uint16(vm.envOr("RACE_W_MIN", uint256(5))),
            wMax: uint16(vm.envOr("RACE_W_MAX", uint256(40))),
            skinId: bytes32(bytes(vm.envOr("RACE_SKIN_ID", string("greyhounds-v1")))),
            betCutoff: vm.envOr("RACE_BET_CUTOFF", uint256(10))
        });
        uint256 drawInterval = vm.envOr("RACE_DRAW_INTERVAL", uint256(120));
        // Flat 8% on every market. A higher edge on Forecast and Tricast is an open decision;
        // set it later with setMarketEdge while no bets are open.
        uint256 houseEdgeBps = vm.envOr("RACE_HOUSE_EDGE_BPS", uint256(800));
        // Low caps until private testing ends: a $10 tricast at 564x is $5,640 of liability.
        uint256 maxPayoutPerBet = vm.envOr("RACE_MAX_PAYOUT", uint256(100e6));
        uint256 maxExposureBps = vm.envOr("RACE_MAX_EXPOSURE_BPS", uint256(1_000));
        uint16 allocationBps = uint16(vm.envOr("RACE_ALLOCATION_BPS", uint256(4_000)));

        require(
            vault.totalAllocationBps() + allocationBps <= 10_000,
            "Vault allocation full - lower another game's allocation first (ColorColor to 6000)"
        );

        console.log("=== VirtualRace ===");
        console.log("Skin:            ", string(abi.encodePacked(config.skinId)));
        console.log("Runners:         ", config.runners);
        console.log("Weights:         ", config.wMin, config.wMax);
        console.log("Interval/cutoff: ", drawInterval, config.betCutoff);
        console.log("Edge bps:        ", houseEdgeBps);
        console.log("Max payout/bet:  ", maxPayoutPerBet);
        console.log("Allocation bps:  ", allocationBps);

        vm.startBroadcast();

        race = new VirtualRace(
            usdc,
            vrfCoordinator,
            address(rm),
            address(vault),
            treasury,
            deployer,
            subscriptionId,
            keyHash,
            callbackGasLimit,
            drawInterval,
            houseEdgeBps,
            maxPayoutPerBet,
            maxExposureBps,
            config
        );
        console.log("VirtualRace deployed:", address(race));

        vault.setAuthorizedGame(address(race), true);
        vault.setAllocation(address(race), allocationBps);
        rm.setAuthorizedGame(address(race), true);

        vm.stopBroadcast();

        console.log("");
        console.log("Next:");
        console.log("  1. Add the race as a VRF consumer on subscription", subscriptionId);
        console.log("  2. Register an Automation upkeep for it");
        console.log("  3. Add it to NEXT_PUBLIC_GAMES in the frontend");
    }
}
