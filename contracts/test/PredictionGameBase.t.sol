// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ColorColorGame} from "../src/ColorColorGame.sol";
import {PredictionGameBase} from "../src/PredictionGameBase.sol";
import {IPredictionGame} from "../src/interfaces/IPredictionGame.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {ReferralManager} from "../src/ReferralManager.sol";
import {BetType} from "../src/OddsLib.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
import {ColorColorGoldenFixture as G} from "./fixtures/ColorColorGoldenFixture.sol";

/// @notice Engine-level properties of the extraction: the generic result encoding, ABI
///         stability, and that the VRF callback cannot be bricked by the vault.
contract PredictionGameBaseTest is Test {
    ColorColorGame game;
    HouseVault vault;
    ReferralManager referralManager;
    ERC20Mock usdc;
    VRFCoordinatorV2_5Mock vrfCoordinator;

    address owner = address(1);
    address treasury = address(2);
    address lp = address(3);
    address alice = address(4);

    uint256 subId;
    uint256 constant DRAW_INTERVAL = 180;

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
            subId, keccak256("test"), 2_000_000, DRAW_INTERVAL, 800, 5_000e6, 5_000
        );
        vrfCoordinator.addConsumer(subId, address(game));
        referralManager.setAuthorizedGame(address(game), true);
        vault.setAuthorizedGame(address(game), true);
        vault.setAllocation(address(game), 10_000);
        vm.stopPrank();

        usdc.mint(lp, 100_000e6);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6);
        vm.stopPrank();

        usdc.mint(alice, 100_000e6);
        vm.prank(alice);
        usdc.approve(address(game), type(uint256).max);
    }

    function _bet(BetType t, uint256 sel, uint256 stake) internal {
        vm.prank(alice);
        game.placeBet(uint8(t), bytes32(sel), stake, address(0));
    }

    function _requestDraw() internal {
        skip(DRAW_INTERVAL + 1);
        game.performUpkeep("");
    }

    function _fulfil(uint256 word) internal {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        vrfCoordinator.fulfillRandomWordsWithOverride(1, address(game), words);
    }

    function _assertSettledAndReopened() internal view {
        (,,,,, bool settled) = game.getDrawResult(1);
        assertTrue(settled, "the draw must still settle");
        assertFalse(game.drawPending(), "the game must not be left stuck");
        assertEq(game.currentDrawId(), 2, "betting reopens on the next draw");
    }

    /// @dev A win on golden word 1 large enough that the house is net down on the draw, so
    ///      settlement has to pull a loss from the vault.
    function _bookLosingDraw() internal {
        _bet(BetType.PICK3, (8 << 16) | (10 << 8) | 14, 5e6);
    }

    // ──────────────────────────────────────────────
    //  Outcome encoding
    // ──────────────────────────────────────────────

    /// @dev Pins the byte layout documented on ColorColorGame, independently of its decoder:
    ///      numbers ‖ colourCount ‖ sum(uint16) ‖ dominant, from the most significant byte.
    function test_outcomePackingLayout() public {
        G.Golden memory g = G.golden1();
        bytes32 expected = bytes32(
            abi.encodePacked(
                g.numbers[0], g.numbers[1], g.numbers[2], g.numbers[3], g.numbers[4], g.numbers[5],
                g.colourCount[0], g.colourCount[1], g.colourCount[2], g.colourCount[3],
                g.sum,
                g.dominant,
                bytes19(0)
            )
        );

        _bet(BetType.COLOR, 4, 1e6);
        _requestDraw();

        vm.expectEmit(true, false, false, true, address(game));
        emit PredictionGameBase.DrawSettled(1, expected, game.liability(1, uint8(BetType.COLOR), bytes32(uint256(4))));
        _fulfil(G.WORD_1);

        (bytes32 outcome, uint64 timestamp,, bool settled) = game.draws(1);
        assertEq(outcome, expected, "stored outcome");
        assertEq(timestamp, block.timestamp, "timestamp");
        assertTrue(settled);
    }

    function test_unsettledDrawReadsAsZeros() public view {
        (uint8[6] memory numbers, uint8[4] memory colourCount, uint16 sum, uint8 dominant, uint256 total, bool settled) =
            game.getDrawResult(1);
        for (uint256 i = 0; i < 6; i++) assertEq(numbers[i], 0);
        for (uint256 i = 0; i < 4; i++) assertEq(colourCount[i], 0);
        assertEq(sum, 0);
        assertEq(dominant, 0);
        assertEq(total, 0);
        assertFalse(settled);
    }

    // ──────────────────────────────────────────────
    //  ABI stability
    // ──────────────────────────────────────────────

    /// @dev Solidity ABI-encodes an enum as uint8, so the old `placeBet(BetType,…)` had this
    ///      exact selector. Frontends and the agent keep working unchanged.
    function test_placeBetSelectorUnchanged() public pure {
        bytes4 expected = bytes4(keccak256("placeBet(uint8,bytes32,uint256,address)"));
        assertEq(PredictionGameBase.placeBet.selector, expected);
        assertEq(IPredictionGame.placeBet.selector, expected);
        assertEq(ColorColorGame.quote.selector, bytes4(keccak256("quote(uint8,bytes32,uint256)")));
    }

    function test_marketOutOfRangeReverts() public {
        vm.prank(alice);
        vm.expectRevert(PredictionGameBase.InvalidMarket.selector);
        game.placeBet(6, bytes32(uint256(1)), 1e6, address(0));
    }

    // ──────────────────────────────────────────────
    //  Bet cutoff and booked edge (Phase 2)
    // ──────────────────────────────────────────────

    /// @dev ColorColor runs with no cutoff: betting stays open past the interval until
    ///      upkeep actually requests the draw, exactly as before the cutoff existed.
    function test_colorColorHasNoCutoff() public {
        assertEq(game.betCutoff(), 0);
        assertEq(game.bettingClosesAt(), game.lastDrawTimestamp() + DRAW_INTERVAL);

        skip(DRAW_INTERVAL * 5);
        _bet(BetType.COLOR, 4, 1e6);
        _bet(BetType.PICK1, 7, 1e6);
        assertEq(game.lastDrawTimestamp(), 1, "no roll-forward without a cutoff");

        game.performUpkeep("");
        vm.prank(alice);
        vm.expectRevert(PredictionGameBase.BettingClosed.selector);
        game.placeBet(uint8(BetType.COLOR), bytes32(uint256(4)), 1e6, address(0));
    }

    /// @dev A winner claims at the edge its draw was booked at, even if the owner changes
    ///      the edge between settlement and the claim.
    function test_colorColorClaimUsesBookedEdge() public {
        _bet(BetType.PICK3, (8 << 16) | (10 << 8) | 14, 5e6);
        (,,,,, uint256 booked) = game.getBet(1, 0);
        _requestDraw();
        _fulfil(G.WORD_1);
        assertTrue(game.isBetWinner(1, 0));

        vm.prank(owner);
        game.setRiskParams(0, 5_000e6, 5_000);
        assertEq(game.bookedEdgeBps(1, uint8(BetType.PICK3)), 800);

        vm.prank(alice);
        assertEq(game.claimPrize(1, 0), booked);
        assertEq(game.unclaimedLiability(), 0);
    }

    // ──────────────────────────────────────────────
    //  Callback safety
    // ──────────────────────────────────────────────

    /// @dev The game is repointed at a fresh, authorised vault with no assets while a losing
    ///      draw is pending. `pullLoss` can only cap at zero; the draw must still settle.
    function test_callbackSurvivesEmptyVault() public {
        _bookLosingDraw();
        _requestDraw();

        vm.startPrank(owner);
        HouseVault empty = new HouseVault(address(usdc), owner);
        empty.setAuthorizedGame(address(game), true);
        empty.setAllocation(address(game), 10_000);
        game.setHouseVault(address(empty));
        vm.stopPrank();

        _fulfil(G.WORD_1);
        _assertSettledAndReopened();
    }

    /// @dev Same, but the empty vault has never heard of the game, so every vault call
    ///      reverts. The callback swallows it and flags the unsettled P&L.
    function test_callbackSurvivesEmptyUnauthorisedVault() public {
        _bookLosingDraw();
        _requestDraw();

        vm.startPrank(owner);
        game.setHouseVault(address(new HouseVault(address(usdc), owner)));
        vm.stopPrank();

        vm.expectEmit(true, false, false, false, address(game));
        emit PredictionGameBase.HouseSettlementFailed(1, false, 0);
        _fulfil(G.WORD_1);
        _assertSettledAndReopened();
    }

    /// @dev The original vault de-authorises the game mid-draw, on a losing draw this time.
    function test_callbackSurvivesDeauthorisedVaultOnLoss() public {
        _bookLosingDraw();
        _requestDraw();

        vm.prank(owner);
        vault.setAuthorizedGame(address(game), false);

        _fulfil(G.WORD_1);
        _assertSettledAndReopened();
    }
}
