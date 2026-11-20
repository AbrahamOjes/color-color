// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ColorColorGame} from "../src/ColorColorGame.sol";
import {VirtualRace} from "../src/VirtualRace.sol";
import {PredictionGameBase} from "../src/PredictionGameBase.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {ReferralManager} from "../src/ReferralManager.sol";
import {BetType} from "../src/OddsLib.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";

/// @notice A VRF request that the owner cancelled can still be fulfilled later: the
///         coordinator does not know about `cancelPendingDraw`. The engine must settle a draw
///         only on the request it is actually waiting for, and only once. Before the guard, a
///         late callback re-settled the same draw with a second outcome, doubled its liability
///         and P&L, and re-seeded the next race card.
contract StaleFulfilmentTest is Test {
    ColorColorGame game;
    VirtualRace race;
    HouseVault vault;
    ReferralManager referralManager;
    ERC20Mock usdc;
    VRFCoordinatorV2_5Mock vrfCoordinator;

    address owner = address(1);
    address treasury = address(2);
    address lp = address(3);
    address alice = address(4);

    uint256 subId;
    uint256 nextRequestId = 1;
    uint256 constant INTERVAL = 180;

    function setUp() public {
        vm.startPrank(owner);
        usdc = new ERC20Mock("USDC", "USDC", 6);
        vrfCoordinator = new VRFCoordinatorV2_5Mock(1e17, 1e9, 4e15);
        subId = vrfCoordinator.createSubscription();
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
            VirtualRace.Config({runners: 6, wMin: 5, wMax: 40, skinId: "greyhounds-v1", betCutoff: 10})
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

        usdc.mint(lp, 1_000_000e6);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1_000_000e6);
        vm.stopPrank();

        usdc.mint(alice, 100_000e6);
        vm.startPrank(alice);
        usdc.approve(address(game), type(uint256).max);
        usdc.approve(address(race), type(uint256).max);
        vm.stopPrank();
    }

    function _bet(PredictionGameBase g, uint8 market, uint256 sel, uint256 stake) internal {
        vm.prank(alice);
        g.placeBet(market, bytes32(sel), stake, address(0));
    }

    /// @dev Requests a draw and returns the coordinator's request id for it.
    function _request(PredictionGameBase g) internal returns (uint256 id) {
        skip(INTERVAL + 1);
        g.performUpkeep("");
        id = nextRequestId++;
        assertEq(g.pendingRequestId(), id, "the engine records the request it waits on");
    }

    function _fulfil(PredictionGameBase g, uint256 id, uint256 word) internal {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        vrfCoordinator.fulfillRandomWordsWithOverride(id, address(g), words);
    }

    /// @dev The mock deletes a request once served, so a second delivery of the same request
    ///      has to come straight from "the coordinator".
    function _redeliver(PredictionGameBase g, uint256 id, uint256 word) internal {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        vm.prank(address(vrfCoordinator));
        g.rawFulfillRandomWords(id, words);
    }

    // ──────────────────────────────────────────────
    //  ColorColor
    // ──────────────────────────────────────────────

    function test_lateCallbackAfterCancelAndRerequestIsIgnored() public {
        _bet(game, uint8(BetType.COLOR), 0, 10e6);
        uint256 first = _request(game);

        vm.prank(owner);
        game.cancelPendingDraw();
        assertEq(game.pendingRequestId(), 0, "cancel forgets the request");

        uint256 second = _request(game);
        assertEq(game.currentDrawId(), 1, "the draw id is reused after a cancel");

        // The first request lands late. It must not settle draw 1.
        vm.expectEmit(true, true, false, false, address(game));
        emit PredictionGameBase.StaleFulfilment(first, 1);
        _fulfil(game, first, 111);

        (,,,,, bool settled) = game.getDrawResult(1);
        assertFalse(settled, "stale word must not settle the draw");
        assertTrue(game.drawPending(), "the live request is still awaited");
        assertEq(game.unclaimedLiability(), 0);
        assertEq(game.currentDrawId(), 1);

        // The live request settles it exactly once.
        _fulfil(game, second, 222);
        (,,,,, settled) = game.getDrawResult(1);
        assertTrue(settled);
        assertFalse(game.drawPending());
        assertEq(game.pendingRequestId(), 0);
        assertEq(game.currentDrawId(), 2);
    }

    function test_lateCallbackAfterSettlementIsIgnored() public {
        _bet(game, uint8(BetType.COLOR), 0, 10e6);
        uint256 first = _request(game);
        vm.prank(owner);
        game.cancelPendingDraw();
        uint256 second = _request(game);

        // Live request first, then the cancelled one arrives.
        _fulfil(game, second, 222);
        (uint8[6] memory numbers,,,, uint256 totalPayout,) = game.getDrawResult(1);
        uint256 liabilityBefore = game.unclaimedLiability();
        uint256 lastDraw = game.lastDrawTimestamp();

        skip(5);
        vm.expectEmit(true, true, false, false, address(game));
        emit PredictionGameBase.StaleFulfilment(first, 1);
        _fulfil(game, first, 111);

        (uint8[6] memory numbersAfter,,,, uint256 totalPayoutAfter, bool settled) = game.getDrawResult(1);
        assertTrue(settled);
        for (uint256 i = 0; i < 6; i++) assertEq(numbersAfter[i], numbers[i], "outcome must not change");
        assertEq(totalPayoutAfter, totalPayout, "payout must not change");
        assertEq(game.unclaimedLiability(), liabilityBefore, "liability must not be counted twice");
        assertEq(game.lastDrawTimestamp(), lastDraw, "round clock must not move");
        assertEq(game.currentDrawId(), 2);
    }

    function test_sameRequestDeliveredTwiceSettlesOnce() public {
        _bet(game, uint8(BetType.COLOR), 0, 10e6);
        uint256 id = _request(game);
        _fulfil(game, id, 222);
        uint256 liabilityBefore = game.unclaimedLiability();

        vm.expectEmit(true, true, false, false, address(game));
        emit PredictionGameBase.StaleFulfilment(id, 1);
        _redeliver(game, id, 333);

        assertEq(game.unclaimedLiability(), liabilityBefore);
        assertEq(game.currentDrawId(), 2);
    }

    /// @dev A stale callback with no live request in flight: the draw stays open and its bets
    ///      settle on the next successful request, exactly as `cancelPendingDraw` promises.
    function test_lateCallbackWithNoLiveRequestLeavesDrawOpen() public {
        _bet(game, uint8(BetType.COLOR), 0, 10e6);
        uint256 first = _request(game);
        vm.prank(owner);
        game.cancelPendingDraw();

        _fulfil(game, first, 111);
        (,,,,, bool settled) = game.getDrawResult(1);
        assertFalse(settled);
        assertFalse(game.drawPending());
        assertTrue(game.bettingOpen(), "betting stays open after a cancelled request lands late");

        _bet(game, uint8(BetType.COLOR), 1, 10e6);
        uint256 second = _request(game);
        _fulfil(game, second, 222);
        (,,,,, settled) = game.getDrawResult(1);
        assertTrue(settled);
        (, uint96 laterStake,,,) = game.bets(1, 1);
        assertEq(laterStake, 10e6, "the later bet is in the settled draw");
    }

    /// @dev The callback must stay revert-free with the guard in place, even from a stranger
    ///      request id the engine has never seen.
    function test_unknownRequestIsIgnoredWithoutReverting() public {
        _bet(game, uint8(BetType.COLOR), 0, 10e6);
        _request(game);
        _redeliver(game, 999_999, 1);
        assertTrue(game.drawPending());
        (,,,,, bool settled) = game.getDrawResult(1);
        assertFalse(settled);
    }

    // ──────────────────────────────────────────────
    //  VirtualRace: the next card must not be re-seeded
    // ──────────────────────────────────────────────

    function test_raceCardIsNotReseededByStaleCallback() public {
        _bet(race, 0, 0, 10e6);
        uint256 first = _request(race);
        vm.prank(owner);
        race.cancelPendingDraw();
        uint256 second = _request(race);

        _fulfil(race, second, 222);
        bytes32 card2 = race.cardSeed(2);
        bytes32 replay1 = race.replaySeed(1);
        assertTrue(card2 != bytes32(0));

        // Bets are already being priced on card 2 when the stale word arrives.
        _bet(race, 0, 1, 10e6);
        _fulfil(race, first, 111);

        assertEq(race.cardSeed(2), card2, "card committed for the open round must not change");
        assertEq(race.replaySeed(1), replay1, "replay seed must not change");
        assertEq(race.currentDrawId(), 2);
    }
}
