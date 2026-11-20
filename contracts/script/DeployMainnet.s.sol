// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ColorColorGame} from "../src/ColorColorGame.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {ReferralManager} from "../src/ReferralManager.sol";
import {AgentMandate} from "../src/AgentMandate.sol";
import {GaslessEntry} from "../src/GaslessEntry.sol";

interface IVRFCoordinatorV2Plus {
    function addConsumer(uint256 subId, address consumer) external;
    function getSubscription(uint256 subId)
        external
        view
        returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] memory consumers);
    function s_provingKeyHashes(uint256 index) external view returns (bytes32);
}

/// @notice One-shot Polygon **mainnet** deployment, locked down.
///
/// Deploys the full stack, pauses the game before a cent of USDC reaches it, wires VRF onto
/// native POL billing, and seeds a deliberately tiny bankroll. Nothing is bettable when this
/// finishes — unpausing is a separate, deliberate act.
///
/// The subscription must already exist and be funded, because `createSubscription` derives
/// its id from `blockhash`, which differs between forge's simulation and the real broadcast.
/// Creating it inside this script would wire the game to an id that does not exist and every
/// draw would revert `InvalidConsumer`.
///
/// Usage:
///   source .env
///   export DEPLOYER=$(cast wallet address --account deployer)
///   VRF_SUBSCRIPTION_ID=<real id> \
///   forge script script/DeployMainnet.s.sol:DeployMainnet \
///     --rpc-url $POLYGON_RPC_URL --account deployer --sender $DEPLOYER \
///     --broadcast --slow -vvvv
contract DeployMainnet is Script {
    // Polygon mainnet. Every one verified on-chain before this file was written.
    address constant USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    address constant VRF_COORDINATOR = 0xec0Ed46f36576541C75739E915ADbCb3DE24bD77;
    // 200 gwei lane, confirmed present in s_provingKeyHashes[0].
    bytes32 constant KEY_HASH = 0x0ffbbd0c1c18c0263dd778dadd1d64240d7bc338d95fec1cf0473928ca7eaf9e;

    uint256 constant DRAW_INTERVAL = 600;        // 10 minutes
    uint256 constant HOUSE_EDGE_BPS = 800;       // 8%
    uint256 constant MAX_PAYOUT_PER_BET = 5e6;   // $5 — tiny, matching a $20 bankroll
    uint256 constant MAX_EXPOSURE_BPS = 2_000;   // 20% of bankroll
    uint32  constant CALLBACK_GAS_LIMIT = 1_000_000; // 2.7x measured settlement (375,079)
    uint256 constant BANKROLL = 20e6;            // $20

    /// @dev The only game this script deploys, so it may size exposure against the whole
    ///      bankroll. Drops to 6_000 when Greyhounds join the vault (Phase 5).
    uint16 constant COLORCOLOR_ALLOCATION_BPS = 10_000;

    function run() external {
        address deployer = msg.sender;
        uint256 subId = vm.envUint("VRF_SUBSCRIPTION_ID");

        // ── Pre-flight. Every one of these is described in docs/architecture.md, "Deployment pitfalls".
        require(block.chainid == 137, "not Polygon mainnet");
        require(USDC.code.length > 0, "USDC has no code");
        require(VRF_COORDINATOR.code.length > 0, "VRF coordinator has no code");

        // An unregistered key hash is accepted by the coordinator and then served by nobody,
        // so the callback never lands and the draw hangs forever. This killed ColorColor v2.
        bool keyRegistered;
        for (uint256 i = 0; i < 5; i++) {
            try IVRFCoordinatorV2Plus(VRF_COORDINATOR).s_provingKeyHashes(i) returns (bytes32 k) {
                if (k == KEY_HASH) { keyRegistered = true; break; }
            } catch { break; }
        }
        require(keyRegistered, "KEY_HASH is not registered on this coordinator");

        (, uint96 nativeBalance,, address subOwner,) =
            IVRFCoordinatorV2Plus(VRF_COORDINATOR).getSubscription(subId);
        require(subOwner == deployer, "subscription is not owned by the deployer");
        require(nativeBalance > 0, "subscription has no native balance - fund it first");

        require(IERC20(USDC).balanceOf(deployer) >= BANKROLL, "deployer lacks the USDC bankroll");

        console.log("=== ColorColor -> Polygon mainnet (LOCKED DOWN) ===");
        console.log("deployer      ", deployer);
        console.log("subscription  ", subId);
        console.log("sub native bal", uint256(nativeBalance));
        console.log("draw interval ", DRAW_INTERVAL);

        vm.startBroadcast();

        ReferralManager rm = new ReferralManager(USDC, deployer, deployer);
        HouseVault vault = new HouseVault(USDC, deployer);

        ColorColorGame game = new ColorColorGame(
            USDC,
            VRF_COORDINATOR,
            address(rm),
            address(vault),
            deployer,               // treasury
            deployer,               // owner
            subId,
            KEY_HASH,
            CALLBACK_GAS_LIMIT,
            DRAW_INTERVAL,
            HOUSE_EDGE_BPS,
            MAX_PAYOUT_PER_BET,
            MAX_EXPOSURE_BPS
        );

        // Shut before anything can reach it. Claims stay open by design — pausing must never
        // trap a winner's money.
        game.pause();

        game.setNativePayment(true);           // bill VRF in POL, no LINK anywhere
        vault.setAuthorizedGame(address(game), true);
        vault.setAllocation(address(game), COLORCOLOR_ALLOCATION_BPS);
        rm.setAuthorizedGame(address(game), true);
        IVRFCoordinatorV2Plus(VRF_COORDINATOR).addConsumer(subId, address(game));

        AgentMandate mandate = new AgentMandate(USDC);
        GaslessEntry entry = new GaslessEntry(USDC);

        // Seed the bankroll last, once the game is already paused.
        IERC20(USDC).approve(address(vault), BANKROLL);
        vault.deposit(BANKROLL);

        vm.stopBroadcast();

        console.log("");
        console.log("ReferralManager", address(rm));
        console.log("HouseVault     ", address(vault));
        console.log("ColorColor     ", address(game));
        console.log("AgentMandate   ", address(mandate));
        console.log("GaslessEntry   ", address(entry));
        console.log("");
        console.log("PAUSED. Nobody can bet until you call unpause() deliberately.");
    }
}
