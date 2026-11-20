// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ColorColorGame} from "../src/ColorColorGame.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {ReferralManager} from "../src/ReferralManager.sol";
import {AgentMandate} from "../src/AgentMandate.sol";

/// @notice Deploys the fixed-odds virtual game: HouseVault + ColorColor.
///
/// Reuses an existing ReferralManager by default — pass REFERRAL_MANAGER. The RM binds its
/// own immutable USDC, and a mismatch reverts every `placeBet` inside the referral cut;
/// that is precisely how the v3 deploy shipped broken. The assert below is the check that
/// would have caught it.
///
/// Usage (signs from an encrypted keystore - see contracts/KEYS.md; never a plaintext key):
///   source .env
///   export DEPLOYER=$(cast wallet address --account deployer)
///   forge script script/DeployColorColor.s.sol:DeployColorColor \
///     --rpc-url $AMOY_RPC_URL --account deployer --sender $DEPLOYER \
///     --broadcast --slow -vvvv
///
/// For mainnet use --ledger --sender <address> instead; the key never leaves the device.
///
/// BEFORE BROADCASTING, verify by hand (see docs/architecture.md, "Deployment pitfalls" — two deploys have already been
/// bricked by addresses that were right at the prefix and wrong at the tail):
///   cast code $USDC_ADDRESS --rpc-url $AMOY_RPC_URL
///   cast call $VRF_COORDINATOR "s_provingKeyHashes(uint256)(bytes32)" 0 --rpc-url $AMOY_RPC_URL
contract DeployColorColor is Script {
    /// @dev Circle's test USDC on Polygon Amoy. Overridable via USDC_ADDRESS.
    address constant USDC_AMOY = 0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582;

    /// @dev The only game this script deploys, so it may size exposure against the whole
    ///      bankroll. Drops to 6_000 when Greyhounds join the vault (Phase 5).
    uint16 constant COLORCOLOR_ALLOCATION_BPS = 10_000;

    function run() external {
        // With --account/--ledger, forge holds the key; the script only needs the address.
        address deployer = msg.sender;
        address treasury = vm.envOr("TREASURY", deployer);

        address usdc = vm.envOr("USDC_ADDRESS", USDC_AMOY);
        require(usdc.code.length > 0, "USDC_ADDRESS has no code on this chain");

        address vrfCoordinator = vm.envAddress("VRF_COORDINATOR");
        uint256 subscriptionId = vm.envUint("VRF_SUBSCRIPTION_ID");
        bytes32 keyHash = vm.envBytes32("VRF_KEY_HASH");
        uint32 callbackGasLimit = uint32(vm.envOr("VRF_CALLBACK_GAS_LIMIT", uint256(2_000_000)));
        require(callbackGasLimit <= 2_500_000, "Amoy coordinator caps callback gas at 2.5M");

        // The coordinator accepts a request under any key hash but only oracles registered
        // for a real one will serve it. An unregistered hash means the callback never lands
        // and the draw hangs forever — this is what bricked ColorColor v2.
        require(keyHash != bytes32(0), "VRF_KEY_HASH unset");

        uint256 drawInterval = vm.envOr("COLORCOLOR_DRAW_INTERVAL", uint256(180));
        uint256 houseEdgeBps = vm.envOr("COLORCOLOR_HOUSE_EDGE_BPS", uint256(800));
        uint256 maxPayoutPerBet = vm.envOr("COLORCOLOR_MAX_PAYOUT", uint256(1_000e6));
        uint256 maxExposureBps = vm.envOr("COLORCOLOR_MAX_EXPOSURE_BPS", uint256(2_000));

        console.log("=== ColorColor (fixed odds) ===");
        console.log("Deployer:       ", deployer);
        console.log("USDC:           ", usdc);
        console.log("House edge bps: ", houseEdgeBps);
        console.log("Max payout/bet: ", maxPayoutPerBet);
        console.log("Max exposure bps:", maxExposureBps);

        vm.startBroadcast();

        // ReferralManager — reuse if given, otherwise deploy fresh.
        address rm = vm.envOr("REFERRAL_MANAGER", address(0));
        if (rm == address(0)) {
            rm = address(new ReferralManager(usdc, treasury, deployer));
            console.log("ReferralManager deployed:", rm);
        } else {
            require(
                address(ReferralManager(rm).usdc()) == usdc,
                "REFERRAL_MANAGER binds a different USDC - redeploy it too"
            );
            // Reusing an RM also means calling setAuthorizedGame on it further down, which is
            // onlyOwner. Amoy's live RM is owned by a retired key, so without this check the
            // deploy gets all the way through deploying the vault and the game before
            // reverting on that call — burning the gas for both.
            require(
                ReferralManager(rm).owner() == deployer,
                "REFERRAL_MANAGER is owned by another account - cannot authorize the game; unset REFERRAL_MANAGER to deploy a fresh one"
            );
            console.log("ReferralManager reused:  ", rm);
        }

        HouseVault vault = new HouseVault(usdc, deployer);
        console.log("HouseVault deployed:     ", address(vault));

        ColorColorGame game = new ColorColorGame(
            usdc,
            vrfCoordinator,
            rm,
            address(vault),
            treasury,
            deployer,
            subscriptionId,
            keyHash,
            callbackGasLimit,
            drawInterval,
            houseEdgeBps,
            maxPayoutPerBet,
            maxExposureBps
        );
        console.log("ColorColor deployed:     ", address(game));

        vault.setAuthorizedGame(address(game), true);
        vault.setAllocation(address(game), COLORCOLOR_ALLOCATION_BPS);
        ReferralManager(rm).setAuthorizedGame(address(game), true);

        // Lets a human delegate bounded play to an autonomous agent. Needs no wiring —
        // it plays as an ordinary player, funded per mandate.
        AgentMandate agentMandate = new AgentMandate(usdc);
        console.log("AgentMandate deployed:   ", address(agentMandate));

        vm.stopBroadcast();

        console.log("");
        console.log("Next:");
        console.log("  1. Add ColorColor as a VRF consumer on subscription", subscriptionId);
        console.log("  2. Seed HouseVault with USDC - the game rejects bets against an empty bankroll");
        console.log("  3. Update frontend/.env.local, and your keeper's COLORCOLOR_ADDRESS");
    }
}
