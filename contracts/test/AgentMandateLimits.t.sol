// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentMandate} from "../src/AgentMandate.sol";
import {ColorColorGame} from "../src/ColorColorGame.sol";
import {VirtualRace} from "../src/VirtualRace.sol";
import {PredictionGameBase} from "../src/PredictionGameBase.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {ReferralManager} from "../src/ReferralManager.sol";
import {BetType} from "../src/OddsLib.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";

/// @notice Limit validation, event payloads, and `canBet` agreeing with the game's own gating.
///         An operator reads the chain to audit what an agent was allowed to do, so the events
///         must carry the limits; and an agent that trusts `canBet` must not then burn gas on
///         a revert the pre-flight could have predicted.
contract AgentMandateLimitsTest is Test {
    AgentMandate mandate;
    ColorColorGame game;
    VirtualRace race;
    HouseVault vault;
    ReferralManager referralManager;
    ERC20Mock usdc;
    VRFCoordinatorV2_5Mock vrfCoordinator;

    address owner = address(1);
    address treasury = address(2);
    address lp = address(3);
    address principal = address(4);
    address agent = address(5);

    uint256 constant INTERVAL = 120;
    uint256 constant CUTOFF = 10;
    uint64 expiry;

    function setUp() public {
        vm.startPrank(owner);
        usdc = new ERC20Mock("USDC", "USDC", 6);
        vrfCoordinator = new VRFCoordinatorV2_5Mock(1e17, 1e9, 4e15);
        uint256 subId = vrfCoordinator.createSubscription();
        vrfCoordinator.fundSubscription(subId, 1000 ether);
        referralManager = new ReferralManager(address(usdc), treasury, owner);
        vault = new HouseVault(address(usdc), owner);
        game = new ColorColorGame(
            address(usdc), address(vrfCoordinator), address(referralManager), address(vault), treasury, owner,
            subId, keccak256("test"), 2_000_000, INTERVAL, 800, 5_000e6, 5_000
        );
        race = new VirtualRace(
            address(usdc), address(vrfCoordinator), address(referralManager), address(vault), treasury, owner,
            subId, keccak256("test"), 2_000_000, INTERVAL, 800, 5_000e6, 5_000,
            VirtualRace.Config({runners: 6, wMin: 5, wMax: 40, skinId: "greyhounds-v1", betCutoff: CUTOFF})
        );
        vrfCoordinator.addConsumer(subId, address(game));
        vrfCoordinator.addConsumer(subId, address(race));
        referralManager.setAuthorizedGame(address(game), true);
        referralManager.setAuthorizedGame(address(race), true);
        vault.setAuthorizedGame(address(game), true);
        vault.setAuthorizedGame(address(race), true);
        vault.setAllocation(address(game), 5_000);
        vault.setAllocation(address(race), 5_000);
        vm.stopPrank();

        mandate = new AgentMandate(address(usdc));

        usdc.mint(lp, 1_000_000e6);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1_000_000e6);
        vm.stopPrank();

        usdc.mint(principal, 10_000e6);
        vm.prank(principal);
        usdc.approve(address(mandate), type(uint256).max);

        expiry = uint64(block.timestamp + 30 days);
    }

    function _open(address g, uint256 cap, uint256 budget, uint256 cooldown, uint32 mask) internal returns (uint256) {
        vm.prank(principal);
        return mandate.openMandate(agent, g, 1_000e6, cap, budget, cooldown, expiry, mask, address(0));
    }

    // ──────────────────────────────────────────────
    //  Validation
    // ──────────────────────────────────────────────

    function test_openMandateRejectsStakeCapAboveDailyBudget() public {
        vm.prank(principal);
        vm.expectRevert(AgentMandate.StakeCapAboveBudget.selector);
        mandate.openMandate(agent, address(game), 1_000e6, 101e6, 100e6, 0, expiry, 0x3F, address(0));
    }

    function test_updateLimitsRejectsStakeCapAboveDailyBudget() public {
        uint256 id = _open(address(game), 50e6, 200e6, 60, 0x3F);
        vm.prank(principal);
        vm.expectRevert(AgentMandate.StakeCapAboveBudget.selector);
        mandate.updateLimits(id, 201e6, 200e6, 60, expiry, 0x3F);
    }

    function test_updateLimitsRejectsPastExpiry() public {
        uint256 id = _open(address(game), 50e6, 200e6, 60, 0x3F);
        skip(1 hours);
        vm.prank(principal);
        vm.expectRevert(AgentMandate.MandateInactive.selector);
        mandate.updateLimits(id, 50e6, 200e6, 60, uint64(block.timestamp), 0x3F);
    }

    function test_stakeCapEqualToBudgetIsAllowed() public {
        uint256 id = _open(address(game), 200e6, 200e6, 0, 0x3F);
        vm.prank(principal);
        mandate.updateLimits(id, 100e6, 100e6, 0, expiry, 0x3F);
    }

    // ──────────────────────────────────────────────
    //  Events carry what an auditor needs
    // ──────────────────────────────────────────────

    function test_openMandateEmitsLimits() public {
        vm.expectEmit(true, true, true, true, address(mandate));
        emit AgentMandate.MandateOpened(0, principal, agent, address(game), 1_000e6, 50e6, 200e6, 60, expiry, 0x3F);
        _open(address(game), 50e6, 200e6, 60, 0x3F);
    }

    function test_updateLimitsEmitsLimits() public {
        uint256 id = _open(address(game), 50e6, 200e6, 60, 0x3F);
        uint64 later = uint64(block.timestamp + 60 days);
        vm.prank(principal);
        vm.expectEmit(true, false, false, true, address(mandate));
        emit AgentMandate.MandateLimitsUpdated(id, 25e6, 100e6, 30, later, 0x08);
        mandate.updateLimits(id, 25e6, 100e6, 30, later, 0x08);
    }

    function test_agentBetPlacedNamesTheGame() public {
        uint256 id = _open(address(game), 50e6, 200e6, 0, 0x3F);
        (uint256 payout,) = game.quote(BetType.COLOR, bytes32(uint256(0)), 10e6);
        vm.prank(agent);
        vm.expectEmit(true, true, true, true, address(mandate));
        emit AgentMandate.AgentBetPlaced(id, 1, 0, address(game), uint8(BetType.COLOR), 10e6, payout);
        mandate.placeBet(id, uint8(BetType.COLOR), bytes32(uint256(0)), 10e6);
    }

    // ──────────────────────────────────────────────
    //  canBet agrees with placeBet on timing
    // ──────────────────────────────────────────────

    function test_canBetRefusesAfterTheRaceCutoff() public {
        uint256 id = _open(address(race), 50e6, 200e6, 0, 0xFF);

        // Anchor the round with a bet, then run past the cutoff.
        vm.prank(agent);
        mandate.placeBet(id, 0, bytes32(uint256(0)), 10e6);
        skip(INTERVAL - CUTOFF);

        assertFalse(race.bettingOpen());
        (bool ok, string memory reason) = mandate.canBet(id, 0, 10e6);
        assertFalse(ok);
        assertEq(reason, "betting closed for this round");

        vm.prank(agent);
        vm.expectRevert(PredictionGameBase.BettingClosed.selector);
        mandate.placeBet(id, 0, bytes32(uint256(1)), 10e6);
    }

    function test_canBetRefusesWhileGamePaused() public {
        uint256 id = _open(address(game), 50e6, 200e6, 0, 0x3F);
        vm.prank(owner);
        game.pause();

        assertFalse(game.bettingOpen());
        (bool ok, string memory reason) = mandate.canBet(id, uint8(BetType.COLOR), 10e6);
        assertFalse(ok);
        assertEq(reason, "betting closed for this round");
    }

    function test_canBetAllowsWithNoCutoffUntilUpkeep() public {
        uint256 id = _open(address(game), 50e6, 200e6, 0, 0x3F);
        vm.prank(agent);
        mandate.placeBet(id, uint8(BetType.COLOR), bytes32(uint256(0)), 10e6);

        // ColorColor has no cutoff: the draw is overdue but not yet requested, so bets are
        // still accepted, and canBet must say so.
        skip(INTERVAL + 5);
        assertTrue(game.bettingOpen());
        (bool ok,) = mandate.canBet(id, uint8(BetType.COLOR), 10e6);
        assertTrue(ok);
    }
}
