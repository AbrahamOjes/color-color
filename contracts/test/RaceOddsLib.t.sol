// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RaceOddsLib} from "../src/RaceOddsLib.sol";
import {RaceOddsFixture as F} from "./fixtures/RaceOddsFixture.sol";

/// @notice Pricing invariants for RaceOddsLib, fuzzed over cards, plus exact parity with
///         contracts/script/odds/race.py on the example card.
contract RaceOddsLibTest is Test {
    uint256 constant ONE = 1e18;

    /// @dev A random card: N in [4, 12], weights in [1, maxWeight], maxWeight ≤ 65535.
    function _card(uint256 seed, uint256 n, uint256 maxWeight) internal pure returns (uint256[] memory w) {
        n = bound(n, 4, 12);
        maxWeight = bound(maxWeight, 1, type(uint16).max);
        w = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            w[i] = 1 + uint256(keccak256(abi.encode(seed, i))) % maxWeight;
        }
    }

    // ──────────────────────────────────────────────
    //  Partitions
    // ──────────────────────────────────────────────

    function testFuzz_winSumsToOne(uint256 seed, uint256 n, uint256 maxW) public pure {
        uint256[] memory w = _card(seed, n, maxW);
        uint256 sum;
        uint256 W = RaceOddsLib.total(w);
        for (uint256 i = 0; i < w.length; i++) {
            (uint256 num, uint256 den) = RaceOddsLib.probWin(w, i);
            assertEq(den, W);
            sum += num;
        }
        assertEq(sum, W, "sum WIN == 1");
    }

    /// @dev Exact: for each winner a, the forecasts (a, ·) share one denominator, and their
    ///      numerators sum to exactly WIN(a). Since Σ WIN = 1, Σ FC = 1.
    function testFuzz_forecastSumsToOne(uint256 seed, uint256 n, uint256 maxW) public pure {
        uint256[] memory w = _card(seed, n, maxW);
        uint256 W = RaceOddsLib.total(w);
        uint256 winSum;
        for (uint256 a = 0; a < w.length; a++) {
            uint256 groupNum;
            uint256 groupDen;
            for (uint256 b = 0; b < w.length; b++) {
                if (a == b) continue;
                (uint256 num, uint256 den) = RaceOddsLib.probForecast(w, a, b);
                if (groupDen == 0) groupDen = den;
                assertEq(den, groupDen, "shared denominator");
                groupNum += num;
            }
            // groupNum / groupDen == w[a] / W
            assertEq(groupNum * W, w[a] * groupDen, "FC(a, .) == WIN(a)");
            winSum += w[a];
        }
        assertEq(winSum, W);
    }

    /// @dev Exact: for each (a, b), the tricasts (a, b, ·) share one denominator and sum to
    ///      exactly FC(a, b). Since Σ FC = 1, Σ TC = 1.
    function testFuzz_tricastSumsToOne(uint256 seed, uint256 n, uint256 maxW) public pure {
        uint256[] memory w = _card(seed, n, maxW);
        uint256 N = w.length;
        for (uint256 a = 0; a < N; a++) {
            for (uint256 b = 0; b < N; b++) {
                if (a == b) continue;
                uint256 groupNum;
                uint256 groupDen;
                for (uint256 c = 0; c < N; c++) {
                    if (c == a || c == b) continue;
                    (uint256 num, uint256 den) = RaceOddsLib.probTricast(w, a, b, c);
                    if (groupDen == 0) groupDen = den;
                    assertEq(den, groupDen, "shared denominator");
                    groupNum += num;
                }
                (uint256 fNum, uint256 fDen) = RaceOddsLib.probForecast(w, a, b);
                assertEq(groupNum * fDen, fNum * groupDen, "TC(a, b, .) == FC(a, b)");
            }
        }
    }

    function testFuzz_reverseForecastIsBothForecasts(uint256 seed, uint256 n, uint256 maxW, uint256 a, uint256 b)
        public
        pure
    {
        uint256[] memory w = _card(seed, n, maxW);
        a = bound(a, 0, w.length - 1);
        b = bound(b, 0, w.length - 1);
        vm.assume(a != b);
        (uint256 n1, uint256 d1) = RaceOddsLib.probForecast(w, a, b);
        (uint256 n2, uint256 d2) = RaceOddsLib.probForecast(w, b, a);
        (uint256 nr, uint256 dr) = RaceOddsLib.probReverseForecast(w, a, b);
        assertEq(nr * d1 * d2, (n1 * d2 + n2 * d1) * dr);
    }

    function testFuzz_oddEvenAndHiLoPartition(uint256 seed, uint256 n, uint256 maxW) public pure {
        uint256[] memory w = _card(seed, n, maxW);
        uint256 W = RaceOddsLib.total(w);
        (uint256 odd,) = RaceOddsLib.probOddEven(w, 0);
        (uint256 even,) = RaceOddsLib.probOddEven(w, 1);
        (uint256 lo,) = RaceOddsLib.probHiLo(w, 0);
        (uint256 hi,) = RaceOddsLib.probHiLo(w, 1);
        assertEq(odd + even, W);
        assertEq(lo + hi, W);
        assertGt(odd, 0);
        assertGt(even, 0);
        assertGt(lo, 0);
        assertGt(hi, 0);
    }

    /// @dev Σ PLACE ≥ 2 and Σ SHOW ≥ 3, each over by at most N² wei; PLACE ≤ SHOW per runner.
    function testFuzz_placeAndShowPartition(uint256 seed, uint256 n, uint256 maxW) public pure {
        uint256[] memory w = _card(seed, n, maxW);
        uint256 N = w.length;
        uint256 sumPlace;
        uint256 sumShow;
        for (uint256 i = 0; i < N; i++) {
            uint256 p = RaceOddsLib.probPlace1e18(w, i);
            uint256 s = RaceOddsLib.probShow1e18(w, i);
            assertLe(p, s, "PLACE <= SHOW");
            assertLe(s, ONE, "SHOW <= 1");
            sumPlace += p;
            sumShow += s;
        }
        assertGe(sumPlace, 2 * ONE, "sum PLACE >= 2");
        assertLe(sumPlace, 2 * ONE + N * N, "sum PLACE <= 2 + N^2 wei");
        assertGe(sumShow, 3 * ONE, "sum SHOW >= 3");
        assertLe(sumShow, 3 * ONE + N * N, "sum SHOW <= 3 + N^2 wei");
    }

    // ──────────────────────────────────────────────
    //  Payout bound
    // ──────────────────────────────────────────────

    /// @dev payout ≤ stake · (1 − edge) / P for every market, with P the exact probability
    ///      for exact markets and the rounded-up probability for PLACE/SHOW.
    function testFuzz_payoutNeverAboveFair(
        uint256 seed,
        uint256 n,
        uint256 maxW,
        uint256 marketSeed,
        uint256 selSeed,
        uint256 stake,
        uint256 edge
    ) public pure {
        uint256[] memory w = _card(seed, n, maxW);
        uint8 market = uint8(bound(marketSeed, 0, 7));
        bytes32 sel = _anySelection(w.length, market, selSeed);
        stake = bound(stake, 1, type(uint96).max);
        edge = bound(edge, 0, 2_000);

        uint256 payout = RaceOddsLib.payoutFor(w, market, sel, stake, edge);
        (uint256 num, uint256 den) = RaceOddsLib.probability(w, market, sel);
        assertLe(payout * num * 10_000, stake * den * (10_000 - edge), "payout above fair");
        // And truncation costs the player less than one unit.
        assertGt((payout + 1) * num * 10_000, stake * den * (10_000 - edge), "truncation only");
    }

    /// @dev A valid selection for `market` built from a seed.
    function _anySelection(uint256 n, uint8 market, uint256 s) internal pure returns (bytes32) {
        uint256 a = s % n;
        uint256 b = (a + 1 + (s >> 8) % (n - 1)) % n;
        uint256 c = (s >> 16) % n;
        while (c == a || c == b) c = (c + 1) % n;
        if (market <= 2) return bytes32(a);
        if (market == 3) return bytes32((a << 8) | b);
        if (market == 4) return a < b ? bytes32((a << 8) | b) : bytes32((b << 8) | a);
        if (market == 5) return bytes32((a << 16) | (b << 8) | c);
        return bytes32(s % 2);
    }

    // ──────────────────────────────────────────────
    //  Parity with race.py
    // ──────────────────────────────────────────────

    /// @dev Every selection of every market on [30,22,16,12,11,9] pays exactly what
    ///      race.py computes with fractions.Fraction and the contract's rounding.
    function test_matchesRacePy() public pure {
        uint256[] memory w = F.card();
        F.Row[] memory rows = F.rows();
        assertEq(rows.length, F.COUNT);
        for (uint256 k = 0; k < rows.length; k++) {
            assertEq(
                RaceOddsLib.payoutFor(w, rows[k].market, bytes32(rows[k].selection), F.STAKE, F.EDGE_BPS),
                rows[k].payout,
                "race.py parity"
            );
        }
    }

    /// @dev The two headline prices from the product spec, for card [30,22,16,12,11,9] at 8%.
    function test_examplePrices() public pure {
        uint256[] memory w = F.card();
        // WIN trap 1: 3.07x.
        assertEq(RaceOddsLib.payoutFor(w, 0, bytes32(uint256(0)), 1e6, 800), 3_066_666);
        // TRICAST 6→5→4 (0-based 5,4,3): 563.8x.
        assertEq(RaceOddsLib.payoutFor(w, 5, bytes32(uint256((5 << 16) | (4 << 8) | 3)), 1e6, 800), 563_771_043);
        assertEq(RaceOddsLib.multiplierBps(w, 5, bytes32(uint256((5 << 16) | (4 << 8) | 3)), 800), 5_637_710);
    }
}
