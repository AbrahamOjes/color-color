// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ColorColorGame} from "../src/ColorColorGame.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {ReferralManager} from "../src/ReferralManager.sol";
import {AgentMandate} from "../src/AgentMandate.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";

/// @notice Step 1 of the local deployment: mock USDC and a mock VRF coordinator.
///
/// The subscription is deliberately NOT created here. `createSubscription()` derives its id
/// from `blockhash(block.number - 1)`, which differs between forge's simulation and the real
/// broadcast — so the id the script sees is not the id that ends up on chain, and wiring the
/// game to it produces a deployment that reverts `InvalidConsumer` on the first draw. Create
/// it with `cast` (step 2) and pass the real id to `DeployTestnet` (step 3).
///
/// Usage:
///   anvil &
///   cast rpc anvil_mine 2 --rpc-url $RPC          # blockhash(block.number-1) needs a parent
///   forge script script/DeployTestnet.s.sol:DeployTestnetInfra --rpc-url $RPC --broadcast
contract DeployTestnetInfra is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        ERC20Mock usdc = new ERC20Mock("USD Coin", "USDC", 6);
        VRFCoordinatorV2_5Mock coordinator = new VRFCoordinatorV2_5Mock(1e17, 1e9, 4e15);
        vm.stopBroadcast();

        console.log("=== Step 1 complete ===");
        console.log("USDC_ADDRESS=%s", address(usdc));
        console.log("VRF_COORDINATOR=%s", address(coordinator));
        console.log("");
        console.log("Step 2 - create and fund a subscription, then read its real id:");
        console.log("  cast send %s 'createSubscription()' --rpc-url $RPC --private-key $PK", address(coordinator));
        console.log(
            "  cast call %s 'getActiveSubscriptionIds(uint256,uint256)(uint256[])' 0 1 --rpc-url $RPC",
            address(coordinator)
        );
        console.log("  cast send %s 'fundSubscription(uint256,uint256)' <SUB_ID> 1000000000000000000000 --rpc-url $RPC --private-key $PK", address(coordinator));
    }
}

/// @notice Step 3 of the local deployment: the game stack, wired to a subscription that
///         already exists on chain. Seeds the bankroll so bets are accepted immediately.
///
/// Usage:
///   USDC_ADDRESS=0x... VRF_COORDINATOR=0x... VRF_SUBSCRIPTION_ID=<real id> \
///     forge script script/DeployTestnet.s.sol:DeployTestnet --rpc-url $RPC --broadcast
///
/// For Amoy with real Chainlink, use DeployColorColor.s.sol instead.
contract DeployTestnet is Script {
    uint256 constant SEED_BANKROLL = 50_000e6; // $50k

    /// @dev The only game this script deploys, so it may size exposure against the whole
    ///      bankroll. Drops to 6_000 when Greyhounds join the vault (Phase 5).
    uint16 constant COLORCOLOR_ALLOCATION_BPS = 10_000;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address usdc = vm.envAddress("USDC_ADDRESS");
        address coordinator = vm.envAddress("VRF_COORDINATOR");
        uint256 subId = vm.envUint("VRF_SUBSCRIPTION_ID");

        require(usdc.code.length > 0, "USDC_ADDRESS has no code");
        require(coordinator.code.length > 0, "VRF_COORDINATOR has no code");

        vm.startBroadcast(pk);

        ReferralManager referralManager = new ReferralManager(usdc, deployer, deployer);
        HouseVault vault = new HouseVault(usdc, deployer);

        ColorColorGame game = new ColorColorGame(
            usdc,
            coordinator,
            address(referralManager),
            address(vault),
            deployer,               // treasury
            deployer,               // owner
            subId,
            bytes32(uint256(1)),    // any key hash works against the mock
            2_000_000,
            180,                    // 3-minute draws
            800,                    // 8% house edge
            1_000e6,                // $1,000 max payout per bet
            2_000                   // 20% of bankroll max exposure
        );

        vault.setAuthorizedGame(address(game), true);
        vault.setAllocation(address(game), COLORCOLOR_ALLOCATION_BPS);
        referralManager.setAuthorizedGame(address(game), true);
        VRFCoordinatorV2_5Mock(coordinator).addConsumer(subId, address(game));

        // The exposure cap is a fraction of the bankroll, so an unseeded vault rejects
        // every bet — seed before the game opens.
        AgentMandate agentMandate = new AgentMandate(usdc);

        ERC20Mock(usdc).mint(deployer, 150_000e6);
        ERC20Mock(usdc).approve(address(vault), SEED_BANKROLL);
        vault.deposit(SEED_BANKROLL);

        vm.stopBroadcast();

        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("NEXT_PUBLIC_USDC_ADDRESS=%s", usdc);
        console.log("NEXT_PUBLIC_REFERRAL_MANAGER_ADDRESS=%s", address(referralManager));
        console.log("NEXT_PUBLIC_HOUSE_VAULT_ADDRESS=%s", address(vault));
        console.log("NEXT_PUBLIC_COLORCOLOR_ADDRESS=%s", address(game));
        console.log("AGENT_MANDATE_ADDRESS=%s", address(agentMandate));
        console.log("Bankroll seeded: 50,000 USDC");
    }
}
