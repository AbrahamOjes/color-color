// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentMandate} from "../src/AgentMandate.sol";
import {ColorColorGame as ColorColor} from "../src/ColorColorGame.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {ReferralManager} from "../src/ReferralManager.sol";
import {BetType} from "../src/OddsLib.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";

/// @notice The point of these tests: an agent holds its own key and acts unattended, so every
/// limit must hold against an agent that is buggy, looping, or hostile. None of them may
/// depend on the agent behaving.
contract AgentMandateTest is Test {
    AgentMandate mandate;
    ColorColor game;
    HouseVault vault;
    ReferralManager referralManager;
    ERC20Mock usdc;
    VRFCoordinatorV2_5Mock vrfCoordinator;

    address owner = address(1);
    address treasury = address(2);
    address lp = address(3);
    address principal = address(4);
    address agent = address(5);
    address stranger = address(6);

    uint256 nextRequestId;

    uint256 constant DRAW_INTERVAL = 180;
    uint256 constant FUNDING = 1_000e6;
    uint256 constant MAX_STAKE = 50e6;
    uint256 constant DAILY_BUDGET = 200e6;
    uint256 constant COOLDOWN = 60;
    uint8 constant ALL_BET_TYPES = 0x3F;

    uint256 mandateId;

    function setUp() public {
        vm.startPrank(owner);
        usdc = new ERC20Mock("USDC", "USDC", 6);
        vrfCoordinator = new VRFCoordinatorV2_5Mock(1e17, 1e9, 4e15);
        uint256 subId = vrfCoordinator.createSubscription();
        vrfCoordinator.fundSubscription(subId, 1000 ether);

        referralManager = new ReferralManager(address(usdc), treasury, owner);
        vault = new HouseVault(address(usdc), owner);
        game = new ColorColor(
            address(usdc),
            address(vrfCoordinator),
            address(referralManager),
            address(vault),
            treasury,
            owner,
            subId,
            keccak256("test"),
            2_000_000,
            DRAW_INTERVAL,
            800,        // 8% edge
            5_000e6,    // max payout per bet
            5_000       // 50% max exposure
        );
        vrfCoordinator.addConsumer(subId, address(game));
        referralManager.setAuthorizedGame(address(game), true);
        vault.setAuthorizedGame(address(game), true);
        vault.setAllocation(address(game), 10_000);
        vm.stopPrank();

        mandate = new AgentMandate(address(usdc));

        // Seed the bankroll.
        usdc.mint(lp, 100_000e6);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6);
        vm.stopPrank();

        // Principal opens a mandate for the agent.
        usdc.mint(principal, 10_000e6);
        vm.startPrank(principal);
        usdc.approve(address(mandate), type(uint256).max);
        mandateId = mandate.openMandate(
            agent,
            address(game),
            FUNDING,
            MAX_STAKE,
            DAILY_BUDGET,
            COOLDOWN,
            uint64(block.timestamp + 30 days),
            ALL_BET_TYPES,
            address(0)
        );
        vm.stopPrank();
    }

    function _agentBet(BetType t, bytes32 sel, uint256 stake) internal returns (uint256 drawId, uint256 idx) {
        vm.prank(agent);
        (drawId, idx,) = mandate.placeBet(mandateId, uint8(t), sel, stake);
    }

    function _draw(uint256 word) internal {
        skip(DRAW_INTERVAL + 1);
        game.performUpkeep("");
        nextRequestId++;
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        vrfCoordinator.fulfillRandomWordsWithOverride(nextRequestId, address(game), words);
    }

    function _hiloBandOf(uint16 sum) internal pure returns (uint8) {
        if (sum <= 120) return 0;
        if (sum >= 160) return 2;
        return 1;
    }

    // ──────────────────────────────────────────────
    //  The happy path
    // ──────────────────────────────────────────────

    function test_agentPlacesBetFundedByTheMandate() public {
        (uint256 drawId, uint256 idx) = _agentBet(BetType.COLOR, bytes32(uint256(0)), 10e6);

        AgentMandate.Mandate memory m = mandate.getMandate(mandateId);
        assertEq(m.balance, FUNDING - 10e6, "stake came out of the mandate, not the agent");
        assertEq(m.spentInWindow, 10e6);
        assertEq(usdc.balanceOf(agent), 0, "the agent never holds funds");

        // The bet belongs to the mandate contract as far as the game is concerned.
        (address player,,,,,) = game.getBet(drawId, idx);
        assertEq(player, address(mandate));

        (bool known, uint256 owned) = mandate.betMandate(address(game), drawId, idx);
        assertTrue(known);
        assertEq(owned, mandateId);
    }

    /// @dev Winnings must land back in the mandate, never with the agent.
    function test_winningsReturnToTheMandateNotTheAgent() public {
        // Cover all three HILO bands so exactly one must win.
        uint256[3] memory idx;
        for (uint8 band = 0; band < 3; band++) {
            (, idx[band]) = _agentBet(BetType.HILO, bytes32(uint256(band)), 10e6);
            skip(COOLDOWN);
        }

        _draw(uint256(keccak256("agent-win")));
        (,, uint16 sum,,,) = game.getDrawResult(1);
        uint256 winning = idx[_hiloBandOf(sum)];

        uint256 balanceBefore = mandate.getMandate(mandateId).balance;
        (,,,,, uint256 expected) = game.getBet(1, winning);

        mandate.claim(address(game), 1, winning);

        assertEq(
            mandate.getMandate(mandateId).balance,
            balanceBefore + expected,
            "payout credited to the mandate"
        );
        assertEq(usdc.balanceOf(agent), 0, "the agent still holds nothing");
    }

    function test_principalCanWithdrawFundsAndWinnings() public {
        _agentBet(BetType.COLOR, bytes32(uint256(0)), 10e6);

        uint256 before = usdc.balanceOf(principal);
        vm.prank(principal);
        mandate.withdraw(mandateId, 500e6);

        assertEq(usdc.balanceOf(principal) - before, 500e6);
        assertEq(mandate.getMandate(mandateId).balance, FUNDING - 10e6 - 500e6);
    }

    // ──────────────────────────────────────────────
    //  Limits the agent cannot talk its way past
    // ──────────────────────────────────────────────

    function test_stakeAbovePerBetCapReverts() public {
        vm.prank(agent);
        vm.expectRevert(AgentMandate.StakeAboveMandateCap.selector);
        mandate.placeBet(mandateId, uint8(BetType.COLOR), bytes32(uint256(0)), MAX_STAKE + 1);
    }

    /// @dev The rail that actually matters for an autonomous agent: without it, a looping
    ///      agent drains the daily budget in a single block.
    function test_cooldownStopsARunawayLoop() public {
        _agentBet(BetType.COLOR, bytes32(uint256(0)), 10e6);

        vm.prank(agent);
        vm.expectRevert(AgentMandate.CoolingDown.selector);
        mandate.placeBet(mandateId, uint8(BetType.COLOR), bytes32(uint256(1)), 10e6);

        skip(COOLDOWN);
        _agentBet(BetType.COLOR, bytes32(uint256(1)), 10e6); // allowed again
    }

    function test_dailyBudgetIsEnforcedAndRollsOver() public {
        // Spend the whole budget: 4 x 50 = 200.
        for (uint256 i = 0; i < 4; i++) {
            _agentBet(BetType.COLOR, bytes32(uint256(i % 5)), MAX_STAKE);
            skip(COOLDOWN);
        }
        assertEq(mandate.remainingDailyBudget(mandateId), 0);

        vm.prank(agent);
        vm.expectRevert(AgentMandate.DailyBudgetExhausted.selector);
        mandate.placeBet(mandateId, uint8(BetType.COLOR), bytes32(uint256(0)), 1e6);

        // A day later the window resets.
        skip(1 days);
        assertEq(mandate.remainingDailyBudget(mandateId), DAILY_BUDGET);
        _agentBet(BetType.COLOR, bytes32(uint256(0)), MAX_STAKE);
    }

    function test_disallowedBetTypeReverts() public {
        // Permit COLOR (bit 3) only.
        vm.prank(principal);
        mandate.updateLimits(
            mandateId, MAX_STAKE, DAILY_BUDGET, COOLDOWN, uint64(block.timestamp + 30 days), uint8(1 << 3)
        );

        _agentBet(BetType.COLOR, bytes32(uint256(0)), 10e6);
        skip(COOLDOWN);

        vm.prank(agent);
        vm.expectRevert(AgentMandate.BetTypeNotAllowed.selector);
        mandate.placeBet(mandateId, uint8(BetType.PICK3), bytes32(uint256(0x010203)), 10e6);
    }

    function test_agentCannotSpendBeyondTheMandateBalance() public {
        // Raise the caps but leave the balance small.
        vm.startPrank(principal);
        mandate.updateLimits(
            mandateId, 100_000e6, 100_000e6, 0, uint64(block.timestamp + 30 days), ALL_BET_TYPES
        );
        mandate.withdraw(mandateId, FUNDING - 5e6);
        vm.stopPrank();

        vm.prank(agent);
        vm.expectRevert(AgentMandate.InsufficientMandateBalance.selector);
        mandate.placeBet(mandateId, uint8(BetType.COLOR), bytes32(uint256(0)), 6e6);
    }

    function test_revokeStopsPlayImmediately() public {
        vm.prank(principal);
        mandate.revoke(mandateId);

        vm.prank(agent);
        vm.expectRevert(AgentMandate.MandateInactive.selector);
        mandate.placeBet(mandateId, uint8(BetType.COLOR), bytes32(uint256(0)), 10e6);
    }

    /// @dev Revoking must not strand money or forfeit bets already in flight.
    function test_revokeLeavesFundsAndPendingBetsRecoverable() public {
        uint256[3] memory idx;
        for (uint8 band = 0; band < 3; band++) {
            (, idx[band]) = _agentBet(BetType.HILO, bytes32(uint256(band)), 10e6);
            skip(COOLDOWN);
        }

        vm.prank(principal);
        mandate.revoke(mandateId);

        _draw(uint256(keccak256("revoked")));
        (,, uint16 sum,,,) = game.getDrawResult(1);

        // The winning bet still claims into the mandate...
        mandate.claim(address(game), 1, idx[_hiloBandOf(sum)]);
        // ...and the principal can take everything out.
        uint256 balance = mandate.getMandate(mandateId).balance;
        vm.prank(principal);
        mandate.withdraw(mandateId, balance);
        assertEq(mandate.getMandate(mandateId).balance, 0);
    }

    function test_expiredMandateStopsPlay() public {
        vm.warp(block.timestamp + 31 days);

        vm.prank(agent);
        vm.expectRevert(AgentMandate.MandateInactive.selector);
        mandate.placeBet(mandateId, uint8(BetType.COLOR), bytes32(uint256(0)), 10e6);
    }

    // ──────────────────────────────────────────────
    //  Authorisation
    // ──────────────────────────────────────────────

    function test_onlyTheNamedAgentCanBet() public {
        vm.prank(stranger);
        vm.expectRevert(AgentMandate.NotAgent.selector);
        mandate.placeBet(mandateId, uint8(BetType.COLOR), bytes32(uint256(0)), 10e6);

        // Not even the principal bets directly — they play from their own wallet.
        vm.prank(principal);
        vm.expectRevert(AgentMandate.NotAgent.selector);
        mandate.placeBet(mandateId, uint8(BetType.COLOR), bytes32(uint256(0)), 10e6);
    }

    function test_onlyPrincipalControlsTheMandate() public {
        vm.startPrank(agent);
        vm.expectRevert(AgentMandate.NotPrincipal.selector);
        mandate.withdraw(mandateId, 1e6);
        vm.expectRevert(AgentMandate.NotPrincipal.selector);
        mandate.revoke(mandateId);
        vm.expectRevert(AgentMandate.NotPrincipal.selector);
        mandate.updateLimits(mandateId, 1e6, 1e6, 0, uint64(block.timestamp + 1 days), ALL_BET_TYPES);
        vm.stopPrank();
    }

    /// @dev Two agents must be sealed off from each other's money.
    function test_agentsCannotTouchAnotherMandate() public {
        vm.startPrank(principal);
        uint256 other = mandate.openMandate(
            stranger, address(game), 100e6, 10e6, 50e6, 0, uint64(block.timestamp + 1 days), ALL_BET_TYPES, address(0)
        );
        vm.stopPrank();

        vm.prank(agent);
        vm.expectRevert(AgentMandate.NotAgent.selector);
        mandate.placeBet(other, uint8(BetType.COLOR), bytes32(uint256(0)), 10e6);
    }

    function test_claimCreditsTheOwningMandateOnly() public {
        vm.startPrank(principal);
        uint256 other = mandate.openMandate(
            stranger, address(game), 500e6, 50e6, 200e6, 0, uint64(block.timestamp + 1 days), ALL_BET_TYPES, address(0)
        );
        vm.stopPrank();

        // Both agents cover all three HILO bands.
        uint256[3] memory mine;
        for (uint8 band = 0; band < 3; band++) {
            (, mine[band]) = _agentBet(BetType.HILO, bytes32(uint256(band)), 10e6);
            skip(COOLDOWN);
        }
        vm.startPrank(stranger);
        for (uint8 band = 0; band < 3; band++) {
            mandate.placeBet(other, uint8(BetType.HILO), bytes32(uint256(band)), 10e6);
        }
        vm.stopPrank();

        _draw(uint256(keccak256("two-mandates")));
        (,, uint16 sum,,,) = game.getDrawResult(1);

        uint256 otherBefore = mandate.getMandate(other).balance;
        mandate.claim(address(game), 1, mine[_hiloBandOf(sum)]);

        assertEq(mandate.getMandate(other).balance, otherBefore, "the other mandate is untouched");
    }

    function test_claimOnUnknownBetReverts() public {
        vm.expectRevert(AgentMandate.UnknownBet.selector);
        mandate.claim(address(game), 1, 0);
    }

    // ──────────────────────────────────────────────
    //  canBet — the agent's pre-flight check
    // ──────────────────────────────────────────────

    /// @dev Agents should ask before acting. This must never revert, so a refusal is
    ///      something the agent can read and reason about rather than a failed transaction.
    function test_canBetExplainsRefusals() public {
        (bool ok,) = mandate.canBet(mandateId, uint8(BetType.COLOR), 10e6);
        assertTrue(ok);

        (ok, ) = mandate.canBet(mandateId, uint8(BetType.COLOR), MAX_STAKE + 1);
        assertFalse(ok);

        _agentBet(BetType.COLOR, bytes32(uint256(0)), 10e6);
        string memory reason;
        (ok, reason) = mandate.canBet(mandateId, uint8(BetType.COLOR), 10e6);
        assertFalse(ok);
        assertEq(reason, "cooling down");

        vm.prank(principal);
        mandate.revoke(mandateId);
        (ok, reason) = mandate.canBet(mandateId, uint8(BetType.COLOR), 10e6);
        assertFalse(ok);
        assertEq(reason, "mandate revoked");
    }

    function test_getMandateBetsEnumeratesForTheAgent() public {
        _agentBet(BetType.COLOR, bytes32(uint256(0)), 10e6);
        skip(COOLDOWN);
        _agentBet(BetType.HILO, bytes32(uint256(1)), 10e6);

        assertEq(mandate.getMandateBets(mandateId).length, 2);
    }

    // ──────────────────────────────────────────────
    //  Game scope and market mask (Phase 0)
    // ──────────────────────────────────────────────

    /// @dev A second, independent game on the same vault, for cross-game tests.
    function _deployGameB() internal returns (ColorColor gameB) {
        vm.startPrank(owner);
        uint256 subB = vrfCoordinator.createSubscription();
        vrfCoordinator.fundSubscription(subB, 1000 ether);
        gameB = new ColorColor(
            address(usdc), address(vrfCoordinator), address(referralManager), address(vault),
            treasury, owner, subB, keccak256("b"), 2_000_000,
            DRAW_INTERVAL, 800, 5_000e6, 5_000
        );
        vrfCoordinator.addConsumer(subB, address(gameB));
        referralManager.setAuthorizedGame(address(gameB), true);
        vault.setAuthorizedGame(address(gameB), true);
        vault.setAllocation(address(game), 5_000);
        vault.setAllocation(address(gameB), 5_000);
        vm.stopPrank();
    }

    /// @dev The mandate names its game; the agent has no way to point it elsewhere.
    function test_mandateForGameACannotBetOnGameB() public {
        ColorColor gameB = _deployGameB();

        (uint256 drawId, uint256 idx) = _agentBet(BetType.COLOR, bytes32(uint256(0)), 10e6);

        assertEq(mandate.getMandate(mandateId).game, address(game));
        assertEq(game.getBetCount(drawId), 1, "the bet landed on game A");
        assertEq(gameB.getBetCount(1), 0, "game B never saw it");

        (bool known,) = mandate.betMandate(address(gameB), drawId, idx);
        assertFalse(known, "A's bet is not B's");
        vm.expectRevert(AgentMandate.UnknownBet.selector);
        mandate.claim(address(gameB), drawId, idx);

        assertEq(usdc.allowance(address(mandate), address(game)), 0, "no standing approval");
        assertEq(usdc.allowance(address(mandate), address(gameB)), 0);
    }

    function test_mandatesOnDifferentGamesStaySeparate() public {
        ColorColor gameB = _deployGameB();

        vm.prank(principal);
        uint256 onB = mandate.openMandate(
            stranger, address(gameB), 100e6, 10e6, 50e6, 0, uint64(block.timestamp + 1 days), ALL_BET_TYPES, address(0)
        );

        vm.prank(stranger);
        (uint256 drawId, uint256 idx,) = mandate.placeBet(onB, uint8(BetType.COLOR), bytes32(uint256(0)), 10e6);

        assertEq(gameB.getBetCount(drawId), 1);
        assertEq(game.getBetCount(drawId), 0);
        (bool known, uint256 owner_) = mandate.betMandate(address(gameB), drawId, idx);
        assertTrue(known);
        assertEq(owner_, onB);
    }

    function test_marketOutsideMaskReverts() public {
        // HILO only (bit 4).
        vm.prank(principal);
        mandate.updateLimits(mandateId, MAX_STAKE, DAILY_BUDGET, COOLDOWN, uint64(block.timestamp + 30 days), uint32(1 << 4));

        (bool ok, string memory reason) = mandate.canBet(mandateId, uint8(BetType.COLOR), 10e6);
        assertFalse(ok);
        assertEq(reason, "bet type not allowed");

        vm.prank(agent);
        vm.expectRevert(AgentMandate.BetTypeNotAllowed.selector);
        mandate.placeBet(mandateId, uint8(BetType.COLOR), bytes32(uint256(0)), 10e6);

        _agentBet(BetType.HILO, bytes32(uint256(1)), 10e6);
    }

    /// @dev Bits above a game's markets grant nothing: a mask of only high bits allows no bet.
    function test_highMaskBitsGrantNothing() public {
        vm.prank(principal);
        mandate.updateLimits(mandateId, MAX_STAKE, DAILY_BUDGET, COOLDOWN, uint64(block.timestamp + 30 days), uint32(0xFFFFFFC0));

        for (uint8 t = 0; t < 6; t++) {
            (bool ok,) = mandate.canBet(mandateId, uint8(BetType(t)), 10e6);
            assertFalse(ok);
        }
    }

    function test_openMandateNeedsAGameAndAMarket() public {
        vm.startPrank(principal);
        vm.expectRevert(AgentMandate.ZeroAddress.selector);
        mandate.openMandate(agent, address(0), 100e6, 10e6, 50e6, 0, uint64(block.timestamp + 1 days), ALL_BET_TYPES, address(0));

        vm.expectRevert(AgentMandate.NoBetTypesAllowed.selector);
        mandate.openMandate(agent, address(game), 100e6, 10e6, 50e6, 0, uint64(block.timestamp + 1 days), 0, address(0));
        vm.stopPrank();
    }
}
