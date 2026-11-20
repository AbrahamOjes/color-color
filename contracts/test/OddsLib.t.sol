// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OddsLib, BetType} from "../src/OddsLib.sol";

/// @dev `vm.expectRevert` only observes reverts from a deeper call frame, and OddsLib's
///      functions are `internal` so they inline into the caller. This wrapper gives the
///      validation tests an external boundary to revert across.
contract OddsHarness {
    function validate(BetType t, bytes32 sel) external pure {
        OddsLib.validate(t, sel);
    }
}

/// @notice Pins the fixed-odds table.
///
/// The partition invariants below are the load-bearing tests in this codebase: mispriced
/// odds drain the bankroll silently and without limit, and no other test would notice. A
/// bet type's win counts must sum to exactly C(49,6) — a single mistyped constant cannot
/// satisfy that without a second, compensating error.
///
/// Regenerate the expected values with `python3 script/odds/generate.py`.
contract OddsLibTest is Test {
    uint256 constant TOTAL = 13_983_816; // C(49,6)
    uint256 constant EDGE = 500;         // 5%
    uint256 constant STAKE = 1e6;        // $1 USDC

    OddsHarness harness;

    function setUp() public {
        harness = new OddsHarness();
    }

    // ──────────────────────────────────────────────
    //  Partition invariants
    // ──────────────────────────────────────────────

    function test_colourWinCountsPartitionTotal() public pure {
        uint256 sum;
        for (uint256 c = 0; c <= 4; c++) {
            sum += OddsLib.winCount(BetType.COLOR, bytes32(c));
        }
        assertEq(sum, TOTAL, "COLOR outcomes must partition C(49,6)");
    }

    function test_hiloWinCountsPartitionTotal() public pure {
        uint256 sum;
        for (uint256 b = 0; b <= 2; b++) {
            sum += OddsLib.winCount(BetType.HILO, bytes32(b));
        }
        assertEq(sum, TOTAL, "HILO bands must partition C(49,6)");
    }

    function test_rainbowWinCountsPartitionTotal() public pure {
        uint256 sum;
        uint256 n;
        for (uint8 r = 0; r <= 6; r++) {
            for (uint8 y = 0; y + r <= 6; y++) {
                for (uint8 g = 0; g + y + r <= 6; g++) {
                    uint8 b = 6 - r - y - g;
                    sum += OddsLib.winCount(BetType.RAINBOW, OddsLib.encodeRainbow(r, y, g, b));
                    n++;
                }
            }
        }
        assertEq(n, 84, "there are 84 colour distributions of 6 balls into 4 colours");
        assertEq(sum, TOTAL, "RAINBOW outcomes must partition C(49,6)");
    }

    function test_pickWinCountsMatchCombinatorics() public pure {
        // C(48,5), C(47,4), C(46,3) — the other 6-k balls drawn from the remaining 49-k.
        assertEq(OddsLib.winCount(BetType.PICK1, bytes32(uint256(7))), 1_712_304);
        assertEq(OddsLib.winCount(BetType.PICK2, bytes32(uint256(0x0107))), 178_365);
        assertEq(OddsLib.winCount(BetType.PICK3, bytes32(uint256(0x010207))), 15_180);
    }

    // ──────────────────────────────────────────────
    //  The two asymmetries that flat odds would get wrong
    // ──────────────────────────────────────────────

    /// @dev Blue spans 37-49 (13 numbers) vs 12 for the others, so it wins more often and
    ///      must pay less. Flat "any colour pays the same" odds would leak on every Blue bet.
    function test_bluePaysLessThanOtherColours() public pure {
        uint256 red = OddsLib.payoutFor(STAKE, BetType.COLOR, bytes32(uint256(0)), EDGE);
        uint256 yellow = OddsLib.payoutFor(STAKE, BetType.COLOR, bytes32(uint256(1)), EDGE);
        uint256 green = OddsLib.payoutFor(STAKE, BetType.COLOR, bytes32(uint256(2)), EDGE);
        uint256 blue = OddsLib.payoutFor(STAKE, BetType.COLOR, bytes32(uint256(3)), EDGE);

        assertEq(red, yellow, "Red and Yellow both hold 12 numbers");
        assertEq(red, green, "Red and Green both hold 12 numbers");
        assertLt(blue, red, "Blue holds 13 numbers so must pay less");
    }

    /// @dev Sum of 6 balls averages 150. Lo (<=120) is 30 below it, Hi (>=160) only 10
    ///      above, so Hi is far likelier and must pay less. The bands are not symmetric.
    function test_hiloLoPaysMoreThanHi() public pure {
        uint256 lo = OddsLib.payoutFor(STAKE, BetType.HILO, bytes32(uint256(0)), EDGE);
        uint256 mid = OddsLib.payoutFor(STAKE, BetType.HILO, bytes32(uint256(1)), EDGE);
        uint256 hi = OddsLib.payoutFor(STAKE, BetType.HILO, bytes32(uint256(2)), EDGE);

        assertGt(lo, hi, "Lo is rarer than Hi and must pay more");
        assertGt(hi, mid, "Mid is the most likely band and must pay least");
    }

    // ──────────────────────────────────────────────
    //  Exact payouts
    // ──────────────────────────────────────────────

    function test_exactPayoutsAtFivePercentEdge() public pure {
        assertEq(OddsLib.payoutFor(STAKE, BetType.PICK1, bytes32(uint256(7)), EDGE), 7_758_333);
        assertEq(OddsLib.payoutFor(STAKE, BetType.PICK2, bytes32(uint256(0x0107)), EDGE), 74_480_000);
        assertEq(OddsLib.payoutFor(STAKE, BetType.PICK3, bytes32(uint256(0x010207)), EDGE), 875_140_000);

        assertEq(OddsLib.payoutFor(STAKE, BetType.COLOR, bytes32(uint256(0)), EDGE), 6_956_838);
        assertEq(OddsLib.payoutFor(STAKE, BetType.COLOR, bytes32(uint256(3)), EDGE), 5_648_758);
        assertEq(OddsLib.payoutFor(STAKE, BetType.COLOR, bytes32(uint256(4)), EDGE), 2_250_371);

        assertEq(OddsLib.payoutFor(STAKE, BetType.HILO, bytes32(uint256(0)), EDGE), 5_031_879);
        assertEq(OddsLib.payoutFor(STAKE, BetType.HILO, bytes32(uint256(1)), EDGE), 2_248_929);
        assertEq(OddsLib.payoutFor(STAKE, BetType.HILO, bytes32(uint256(2)), EDGE), 2_443_538);

        assertEq(OddsLib.payoutFor(STAKE, BetType.RAINBOW, OddsLib.encodeRainbow(2, 1, 1, 2), EDGE), 17_920_423);
        assertEq(OddsLib.payoutFor(STAKE, BetType.RAINBOW, OddsLib.encodeRainbow(3, 1, 1, 1), EDGE), 32_256_762);
    }

    /// @dev The rarest colour distribution pays over 14,000x, which is why a per-bet payout
    ///      cap in ColorColor is mandatory rather than defensive.
    function test_rarestRainbowIsEnormous() public pure {
        uint256 payout = OddsLib.payoutFor(STAKE, BetType.RAINBOW, OddsLib.encodeRainbow(0, 0, 6, 0), EDGE);
        assertEq(payout, 14_377_300_000, "all six balls green pays ~14,377x");
    }

    function test_zeroEdgeIsFairOdds() public pure {
        // With no edge, PICK1 pays exactly 49/6 — the fair price.
        assertEq(OddsLib.payoutFor(6e6, BetType.PICK1, bytes32(uint256(7)), 0), 49e6);
    }

    // ──────────────────────────────────────────────
    //  Canonicalisation
    // ──────────────────────────────────────────────

    /// @dev Selections key the liability buckets that make settlement O(1). If (5,3) and
    ///      (3,5) keyed different buckets, settlement would enumerate only the sorted one
    ///      and undercount what the house owes — a solvency hole, not a cosmetic one.
    function test_canonicalizeMakesPickOrderIrrelevant() public pure {
        bytes32 a = OddsLib.canonicalize(BetType.PICK2, bytes32(uint256(0x0503)));
        bytes32 b = OddsLib.canonicalize(BetType.PICK2, bytes32(uint256(0x0305)));
        assertEq(a, b, "PICK2 must be order-independent");
        assertEq(uint256(a), 0x0305, "canonical form is ascending");

        bytes32 c = OddsLib.canonicalize(BetType.PICK3, bytes32(uint256(0x090103)));
        bytes32 d = OddsLib.canonicalize(BetType.PICK3, bytes32(uint256(0x010309)));
        assertEq(c, d, "PICK3 must be order-independent");
        assertEq(uint256(c), 0x010309, "canonical form is ascending");
    }

    function testFuzz_canonicalizeIsIdempotent(uint8 a, uint8 b, uint8 c) public pure {
        a = uint8(bound(a, 1, 49));
        b = uint8(bound(b, 1, 49));
        c = uint8(bound(c, 1, 49));

        bytes32 sel = bytes32((uint256(a) << 16) | (uint256(b) << 8) | uint256(c));
        bytes32 once = OddsLib.canonicalize(BetType.PICK3, sel);
        assertEq(OddsLib.canonicalize(BetType.PICK3, once), once);

        (uint8 x, uint8 y, uint8 z) =
            (uint8(uint256(once) >> 16), uint8(uint256(once) >> 8), uint8(uint256(once)));
        assertLe(x, y);
        assertLe(y, z);
    }

    // ──────────────────────────────────────────────
    //  Fuzz
    // ──────────────────────────────────────────────

    /// @dev Every winning bet must return more than it staked, at any edge we'd ever set.
    function testFuzz_winningBetAlwaysBeatsStake(uint256 stake, uint8 rawType, uint256 edgeBps)
        public
        pure
    {
        stake = bound(stake, 1e5, 1e12);
        edgeBps = bound(edgeBps, 0, 2000);
        BetType t = BetType(bound(rawType, 0, 5));

        bytes32 sel = _someSelection(t);
        uint256 payout = OddsLib.payoutFor(stake, t, sel, edgeBps);
        assertGt(payout, stake, "a win must beat the stake");
    }

    /// @dev The realised edge must match the configured edge. Guards against a win count
    ///      that is internally consistent but priced wrong.
    function testFuzz_impliedEdgeMatchesConfiguredEdge(uint8 rawType, uint256 edgeBps) public pure {
        edgeBps = bound(edgeBps, 0, 2000);
        BetType t = BetType(bound(rawType, 0, 5));
        bytes32 sel = _someSelection(t);

        uint256 wc = OddsLib.winCount(t, sel);
        // Expected value of a unit stake = P(win) * multiplier = (wc / TOTAL) * mult.
        // Scaled by 1e18 to keep precision, this must equal (10_000 - edge) / 10_000.
        uint256 evBps = (OddsLib.multiplierBps(t, sel, edgeBps) * wc) / TOTAL;
        assertApproxEqAbs(evBps, 10_000 - edgeBps, 2, "implied edge must match configured edge");
    }

    function _someSelection(BetType t) internal pure returns (bytes32) {
        if (t == BetType.PICK1) return bytes32(uint256(7));
        if (t == BetType.PICK2) return bytes32(uint256(0x0107));
        if (t == BetType.PICK3) return bytes32(uint256(0x010207));
        if (t == BetType.COLOR) return bytes32(uint256(2));
        if (t == BetType.HILO) return bytes32(uint256(1));
        return OddsLib.encodeRainbow(2, 1, 1, 2);
    }

    // ──────────────────────────────────────────────
    //  Validation
    // ──────────────────────────────────────────────

    function test_validateRejectsOutOfRange() public {
        vm.expectRevert(OddsLib.InvalidSelection.selector);
        harness.validate(BetType.PICK1, bytes32(uint256(50)));

        vm.expectRevert(OddsLib.InvalidSelection.selector);
        harness.validate(BetType.PICK1, bytes32(uint256(0)));

        vm.expectRevert(OddsLib.InvalidSelection.selector);
        harness.validate(BetType.PICK2, bytes32(uint256(0x0707))); // duplicate

        vm.expectRevert(OddsLib.InvalidSelection.selector);
        harness.validate(BetType.COLOR, bytes32(uint256(5)));

        vm.expectRevert(OddsLib.InvalidSelection.selector);
        harness.validate(BetType.HILO, bytes32(uint256(3)));

        vm.expectRevert(OddsLib.InvalidSelection.selector);
        harness.validate(BetType.RAINBOW, OddsLib.encodeRainbow(1, 1, 1, 1)); // sums to 4, not 6
    }

    /// @dev Dirty high bits must not sneak past validation into a liability bucket key.
    function test_validateRejectsDirtyHighBits() public {
        vm.expectRevert(OddsLib.InvalidSelection.selector);
        harness.validate(BetType.PICK1, bytes32(uint256(0x0100) | 7));

        vm.expectRevert(OddsLib.InvalidSelection.selector);
        harness.validate(BetType.COLOR, bytes32(uint256(0x10000) | 2));
    }

    function test_validateAcceptsWellFormed() public pure {
        OddsLib.validate(BetType.PICK1, bytes32(uint256(49)));
        OddsLib.validate(BetType.PICK2, bytes32(uint256(0x0103)));
        OddsLib.validate(BetType.PICK3, bytes32(uint256(0x010203)));
        OddsLib.validate(BetType.COLOR, bytes32(uint256(4)));
        OddsLib.validate(BetType.HILO, bytes32(uint256(2)));
        OddsLib.validate(BetType.RAINBOW, OddsLib.encodeRainbow(6, 0, 0, 0));
    }

    function test_colourOfMatchesRanges() public pure {
        assertEq(OddsLib.colourOf(1), 0);
        assertEq(OddsLib.colourOf(12), 0);
        assertEq(OddsLib.colourOf(13), 1);
        assertEq(OddsLib.colourOf(24), 1);
        assertEq(OddsLib.colourOf(25), 2);
        assertEq(OddsLib.colourOf(36), 2);
        assertEq(OddsLib.colourOf(37), 3);
        assertEq(OddsLib.colourOf(49), 3);
    }
}
