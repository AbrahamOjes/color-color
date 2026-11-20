// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {VirtualRace} from "../src/VirtualRace.sol";
import {RaceOddsLib} from "../src/RaceOddsLib.sol";
import {PredictionGameBase} from "../src/PredictionGameBase.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {ReferralManager} from "../src/ReferralManager.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";

/// @dev Exposes the sampler so it can be tested on a fixed card.
contract VirtualRaceHarness is VirtualRace {
    constructor(
        address _usdc,
        address _vrf,
        address _rm,
        address _vault,
        address _treasury,
        address _owner,
        uint256 _subId,
        uint256 _maxPayout,
        VirtualRace.Config memory _config
    )
        VirtualRace(
            _usdc, _vrf, _rm, _vault, _treasury, _owner, _subId, keccak256("test"), 2_000_000, 120, 800,
            _maxPayout, 10_000, _config
        )
    {}

    function sample(uint256[] memory w, uint256 word) external pure returns (bytes32) {
        return _sample(w, word);
    }
}

contract VirtualRaceTest is Test {
    VirtualRaceHarness race;
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

    uint256 constant INTERVAL = 120;
    uint256 constant CUTOFF = 10;
    uint256 constant BANKROLL = 1_000_000_000e6;

    uint8 constant WIN = 0;
    uint8 constant PLACE = 1;
    uint8 constant SHOW = 2;
    uint8 constant FC = 3;
    uint8 constant RFC = 4;
    uint8 constant TC = 5;
    uint8 constant ODD_EVEN = 6;
    uint8 constant HI_LO = 7;

    function setUp() public {
        vm.startPrank(owner);
        usdc = new ERC20Mock("USDC", "USDC", 6);
        vrfCoordinator = new VRFCoordinatorV2_5Mock(1e17, 1e9, 4e15);
        subId = vrfCoordinator.createSubscription();
        vrfCoordinator.fundSubscription(subId, 1000 ether);
        referralManager = new ReferralManager(address(usdc), treasury, owner);
        vault = new HouseVault(address(usdc), owner);
        vm.stopPrank();

        race = _deploy(6, CUTOFF, 10_000);

        usdc.mint(lp, BANKROLL);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(BANKROLL);
        vm.stopPrank();

        usdc.mint(alice, BANKROLL);
    }

    function _deploy(uint8 runners, uint256 cutoff, uint16 allocation) internal returns (VirtualRaceHarness g) {
        vm.startPrank(owner);
        g = new VirtualRaceHarness(
            address(usdc), address(vrfCoordinator), address(referralManager), address(vault), treasury, owner, subId,
            1e30, VirtualRace.Config({runners: runners, wMin: 5, wMax: 40, skinId: "greyhounds-v1", betCutoff: cutoff})
        );
        vrfCoordinator.addConsumer(subId, address(g));
        referralManager.setAuthorizedGame(address(g), true);
        vault.setAuthorizedGame(address(g), true);
        vault.setAllocation(address(g), allocation);
        vm.stopPrank();
        vm.prank(alice);
        usdc.approve(address(g), type(uint256).max);
    }

    function _bet(VirtualRace g, uint8 market, uint256 sel, uint256 stake) internal returns (uint256 idx, uint256 payout) {
        vm.prank(alice);
        return g.placeBet(market, bytes32(sel), stake, address(0));
    }

    function _settle(VirtualRace g, uint256 word) internal {
        skip(INTERVAL + 1);
        g.performUpkeep("");
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        vrfCoordinator.fulfillRandomWordsWithOverride(nextRequestId++, address(g), words);
    }

    function _card(VirtualRace g, uint256 drawId) internal view returns (uint256[] memory w) {
        uint16[] memory c = g.raceCard(drawId);
        w = new uint256[](c.length);
        for (uint256 i = 0; i < c.length; i++) w[i] = c[i];
    }

    function _exampleCard() internal pure returns (uint256[] memory w) {
        w = new uint256[](6);
        (w[0], w[1], w[2], w[3], w[4], w[5]) = (30, 22, 16, 12, 11, 9);
    }

    // ──────────────────────────────────────────────
    //  Config and card
    // ──────────────────────────────────────────────

    function test_config() public view {
        assertEq(race.RUNNERS(), 6);
        assertEq(race.W_MIN(), 5);
        assertEq(race.W_MAX(), 40);
        assertEq(race.SKIN_ID(), bytes32("greyhounds-v1"));
        assertEq(race.numMarkets(), 8);
        assertEq(race.betCutoff(), CUTOFF);
        for (uint8 m = 0; m < 8; m++) assertEq(race.marketEdgeBps(m), 800);
    }

    function test_constructorRejectsBadConfig() public {
        VirtualRace.Config[5] memory bad = [
            VirtualRace.Config(3, 5, 40, "", 0),
            VirtualRace.Config(13, 5, 40, "", 0),
            VirtualRace.Config(6, 0, 40, "", 0),
            VirtualRace.Config(6, 41, 40, "", 0),
            VirtualRace.Config(6, 5, 40, "", INTERVAL) // cutoff must leave the window open
        ];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(PredictionGameBase.InvalidConfig.selector);
            new VirtualRaceHarness(
                address(usdc), address(vrfCoordinator), address(referralManager), address(vault), treasury, owner,
                subId, 1e30, bad[i]
            );
        }
    }

    function test_bootstrapCard() public {
        bytes32 expected = keccak256(abi.encodePacked(blockhash(block.number - 1), address(race)));
        assertEq(race.cardSeed(1), expected);
        uint256[] memory w = _card(race, 1);
        assertEq(w.length, 6);
        for (uint256 i = 0; i < 6; i++) {
            assertEq(w[i], 5 + uint256(keccak256(abi.encode(expected, i))) % 36, "weight formula");
        }
        vm.expectRevert(VirtualRace.CardNotSet.selector);
        race.raceCard(2);
    }

    function test_cardAndReplayCommittedOnSettle() public {
        uint256 word = 0xC0FFEE;
        uint256[] memory before = _card(race, 1);
        _bet(race, WIN, 0, 1e6);
        assertEq(keccak256(abi.encode(_card(race, 1))), keccak256(abi.encode(before)), "card fixed while betting");
        assertEq(race.replaySeed(1), bytes32(0));

        _settle(race, word);

        assertEq(race.cardSeed(2), keccak256(abi.encodePacked(word, "card")));
        assertEq(race.replaySeed(1), keccak256(abi.encodePacked(word, "replay")));
        assertEq(keccak256(abi.encode(_card(race, 1))), keccak256(abi.encode(before)), "settled card unchanged");
        uint256[] memory next = _card(race, 2);
        for (uint256 i = 0; i < 6; i++) {
            assertEq(next[i], 5 + uint256(keccak256(abi.encode(race.cardSeed(2), i))) % 36);
        }
    }

    function test_raceResultIsSampledOrder() public {
        uint256 word = 12345;
        (,, bool settledBefore) = race.getRaceResult(1);
        assertFalse(settledBefore);

        _bet(race, WIN, 0, 1e6);
        _settle(race, word);

        (uint8[] memory order,, bool settled) = race.getRaceResult(1);
        assertTrue(settled);
        assertEq(order.length, 6);
        bytes32 expected = race.sample(_card(race, 1), word);
        (bytes32 outcome,,,) = race.draws(1);
        assertEq(outcome, expected);
        uint256 seen;
        for (uint256 p = 0; p < 6; p++) {
            assertEq(order[p], uint8(uint256(expected) >> (248 - 8 * p)));
            seen |= 1 << order[p];
        }
        assertEq(seen, 0x3f, "order is a permutation");
    }

    // ──────────────────────────────────────────────
    //  Selections
    // ──────────────────────────────────────────────

    function test_invalidSelectionsRevert() public {
        uint256[12] memory bad = [
            uint256(6),                 // WIN runner >= N
            uint256(1) << 8,            // WIN high bits
            (6 << 8) | 1,               // FC runner >= N
            (2 << 8) | 2,               // FC duplicate
            (1 << 16) | (2 << 8) | 1,   // TC duplicate
            (1 << 16) | (1 << 8) | 2,   // TC duplicate
            (0 << 16) | (6 << 8) | 2,   // TC runner >= N
            uint256(1) << 24 | 0x000102,// TC high bits
            2,                          // ODD/EVEN
            2,                          // HI/LO
            (4 << 8) | 4,               // RFC duplicate
            uint256(1) << 16 | 0x0001   // FC high bits
        ];
        uint8[12] memory markets = [WIN, WIN, FC, FC, TC, TC, TC, TC, ODD_EVEN, HI_LO, RFC, FC];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(alice);
            vm.expectRevert(VirtualRace.InvalidSelection.selector);
            race.placeBet(markets[i], bytes32(bad[i]), 1e6, address(0));
        }
        vm.prank(alice);
        vm.expectRevert(PredictionGameBase.InvalidMarket.selector);
        race.placeBet(8, bytes32(0), 1e6, address(0));
    }

    function test_reverseForecastCanonicalisedAndQuoted() public {
        (uint256 q1,) = race.quote(1, RFC, bytes32(uint256((3 << 8) | 1)), 1e6);
        (uint256 q2,) = race.quote(1, RFC, bytes32(uint256((1 << 8) | 3)), 1e6);
        assertEq(q1, q2);
        (uint256 idx, uint256 payout) = _bet(race, RFC, (3 << 8) | 1, 1e6);
        assertEq(payout, q1, "quote == booked payout");
        (,,, bytes32 sel,,) = race.getBet(1, idx);
        assertEq(sel, bytes32(uint256((1 << 8) | 3)), "stored sorted");
        assertEq(race.liability(1, RFC, bytes32(uint256((1 << 8) | 3))), payout);
    }

    function test_quoteMatchesPlaceBetForEveryMarket() public {
        uint256[8] memory sels = [uint256(0), 1, 2, (2 << 8) | 3, (0 << 8) | 5, (5 << 16) | (4 << 8) | 3, 1, 0];
        for (uint8 m = 0; m < 8; m++) {
            (uint256 q,) = race.quote(1, m, bytes32(sels[m]), 3e6);
            (, uint256 p) = _bet(race, m, sels[m], 3e6);
            assertEq(p, q);
            assertEq(p, RaceOddsLib.payoutFor(_card(race, 1), m, bytes32(sels[m]), 3e6, 800));
        }
    }

    // ──────────────────────────────────────────────
    //  Sampler fairness
    // ──────────────────────────────────────────────

    /// @dev 20,000 deterministic words on card [30,22,16,12,11,9]. Chi-square the winner
    ///      against w_i/W (df 5, critical 20.515 at p = 0.001) and the (1st, 2nd) pair against
    ///      the Plackett–Luce forecast probabilities (df 29, critical 58.301 at p = 0.001).
    ///      The pair test is second place against its distribution conditional on the winner.
    function test_samplerChiSquare() public view {
        uint256[] memory w = _exampleCard();
        uint256 W = 100;
        uint256 T = 20_000;
        uint256[6] memory winners;
        uint256[36] memory pairs;
        uint256[6] memory seconds_;

        for (uint256 k = 0; k < T; k++) {
            uint256 o = uint256(race.sample(w, uint256(keccak256(abi.encode(k)))));
            uint256 a = uint8(o >> 248);
            uint256 b = uint8(o >> 240);
            winners[a]++;
            seconds_[b]++;
            pairs[a * 6 + b]++;
        }

        // Σ (obs − T·w/W)² / (T·w/W) = Σ (obs·W − T·w)² / (W·T·w), in 1e18.
        uint256 chiWin;
        for (uint256 i = 0; i < 6; i++) {
            uint256 d = _absDiff(winners[i] * W, T * w[i]);
            chiWin += (d * d * 1e18) / (W * T * w[i]);
        }
        console2.log("winner chi-square x1e18 (df 5, crit 20.515):", chiWin);
        assertLt(chiWin, 20_515e15, "winner chi-square");

        uint256 chiPair;
        for (uint256 a = 0; a < 6; a++) {
            for (uint256 b = 0; b < 6; b++) {
                if (a == b) {
                    assertEq(pairs[a * 6 + b], 0);
                    continue;
                }
                (uint256 num, uint256 den) = RaceOddsLib.probForecast(w, a, b);
                uint256 d = _absDiff(pairs[a * 6 + b] * den, T * num);
                chiPair += (d * d * 1e18) / (den * T * num);
            }
        }
        console2.log("pair chi-square x1e18 (df 29, crit 58.301):", chiPair);
        assertLt(chiPair, 58_301e15, "pair chi-square");

        // Sanity on the marginal too: a 30-rated dog is second far more often than a 9.
        assertGt(seconds_[0], seconds_[5]);
    }

    function _absDiff(uint256 x, uint256 y) internal pure returns (uint256) {
        return x > y ? x - y : y - x;
    }

    // ──────────────────────────────────────────────
    //  Settlement equals claims
    // ──────────────────────────────────────────────

    function _anySelection(uint256 n, uint8 market, uint256 s) internal pure returns (uint256) {
        uint256 a = s % n;
        uint256 b = (a + 1 + (s >> 8) % (n - 1)) % n;
        uint256 c = (s >> 16) % n;
        while (c == a || c == b) c = (c + 1) % n;
        if (market <= SHOW) return a;
        if (market == FC || market == RFC) return (a << 8) | b; // RFC unsorted on purpose
        if (market == TC) return (a << 16) | (b << 8) | c;
        return s % 2;
    }

    /// @dev Independent of the contract's `_isWinner`: decide from the finishing order.
    function _wins(uint8[] memory order, uint8 market, uint256 sel) internal pure returns (bool) {
        uint256 a = order[0];
        uint256 b = order[1];
        uint256 c = order[2];
        if (market == WIN) return sel == a;
        if (market == PLACE) return sel == a || sel == b;
        if (market == SHOW) return sel == a || sel == b || sel == c;
        if (market == FC) return sel == ((a << 8) | b);
        if (market == RFC) return sel == ((a << 8) | b) || sel == ((b << 8) | a);
        if (market == TC) return sel == ((a << 16) | (b << 8) | c);
        if (market == ODD_EVEN) return sel == (a % 2 == 0 ? 0 : 1);
        return sel == (2 * (a + 1) > order.length ? 1 : 0);
    }

    function testFuzz_settlementEqualsClaims(uint8 runners, uint256 betSeed, uint8 count, uint256 word) public {
        runners = uint8(bound(runners, 4, 12));
        count = uint8(bound(count, 1, 24));
        vm.prank(owner);
        vault.setAllocation(address(race), 0);
        VirtualRaceHarness g = _deploy(runners, CUTOFF, 10_000);

        uint8[] memory markets = new uint8[](count);
        uint256[] memory sels = new uint256[](count);
        for (uint256 k = 0; k < count; k++) {
            uint256 h = uint256(keccak256(abi.encode(betSeed, k)));
            uint8 m = uint8(h % 8);
            uint256 sel = _anySelection(runners, m, h >> 8);
            // Repeat an earlier selection now and then, so buckets accumulate.
            if (k > 0 && (h >> 200) % 4 == 0) (m, sel) = (markets[k - 1], sels[k - 1]);
            markets[k] = m;
            sels[k] = sel;
            _bet(g, m, sel, 1e5 + (h >> 64) % 50e6);
        }

        _settle(g, word);

        (uint8[] memory order, uint256 totalPayout, bool settled) = g.getRaceResult(1);
        assertTrue(settled);

        uint256 owed;
        for (uint256 k = 0; k < count; k++) {
            (,,,,, uint256 payout) = g.getBet(1, k);
            bool won = g.isBetWinner(1, k);
            assertEq(won, _wins(order, markets[k], sels[k]), "_isWinner agrees with the order");
            if (won) owed += payout;
        }
        assertEq(totalPayout, owed, "settlement == claims");

        uint256 claimed;
        for (uint256 k = 0; k < count; k++) {
            if (!g.isBetWinner(1, k)) continue;
            vm.prank(alice);
            claimed += g.claimPrize(1, k);
        }
        assertEq(claimed, totalPayout);
        assertEq(g.unclaimedLiability(), 0);
    }

    // ──────────────────────────────────────────────
    //  Callback safety
    // ──────────────────────────────────────────────

    function _bookLosingDraw() internal {
        // Every tricast on the card: one of them must win, and it pays far more than all
        // the stakes combined, so the house is net down and settlement pulls a loss.
        for (uint256 a = 0; a < 6; a++) {
            for (uint256 b = 0; b < 6; b++) {
                if (a == b) continue;
                for (uint256 c = 0; c < 6; c++) {
                    if (c == a || c == b) continue;
                    _bet(race, TC, (a << 16) | (b << 8) | c, 1e6);
                }
            }
        }
    }

    function _requestDraw() internal {
        skip(INTERVAL + 1);
        race.performUpkeep("");
    }

    function _fulfil(uint256 word) internal {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        vrfCoordinator.fulfillRandomWordsWithOverride(nextRequestId++, address(race), words);
    }

    function _assertSettledAndReopened() internal view {
        (,, bool settled) = race.getRaceResult(1);
        assertTrue(settled, "race still settles");
        assertFalse(race.drawPending(), "game not stuck");
        assertEq(race.currentDrawId(), 2, "betting reopens");
        assertTrue(race.cardSeed(2) != bytes32(0), "next card committed");
    }

    function test_callbackSurvivesEmptyVault() public {
        _bookLosingDraw();
        _requestDraw();
        vm.startPrank(owner);
        HouseVault empty = new HouseVault(address(usdc), owner);
        empty.setAuthorizedGame(address(race), true);
        empty.setAllocation(address(race), 10_000);
        race.setHouseVault(address(empty));
        vm.stopPrank();
        _fulfil(7);
        _assertSettledAndReopened();
    }

    function test_callbackSurvivesEmptyUnauthorisedVault() public {
        _bookLosingDraw();
        _requestDraw();
        HouseVault stranger = new HouseVault(address(usdc), owner);
        vm.prank(owner);
        race.setHouseVault(address(stranger));
        vm.expectEmit(true, false, false, false, address(race));
        emit PredictionGameBase.HouseSettlementFailed(1, false, 0);
        _fulfil(7);
        _assertSettledAndReopened();
    }

    function test_callbackSurvivesDeauthorisedVault() public {
        _bookLosingDraw();
        _requestDraw();
        vm.prank(owner);
        vault.setAuthorizedGame(address(race), false);
        _fulfil(7);
        _assertSettledAndReopened();
    }

    /// @dev Any word, any field size: the callback settles and opens the next race.
    function testFuzz_callbackNeverReverts(uint8 runners, uint256 word) public {
        runners = uint8(bound(runners, 4, 12));
        vm.prank(owner);
        vault.setAllocation(address(race), 0);
        VirtualRaceHarness g = _deploy(runners, CUTOFF, 10_000);
        _bet(g, TC, (0 << 16) | (1 << 8) | 2, 1e6);
        _bet(g, SHOW, runners - 1, 1e6);
        _settle(g, word);
        (uint8[] memory order,, bool settled) = g.getRaceResult(1);
        assertTrue(settled);
        assertEq(order.length, runners);
        assertEq(g.currentDrawId(), 2);
        assertFalse(g.drawPending());
    }

    // ──────────────────────────────────────────────
    //  Bet cutoff
    // ──────────────────────────────────────────────

    function test_betAfterCutoffReverts() public {
        uint256 closes = race.lastDrawTimestamp() + INTERVAL - CUTOFF;
        assertEq(race.bettingClosesAt(), closes);

        vm.warp(closes - 1);
        _bet(race, WIN, 0, 1e6);

        vm.warp(closes);
        vm.prank(alice);
        vm.expectRevert(PredictionGameBase.BettingClosed.selector);
        race.placeBet(WIN, bytes32(0), 1e6, address(0));

        // Still closed after the interval, until upkeep fires and settlement reopens betting.
        vm.warp(closes + CUTOFF + 5);
        vm.prank(alice);
        vm.expectRevert(PredictionGameBase.BettingClosed.selector);
        race.placeBet(WIN, bytes32(0), 1e6, address(0));
    }

    /// @dev A round whose window passes with no bets rolls forward on the interval grid
    ///      instead of staying closed forever.
    function test_idleRoundRollsForward() public {
        uint256 start = race.lastDrawTimestamp();
        vm.warp(start + 3 * INTERVAL + 115); // inside the 4th window's cutoff

        uint256 expectedStart = start + 4 * INTERVAL;
        assertEq(race.bettingClosesAt(), expectedStart + INTERVAL - CUTOFF, "countdown on the grid");

        _bet(race, WIN, 0, 1e6);
        assertEq(race.lastDrawTimestamp(), expectedStart, "round start rolled forward");
        assertEq(race.timeUntilDraw(), expectedStart + INTERVAL - block.timestamp);

        (bool ready,) = race.checkUpkeep("");
        assertFalse(ready, "the draw waits for the rolled round");
        vm.warp(expectedStart + INTERVAL);
        (ready,) = race.checkUpkeep("");
        assertTrue(ready);
    }

    function test_cutoffSetterValidation() public {
        vm.startPrank(owner);
        vm.expectRevert(PredictionGameBase.InvalidConfig.selector);
        race.setBetCutoff(INTERVAL);
        vm.expectRevert(PredictionGameBase.InvalidConfig.selector);
        race.setDrawInterval(CUTOFF);
        race.setBetCutoff(30);
        assertEq(race.betCutoff(), 30);
        assertEq(race.bettingClosesAt(), race.lastDrawTimestamp() + INTERVAL - 30);
        race.setBetCutoff(0);
        race.setDrawInterval(1);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert();
        race.setBetCutoff(5);
    }

    // ──────────────────────────────────────────────
    //  Per-market edge
    // ──────────────────────────────────────────────

    function test_setMarketEdge() public {
        vm.startPrank(owner);
        race.setMarketEdge(TC, 1_500);
        assertEq(race.marketEdgeBps(TC), 1_500);
        assertEq(race.marketEdgeBps(WIN), 800);
        vm.expectRevert(PredictionGameBase.InvalidConfig.selector);
        race.setMarketEdge(TC, 2_001);
        vm.expectRevert(PredictionGameBase.InvalidMarket.selector);
        race.setMarketEdge(8, 800);
        vm.stopPrank();

        (, uint256 payout) = _bet(race, TC, (5 << 16) | (4 << 8) | 3, 1e6);
        assertEq(payout, RaceOddsLib.payoutFor(_card(race, 1), TC, bytes32(uint256(0x050403)), 1e6, 1_500));

        vm.prank(owner);
        vm.expectRevert(PredictionGameBase.BettingClosed.selector);
        race.setMarketEdge(WIN, 900);
    }

    /// @dev An edge change after settlement must not change what a settled winner is paid,
    ///      or claims would disagree with the reserved totalPayout.
    function test_claimPaysBookedEdgeAfterEdgeChange() public {
        uint256 word = 99;
        bytes32 o = race.sample(_card(race, 1), word);
        uint256 winner = uint8(uint256(o) >> 248);

        (uint256 idx, uint256 booked) = _bet(race, WIN, winner, 10e6);
        _settle(race, word);
        (,, uint256 totalPayout,) = race.draws(1);
        assertEq(totalPayout, booked);

        vm.prank(owner);
        race.setMarketEdge(WIN, 0); // allowed: race 2 has no bets
        assertEq(race.bookedEdgeBps(1, WIN), 800);

        (,,,,, uint256 shown) = race.getBet(1, idx);
        assertEq(shown, booked);
        vm.prank(alice);
        assertEq(race.claimPrize(1, idx), booked, "claim pays the booked edge");
        assertEq(race.unclaimedLiability(), 0);
    }

    // ──────────────────────────────────────────────
    //  Settlement gas
    // ──────────────────────────────────────────────

    /// @dev The callback reads 11 buckets whatever the volume; 12 runners is the worst case.
    function test_callbackGasBounded() public {
        vm.prank(owner);
        vault.setAllocation(address(race), 0);
        VirtualRaceHarness g = _deploy(12, CUTOFF, 10_000);
        for (uint8 m = 0; m < 8; m++) _bet(g, m, _anySelection(12, m, 7), 1e6);
        skip(INTERVAL + 1);
        g.performUpkeep("");
        uint256[] memory words = new uint256[](1);
        words[0] = 42;
        uint256 before = gasleft();
        vrfCoordinator.fulfillRandomWordsWithOverride(nextRequestId++, address(g), words);
        uint256 used = before - gasleft();
        console2.log("fulfil gas, 12 runners:", used);
        assertLt(used, 500_000, "fulfil well under the 2M callback limit");
    }
}
