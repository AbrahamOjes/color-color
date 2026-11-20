// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title RaceOddsLib
/// @notice Exact pricing for a Plackett–Luce race. Every function takes the race card's
///         weights explicitly, so it can be tested against any card.
///
///  For weights w with sum W, an ordered prefix r1, r2, …, rk has probability
///      Π_t  w[r_t] / (W − Σ_{s<t} w[r_s])
///  WIN, FORECAST and TRICAST are prefixes of length 1, 2 and 3. REVERSE FORECAST, ODD/EVEN
///  and HI/LO are short sums of them. All six are exact rationals `num / den`, priced as
///      payout = stake · den · (10_000 − edgeBps) / (num · 10_000)
///  with truncation in the house's favour. Weights are uint16 and N ≤ 12, so W < 2^20 and
///  every denominator is below 2^60.
///
///  PLACE and SHOW sum prefixes with different denominators, so they are fixed point. Each
///  prefix term is rounded UP at 1e36, the terms are summed, and the total is rounded UP
///  once more to 1e18. The result is never below the true probability, so the payout is
///  never above fair, and each runner's value is at most 1 wei above it. (Rounding each
///  term straight into 1e18 would let SHOW's N³ terms drift by hundreds of wei.) SHOW is
///  O(N²) terms, so these are only for `placeBet` and views, never the VRF callback.
///
///  Markets and selection encodings (runner indexes are 0-based):
///    0 WIN               i                       1st
///    1 PLACE             i                       top 2
///    2 SHOW              i                       top 3
///    3 FORECAST          a<<8 | b                a 1st, b 2nd
///    4 REVERSE FORECAST  min<<8 | max            a and b fill 1st and 2nd, either order
///    5 TRICAST           a<<16 | b<<8 | c        a 1st, b 2nd, c 3rd
///    6 ODD/EVEN          0 odd, 1 even           winner's 1-based number
///    7 HI/LO             0 lo, 1 hi              winner's 1-based number > N/2 is hi
///  Selections are assumed already validated by the game.
library RaceOddsLib {
    uint8 internal constant WIN = 0;
    uint8 internal constant PLACE = 1;
    uint8 internal constant SHOW = 2;
    uint8 internal constant FORECAST = 3;
    uint8 internal constant REVERSE_FORECAST = 4;
    uint8 internal constant TRICAST = 5;
    uint8 internal constant ODD_EVEN = 6;
    uint8 internal constant HI_LO = 7;
    uint8 internal constant NUM_MARKETS = 8;

    uint256 internal constant ONE = 1e18;
    uint256 internal constant FINE = 1e36;

    error InvalidMarket();

    function total(uint256[] memory w) internal pure returns (uint256 W) {
        for (uint256 i = 0; i < w.length; i++) W += w[i];
    }

    // ──────────────────────────────────────────────
    //  Exact markets
    // ──────────────────────────────────────────────

    function probWin(uint256[] memory w, uint256 i) internal pure returns (uint256 num, uint256 den) {
        return (w[i], total(w));
    }

    function probForecast(uint256[] memory w, uint256 a, uint256 b)
        internal
        pure
        returns (uint256 num, uint256 den)
    {
        uint256 W = total(w);
        return (w[a] * w[b], W * (W - w[a]));
    }

    /// @dev FC(a,b) + FC(b,a) = wa·wb·(2W − wa − wb) / (W·(W − wa)·(W − wb)).
    function probReverseForecast(uint256[] memory w, uint256 a, uint256 b)
        internal
        pure
        returns (uint256 num, uint256 den)
    {
        uint256 W = total(w);
        return (w[a] * w[b] * (2 * W - w[a] - w[b]), W * (W - w[a]) * (W - w[b]));
    }

    function probTricast(uint256[] memory w, uint256 a, uint256 b, uint256 c)
        internal
        pure
        returns (uint256 num, uint256 den)
    {
        uint256 W = total(w);
        return (w[a] * w[b] * w[c], W * (W - w[a]) * (W - w[a] - w[b]));
    }

    /// @dev sel 0: the winner's 1-based number is odd, i.e. its 0-based index is even.
    function probOddEven(uint256[] memory w, uint256 sel) internal pure returns (uint256 num, uint256 den) {
        for (uint256 i = sel; i < w.length; i += 2) num += w[i];
        den = total(w);
    }

    /// @dev sel 1: the winner's 1-based number is above N/2, i.e. 2·(i+1) > N.
    function probHiLo(uint256[] memory w, uint256 sel) internal pure returns (uint256 num, uint256 den) {
        uint256 n = w.length;
        for (uint256 i = 0; i < n; i++) {
            if ((2 * (i + 1) > n) == (sel == 1)) num += w[i];
        }
        den = total(w);
    }

    // ──────────────────────────────────────────────
    //  Fixed-point markets
    // ──────────────────────────────────────────────

    /// @notice P(i finishes in the top 2), rounded up, in 1e18.
    function probPlace1e18(uint256[] memory w, uint256 i) internal pure returns (uint256) {
        return Math.ceilDiv(_placeFine(w, i, total(w)), FINE / ONE);
    }

    /// @notice P(i finishes in the top 3), rounded up, in 1e18.
    function probShow1e18(uint256[] memory w, uint256 i) internal pure returns (uint256) {
        uint256 W = total(w);
        uint256 acc = _placeFine(w, i, W);
        uint256 n = w.length;
        // i third, behind j and k.
        for (uint256 j = 0; j < n; j++) {
            if (j == i) continue;
            for (uint256 k = 0; k < n; k++) {
                if (k == i || k == j) continue;
                acc += Math.ceilDiv(FINE * w[j] * w[k] * w[i], W * (W - w[j]) * (W - w[j] - w[k]));
            }
        }
        return Math.ceilDiv(acc, FINE / ONE);
    }

    /// @dev Σ of the PLACE terms at 1e36, each rounded up: i first, then i second behind j.
    ///      SHOW starts from the same sum, so PLACE ≤ SHOW holds for every runner.
    function _placeFine(uint256[] memory w, uint256 i, uint256 W) private pure returns (uint256 acc) {
        acc = Math.ceilDiv(FINE * w[i], W);
        for (uint256 j = 0; j < w.length; j++) {
            if (j == i) continue;
            acc += Math.ceilDiv(FINE * w[j] * w[i], W * (W - w[j]));
        }
    }

    // ──────────────────────────────────────────────
    //  Pricing
    // ──────────────────────────────────────────────

    /// @notice Probability of `sel` winning in `market` as `num / den`. PLACE and SHOW come
    ///         back as `P1e18 / 1e18`.
    function probability(uint256[] memory w, uint8 market, bytes32 sel)
        internal
        pure
        returns (uint256 num, uint256 den)
    {
        uint256 s = uint256(sel);
        if (market == WIN) return probWin(w, s);
        if (market == PLACE) return (probPlace1e18(w, s), ONE);
        if (market == SHOW) return (probShow1e18(w, s), ONE);
        if (market == FORECAST) return probForecast(w, (s >> 8) & 0xff, s & 0xff);
        if (market == REVERSE_FORECAST) return probReverseForecast(w, (s >> 8) & 0xff, s & 0xff);
        if (market == TRICAST) return probTricast(w, (s >> 16) & 0xff, (s >> 8) & 0xff, s & 0xff);
        if (market == ODD_EVEN) return probOddEven(w, s);
        if (market == HI_LO) return probHiLo(w, s);
        revert InvalidMarket();
    }

    /// @notice Payout for a winning bet after the edge. Truncation favours the house, and
    ///         PLACE/SHOW use a probability already rounded up, so it never exceeds
    ///         stake · (1 − edge) / P.
    function payoutFor(uint256[] memory w, uint8 market, bytes32 sel, uint256 stake, uint256 edgeBps)
        internal
        pure
        returns (uint256)
    {
        (uint256 num, uint256 den) = probability(w, market, sel);
        return (stake * den * (10_000 - edgeBps)) / (num * 10_000);
    }

    /// @notice Payout multiplier in basis points (10_000 = 1x), for display only.
    function multiplierBps(uint256[] memory w, uint8 market, bytes32 sel, uint256 edgeBps)
        internal
        pure
        returns (uint256)
    {
        (uint256 num, uint256 den) = probability(w, market, sel);
        return (den * (10_000 - edgeBps)) / num;
    }
}
