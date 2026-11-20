// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ColorColorGame as ColorColor} from "../src/ColorColorGame.sol";
import {PredictionGameBase} from "../src/PredictionGameBase.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {ReferralManager} from "../src/ReferralManager.sol";
import {OddsLib, BetType} from "../src/OddsLib.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";

contract ColorColorTest is Test {
    ColorColor public game;
    HouseVault public vault;
    ReferralManager public referralManager;
    ERC20Mock public usdc;
    VRFCoordinatorV2_5Mock public vrfCoordinator;

    address owner = address(1);
    address treasury = address(2);
    address lp = address(3);
    address alice = address(4);
    address bob = address(5);
    address carol = address(6);

    uint256 subId;
    uint256 nextRequestId;
    bytes32 keyHash = keccak256("test");
    uint256 constant DRAW_INTERVAL = 180;
    uint256 constant EDGE_BPS = 800;            // 8%
    uint256 constant MAX_PAYOUT = 5_000e6;      // $5,000
    uint256 constant MAX_EXPOSURE_BPS = 5_000;  // 50% of bankroll
    uint256 constant BANKROLL = 100_000e6;      // $100k

    function setUp() public {
        vm.startPrank(owner);

        usdc = new ERC20Mock("USDC", "USDC", 6);
        vrfCoordinator = new VRFCoordinatorV2_5Mock(1e17, 1e9, 4e15);
        subId = vrfCoordinator.createSubscription();
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
            keyHash,
            2_000_000,
            DRAW_INTERVAL,
            EDGE_BPS,
            MAX_PAYOUT,
            MAX_EXPOSURE_BPS
        );

        vrfCoordinator.addConsumer(subId, address(game));
        referralManager.setAuthorizedGame(address(game), true);
        vault.setAuthorizedGame(address(game), true);
        vault.setAllocation(address(game), 10_000);
        vm.stopPrank();

        // Seed the bankroll.
        usdc.mint(lp, BANKROLL);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(BANKROLL);
        vm.stopPrank();

        for (uint256 i = 0; i < 3; i++) {
            address p = [alice, bob, carol][i];
            usdc.mint(p, 100_000e6);
            vm.prank(p);
            usdc.approve(address(game), type(uint256).max);
        }
    }

    // ──────────────────────────────────────────────
    //  Helpers
    // ──────────────────────────────────────────────

    function _bet(address p, BetType t, bytes32 sel, uint256 stake) internal returns (uint256 idx) {
        vm.prank(p);
        (idx,) = game.placeBet(uint8(t), sel, stake, address(0));
    }

    /// @dev Runs a draw, forcing `word` as the VRF output so results are deterministic.
    ///      The mock hands out request IDs sequentially from 1, and this suite makes exactly
    ///      one request per draw, so the ID is just a running count.
    function _draw(uint256 word) internal returns (uint256 drawId) {
        drawId = game.currentDrawId();
        skip(DRAW_INTERVAL + 1);

        game.performUpkeep("");
        nextRequestId++;

        uint256[] memory words = new uint256[](1);
        words[0] = word;
        vrfCoordinator.fulfillRandomWordsWithOverride(nextRequestId, address(game), words);
    }

    function _pick2(uint8 a, uint8 b) internal pure returns (bytes32) {
        return bytes32((uint256(a) << 8) | uint256(b));
    }

    /// @dev Runs a throwaway draw to learn what `word` produces, then rewinds. The result is
    ///      a pure function of the VRF word and ignores the bets, so the probe is exact —
    ///      which lets the P&L tests bet on a known winner or a known loser deterministically.
    function _peekDominantColour(uint256 word) internal returns (uint8 dominant) {
        uint256 snap = vm.snapshotState();
        _bet(alice, BetType.PICK1, bytes32(uint256(1)), 1e6);
        uint256 drawId = _draw(word);
        (,,, dominant,,) = game.getDrawResult(drawId);
        vm.revertToState(snap);
    }

    function _hiloBandOf(uint16 sum) internal pure returns (uint8) {
        if (sum <= 120) return 0;
        if (sum >= 160) return 2;
        return 1;
    }

    // ──────────────────────────────────────────────
    //  Fixed odds — the defining property
    // ──────────────────────────────────────────────

    /// @dev The whole point of this rewrite: what you win depends only on your own bet and
    ///      the result. Under the old parimutuel model Bob's stake would have diluted Alice's
    ///      payout; here it must not move it by a single unit.
    function test_payoutIsIndependentOfOtherBets() public {
        // Alice bets $1. Everyone else piles in, including 500x her size on her own side —
        // under parimutuel that would have gutted her share.
        uint256[3] memory idx;
        for (uint8 band = 0; band < 3; band++) {
            idx[band] = _bet(alice, BetType.HILO, bytes32(uint256(band)), 1e6);
        }
        _bet(bob, BetType.HILO, bytes32(uint256(0)), 500e6);
        _bet(carol, BetType.HILO, bytes32(uint256(1)), 300e6);
        _bet(carol, BetType.HILO, bytes32(uint256(2)), 300e6);

        uint256 drawId = _draw(uint256(keccak256("indep")));
        (,, uint16 sum,,,) = game.getDrawResult(drawId);
        uint8 winner = _hiloBandOf(sum);

        uint256 expected = OddsLib.payoutFor(1e6, BetType.HILO, bytes32(uint256(winner)), EDGE_BPS);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        game.claimPrize(drawId, idx[winner]);
        assertEq(usdc.balanceOf(alice) - before, expected, "payout must be pure fixed odds");
    }

    /// @dev Cover all three HILO bands so exactly one must win, then check the winner is paid
    ///      precisely what `quote` promised before the draw.
    function test_quoteMatchesActualPayout() public {
        uint256[3] memory idx;
        uint256[3] memory quoted;
        for (uint8 band = 0; band < 3; band++) {
            (uint256 p,) = game.quote(BetType.HILO, bytes32(uint256(band)), 10e6);
            quoted[band] = p;
            idx[band] = _bet(alice, BetType.HILO, bytes32(uint256(band)), 10e6);
        }

        uint256 drawId = _draw(uint256(keccak256("quote")));
        (,, uint16 sum,,,) = game.getDrawResult(drawId);
        uint8 winner = _hiloBandOf(sum);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        game.claimPrize(drawId, idx[winner]);
        assertEq(usdc.balanceOf(alice) - before, quoted[winner], "paid exactly what was quoted");

        // The other two must be rejected as losers.
        for (uint8 band = 0; band < 3; band++) {
            if (band == winner) continue;
            vm.prank(alice);
            vm.expectRevert(PredictionGameBase.NotWinner.selector);
            game.claimPrize(drawId, idx[band]);
        }
    }

    // ──────────────────────────────────────────────
    //  O(1) settlement
    // ──────────────────────────────────────────────

    /// @dev Settlement reads 44 liability buckets, never the bet array. Gas must not grow
    ///      with volume — otherwise the VRF callback eventually exceeds its 2.5M cap and
    ///      the game bricks exactly when it becomes popular.
    function test_settlementGasDoesNotGrowWithBetCount() public {
        // 3 bets
        for (uint8 i = 0; i < 3; i++) {
            _bet(alice, BetType.PICK1, bytes32(uint256(i + 1)), 1e6);
        }
        uint256 gasSmall = _measureSettlementGas(uint256(keccak256("small")));

        // 300 bets
        for (uint16 i = 0; i < 300; i++) {
            _bet(bob, BetType.PICK1, bytes32(uint256((i % 49) + 1)), 1e6);
        }
        uint256 gasLarge = _measureSettlementGas(uint256(keccak256("large")));

        assertApproxEqRel(gasLarge, gasSmall, 0.25e18, "settlement gas must be ~constant");
    }

    function _measureSettlementGas(uint256 word) internal returns (uint256 used) {
        skip(DRAW_INTERVAL + 1);
        vm.recordLogs();
        game.performUpkeep("");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 requestId;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == keccak256("DrawRequested(uint256,uint256)")) {
                requestId = abi.decode(logs[i].data, (uint256));
            }
        }

        uint256[] memory words = new uint256[](1);
        words[0] = word;
        uint256 before = gasleft();
        vrfCoordinator.fulfillRandomWordsWithOverride(requestId, address(game), words);
        used = before - gasleft();
    }

    // ──────────────────────────────────────────────
    //  Canonicalisation — a solvency issue, not a cosmetic one
    // ──────────────────────────────────────────────

    /// @dev (5,3) and (3,5) are the same bet. If they keyed different liability buckets,
    ///      settlement would enumerate only the ascending one and undercount what the house
    ///      owes — leaving a winner unpayable.
    function test_pick2IsOrderIndependent() public {
        uint256 a = _bet(alice, BetType.PICK2, _pick2(9, 4), 1e6);
        uint256 b = _bet(bob, BetType.PICK2, _pick2(4, 9), 1e6);

        (, , , bytes32 selA, ,) = game.getBet(1, a);
        (, , , bytes32 selB, ,) = game.getBet(1, b);
        assertEq(selA, selB, "both bets share one canonical selection");

        assertEq(
            game.liability(1, uint8(BetType.PICK2), selA),
            2 * OddsLib.payoutFor(1e6, BetType.PICK2, selA, EDGE_BPS),
            "both stakes land in the same bucket"
        );
    }

    // ──────────────────────────────────────────────
    //  Risk limits
    // ──────────────────────────────────────────────

    function test_maxPayoutPerBetRejectsHugeMultiplier() public {
        // All six balls green pays ~13,900x at an 8% edge — far past the $5,000 cap.
        vm.prank(alice);
        vm.expectRevert(PredictionGameBase.PayoutExceedsCap.selector);
        game.placeBet(uint8(BetType.RAINBOW), OddsLib.encodeRainbow(0, 0, 6, 0), 1e6, address(0));
    }

    function test_exposureLimitRejectsOversizedBook() public {
        // Tighten the cap to 1% of the bankroll ($1,000) so the limit is reachable.
        vm.prank(owner);
        game.setRiskParams(EDGE_BPS, MAX_PAYOUT, 100);

        // PICK1 at $100 owes ~$751. One fits under the cap; a second does not.
        _bet(alice, BetType.PICK1, bytes32(uint256(7)), 100e6);

        vm.prank(alice);
        vm.expectRevert(PredictionGameBase.ExposureLimitReached.selector);
        game.placeBet(uint8(BetType.PICK1), bytes32(uint256(7)), 100e6, address(0));
    }

    /// @dev PICK3 allows 20 simultaneous winners, but when only one selection has been backed
    ///      no result can pay more than that single bucket. The bound must recognise this,
    ///      or a $1 PICK3 bet gets throttled as though it were $20.
    function test_exposureBoundIsNotOverInflatedBySingleSelection() public {
        uint256 idx = _bet(alice, BetType.PICK3, bytes32(uint256(0x010203)), 5e6);
        (,,,,, uint256 payout) = game.getBet(1, idx);

        (uint256 exposure,) = game.currentExposure();
        assertEq(exposure, payout, "one backed selection means exposure is exactly its payout");
    }

    function test_exposureIsReportedAndCleared() public {
        _bet(alice, BetType.COLOR, bytes32(uint256(0)), 100e6);
        (uint256 exposure, uint256 allowed) = game.currentExposure();
        assertGt(exposure, 0);
        assertEq(allowed, (BANKROLL * MAX_EXPOSURE_BPS) / 10_000);
        assertEq(vault.lockedCollateral(), exposure, "vault mirrors the game's exposure");

        _draw(uint256(keccak256("clear")));
        assertEq(vault.lockedCollateral(), 0, "lock releases when the draw settles");
    }

    // ──────────────────────────────────────────────
    //  House P&L against the bankroll
    // ──────────────────────────────────────────────

    /// @dev A draw nobody wins is pure profit and must lift the LP share price.
    function test_houseProfitPushesToVaultAndLiftsSharePrice() public {
        uint256 word = uint256(keccak256("profit"));
        uint8 dominant = _peekDominantColour(word);
        uint256 priceBefore = vault.sharePrice();

        // Back a colour that is guaranteed NOT to come up.
        _bet(alice, BetType.COLOR, bytes32(uint256((dominant + 1) % 5)), 500e6);
        uint256 drawId = _draw(word);

        (,,,, uint256 totalPayout,) = game.getDrawResult(drawId);
        assertEq(totalPayout, 0, "the only bet must lose");

        assertEq(vault.totalAssets(), BANKROLL + game.drawRetained(drawId), "profit reached the vault");
        assertGt(vault.sharePrice(), priceBefore, "LP share price rose");
    }

    /// @dev A draw the house loses must pull from the bankroll and dilute LPs. Backing the
    ///      colour that actually comes up guarantees this: every multiplier exceeds 1x, so
    ///      the payout always beats the 97% of stake the house retained.
    function test_houseLossPullsFromVaultAndDilutesSharePrice() public {
        uint256 word = uint256(keccak256("loss"));
        uint8 dominant = _peekDominantColour(word);
        uint256 priceBefore = vault.sharePrice();

        _bet(alice, BetType.COLOR, bytes32(uint256(dominant)), 500e6);
        uint256 drawId = _draw(word);

        (,,,, uint256 totalPayout,) = game.getDrawResult(drawId);
        uint256 retained = game.drawRetained(drawId);
        assertGt(totalPayout, retained, "backing the winner must cost the house");

        assertEq(vault.totalAssets(), BANKROLL - (totalPayout - retained), "loss came out of the bankroll");
        assertLt(vault.sharePrice(), priceBefore, "LP share price fell");
        assertGe(usdc.balanceOf(address(game)), totalPayout, "the winner is fully funded");
    }

    /// @dev The VRF callback must never revert. If it could, a dropped settlement would pin
    ///      `drawPending` high forever and brick the game — how ColorColor v2 died. Here the
    ///      vault de-authorises the game mid-draw, the harshest version of that failure.
    function test_drawStillSettlesIfVaultRejectsSettlement() public {
        _bet(alice, BetType.COLOR, bytes32(uint256(0)), 100e6);

        skip(DRAW_INTERVAL + 1);
        game.performUpkeep("");

        // Pull the vault out from under the pending draw.
        vm.prank(owner);
        vault.setAuthorizedGame(address(game), false);

        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("orphaned"));
        nextRequestId++;
        vrfCoordinator.fulfillRandomWordsWithOverride(nextRequestId, address(game), words);

        (,,,,, bool settled) = game.getDrawResult(1);
        assertTrue(settled, "the draw must still settle");
        assertFalse(game.drawPending(), "the game must not be left stuck");
        assertEq(game.currentDrawId(), 2, "betting reopens on the next draw");
    }

    /// @dev The core solvency invariant: the game always holds enough to pay everyone owed.
    function test_solvencyInvariantAcrossManyDraws() public {
        for (uint256 round = 0; round < 5; round++) {
            for (uint8 band = 0; band < 3; band++) {
                _bet(alice, BetType.HILO, bytes32(uint256(band)), 50e6);
            }
            _bet(bob, BetType.COLOR, bytes32(uint256(round % 5)), 25e6);
            _bet(carol, BetType.PICK1, bytes32(uint256((round % 49) + 1)), 10e6);

            _draw(uint256(keccak256(abi.encode("round", round))));

            assertGe(
                usdc.balanceOf(address(game)),
                game.unclaimedLiability(),
                "contract must always cover unclaimed liability"
            );
        }
    }

    // ──────────────────────────────────────────────
    //  Vault behaviour
    // ──────────────────────────────────────────────

    function test_lpCannotWithdrawBelowLockedCollateral() public {
        _bet(alice, BetType.PICK1, bytes32(uint256(7)), 500e6);
        assertGt(vault.lockedCollateral(), 0);

        // Resolve the share balance first: an external call made after `expectRevert` is
        // armed would consume both the prank and the expectation.
        uint256 lpShares = vault.shares(lp);

        vm.prank(lp);
        vm.expectRevert(HouseVault.WouldUndercollateralize.selector);
        vault.withdraw(lpShares);
    }

    function test_onlyAuthorizedGameCanTouchBankroll() public {
        vm.prank(alice);
        vm.expectRevert(HouseVault.NotAuthorizedGame.selector);
        vault.pullLoss(1e6);

        vm.prank(alice);
        vm.expectRevert(HouseVault.NotAuthorizedGame.selector);
        vault.lockCollateral(1e6);
    }

    // ──────────────────────────────────────────────
    //  Claims
    // ──────────────────────────────────────────────

    function test_claimRevertsForNonOwnerAndDoubleClaim() public {
        uint256[3] memory idx;
        for (uint8 band = 0; band < 3; band++) {
            idx[band] = _bet(alice, BetType.HILO, bytes32(uint256(band)), 10e6);
        }
        uint256 drawId = _draw(uint256(keccak256("claims")));
        (,, uint16 sum,,,) = game.getDrawResult(drawId);
        uint256 winning = idx[_hiloBandOf(sum)];

        vm.prank(bob);
        vm.expectRevert(PredictionGameBase.NotBetOwner.selector);
        game.claimPrize(drawId, winning);

        vm.prank(alice);
        game.claimPrize(drawId, winning);

        vm.prank(alice);
        vm.expectRevert(PredictionGameBase.AlreadyClaimed.selector);
        game.claimPrize(drawId, winning);
    }

    function test_claimRevertsBeforeSettlement() public {
        uint256 idx = _bet(alice, BetType.COLOR, bytes32(uint256(0)), 1e6);
        vm.prank(alice);
        vm.expectRevert(PredictionGameBase.DrawNotSettled.selector);
        game.claimPrize(1, idx);
    }

    function test_getPlayerBetsListsOwnBetsOnly() public {
        _bet(alice, BetType.COLOR, bytes32(uint256(0)), 1e6);
        _bet(bob, BetType.COLOR, bytes32(uint256(1)), 1e6);
        _bet(alice, BetType.HILO, bytes32(uint256(2)), 1e6);

        assertEq(game.getPlayerBets(1, alice).length, 2);
        assertEq(game.getPlayerBets(1, bob).length, 1);
    }

    // ──────────────────────────────────────────────
    //  Draw gating
    // ──────────────────────────────────────────────

    /// @dev Draws run on the clock but not on an empty book — an empty draw would burn a
    ///      VRF request to decide nothing.
    function test_noDrawWithoutBets() public {
        skip(DRAW_INTERVAL + 1);
        (bool needed,) = game.checkUpkeep("");
        assertFalse(needed, "no bets, no draw");

        vm.expectRevert(PredictionGameBase.NotReadyToDraw.selector);
        game.performUpkeep("");
    }

    function test_noDrawBeforeInterval() public {
        _bet(alice, BetType.COLOR, bytes32(uint256(0)), 1e6);
        (bool needed,) = game.checkUpkeep("");
        assertFalse(needed, "interval has not elapsed");
    }

    function test_bettingClosedWhileDrawPending() public {
        _bet(alice, BetType.COLOR, bytes32(uint256(0)), 1e6);
        skip(DRAW_INTERVAL + 1);
        game.performUpkeep("");

        vm.prank(bob);
        vm.expectRevert(PredictionGameBase.BettingClosed.selector);
        game.placeBet(uint8(BetType.COLOR), bytes32(uint256(1)), 1e6, address(0));
    }

    /// @dev A dropped VRF callback pins `drawPending` high forever and bricks the game —
    ///      this happened to ColorColor v2 on Amoy. The escape hatch must re-arm it.
    function test_cancelPendingDrawUnsticksDroppedCallback() public {
        _bet(alice, BetType.COLOR, bytes32(uint256(0)), 1e6);
        skip(DRAW_INTERVAL + 1);
        game.performUpkeep("");
        assertTrue(game.drawPending());

        vm.prank(owner);
        game.cancelPendingDraw();
        assertFalse(game.drawPending());

        skip(DRAW_INTERVAL + 1);
        (bool needed,) = game.checkUpkeep("");
        assertTrue(needed, "game is playable again");
    }

    function test_cancelPendingDrawRevertsWhenNoneePending() public {
        vm.prank(owner);
        vm.expectRevert(PredictionGameBase.NoPendingDraw.selector);
        game.cancelPendingDraw();
    }

    // ──────────────────────────────────────────────
    //  Fees
    // ──────────────────────────────────────────────

    function test_referralAndTreasuryCutsComeOffGrossStake() public {
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(alice);
        game.placeBet(uint8(BetType.COLOR), bytes32(uint256(0)), 100e6, bob);

        // 2% referral to bob, 1% to treasury, 97% retained by the house.
        assertEq(referralManager.pendingCommission(bob), (100e6 * 200 / 10_000) * 8_000 / 10_000);
        assertGt(usdc.balanceOf(treasury), treasuryBefore);
        assertEq(game.drawRetained(1), 100e6 - 2e6 - 1e6);
    }

    function test_stakeBelowMinimumReverts() public {
        vm.prank(alice);
        vm.expectRevert(PredictionGameBase.StakeTooLow.selector);
        game.placeBet(uint8(BetType.COLOR), bytes32(uint256(0)), 99_999, address(0));
    }

    // ──────────────────────────────────────────────
    //  Admin
    // ──────────────────────────────────────────────

    /// @dev Changing the edge mid-draw would repricenbets already booked at the old odds,
    ///      because payout is recomputed at claim time.
    function test_riskParamsCannotChangeWhileDrawHasBets() public {
        _bet(alice, BetType.COLOR, bytes32(uint256(0)), 1e6);
        vm.prank(owner);
        vm.expectRevert(PredictionGameBase.BettingClosed.selector);
        game.setRiskParams(500, MAX_PAYOUT, MAX_EXPOSURE_BPS);
    }

    /// @dev VRF can be billed in LINK or the chain's native token, so an operator can run on
    ///      one funding token instead of two.
    ///
    ///      The operational trap, pinned here: the coordinator charges at FULFILMENT, not at
    ///      request. Switching onto an unfunded balance therefore does not fail cleanly — the
    ///      request goes out, the callback reverts, and the draw sits pending forever. That is
    ///      the same shape as the v2 brick, reached from a completely different cause, and the
    ///      only way out is `cancelPendingDraw`.
    function test_vrfPaymentModeIsSwitchable() public {
        assertFalse(game.s_nativePayment(), "defaults to LINK");

        vm.prank(alice);
        vm.expectRevert();
        game.setNativePayment(true);

        vm.prank(owner);
        game.setNativePayment(true);
        assertTrue(game.s_nativePayment());

        // Native balance is empty. The request is accepted...
        _bet(alice, BetType.COLOR, bytes32(uint256(0)), 10e6);
        skip(DRAW_INTERVAL + 1);
        game.performUpkeep("");
        assertTrue(game.drawPending(), "request went out");

        // ...but the callback cannot be paid for, so the draw wedges.
        nextRequestId++;
        uint256[] memory words = new uint256[](1);
        words[0] = uint256(keccak256("native"));
        vm.expectRevert();
        vrfCoordinator.fulfillRandomWordsWithOverride(nextRequestId, address(game), words);
        assertTrue(game.drawPending(), "still pending - this is the brick shape");

        // The escape hatch recovers it.
        vm.prank(owner);
        game.cancelPendingDraw();
        assertFalse(game.drawPending());

        // Fund the native side and the game runs normally again.
        vm.deal(owner, 10 ether);
        vm.prank(owner);
        vrfCoordinator.fundSubscriptionWithNative{value: 10 ether}(subId);

        skip(DRAW_INTERVAL + 1);
        game.performUpkeep("");
        nextRequestId++;
        vrfCoordinator.fulfillRandomWordsWithOverride(nextRequestId, address(game), words);

        (,,,,, bool settled) = game.getDrawResult(1);
        assertTrue(settled, "draw settles once the native balance is funded");
    }

    function test_pauseBlocksBetting() public {
        vm.prank(owner);
        game.pause();

        vm.prank(alice);
        vm.expectRevert();
        game.placeBet(uint8(BetType.COLOR), bytes32(uint256(0)), 1e6, address(0));
    }

    function test_onlyOwnerCanAdmin() public {
        vm.prank(alice);
        vm.expectRevert();
        game.setDrawInterval(60);
    }

    // ──────────────────────────────────────────────
    //  Allocation (Phase 0)
    // ──────────────────────────────────────────────

    /// @dev With several games on one vault, each sizes exposure against its own allocated
    ///      share, never the whole bankroll.
    function test_exposureCapUsesTheGamesAllocatedBankroll() public {
        vm.prank(owner);
        game.setRiskParams(EDGE_BPS, MAX_PAYOUT, 100); // 1% of the game's bankroll

        (, uint256 allowedFull) = game.currentExposure();
        assertEq(allowedFull, (BANKROLL * 100) / 10_000);

        vm.prank(owner);
        vault.setAllocation(address(game), 5_000);
        (, uint256 allowedHalf) = game.currentExposure();
        assertEq(allowedHalf, allowedFull / 2, "half the allocation, half the cap");

        // PICK1 at $100 owes ~$751: fits under $1,000, not under $500.
        vm.prank(alice);
        vm.expectRevert(PredictionGameBase.ExposureLimitReached.selector);
        game.placeBet(uint8(BetType.PICK1), bytes32(uint256(7)), 100e6, address(0));
    }

    function test_noAllocationMeansNoBets() public {
        vm.prank(owner);
        vault.setAllocation(address(game), 0);

        vm.prank(alice);
        vm.expectRevert(PredictionGameBase.ExposureLimitReached.selector);
        game.placeBet(uint8(BetType.COLOR), bytes32(uint256(0)), 1e6, address(0));
    }
}
