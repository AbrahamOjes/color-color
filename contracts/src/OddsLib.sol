// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Bet types for the ColorColor virtual game.
/// @dev Declared at file level so both OddsLib and ColorColor share one definition.
enum BetType {
    PICK1,   // 0 — one number appears among the 6 drawn
    PICK2,   // 1 — both of two numbers appear
    PICK3,   // 2 — all three of three numbers appear
    COLOR,   // 3 — dominant colour: 0=Red, 1=Yellow, 2=Green, 3=Blue, 4=Draw (tie)
    HILO,    // 4 — sum band: 0=Lo (<=120), 1=Mid (121-159), 2=Hi (>=160)
    RAINBOW  // 5 — exact colour distribution, encoded R*1000 + Y*100 + G*10 + B
}

/// @title OddsLib
/// @notice Exact fixed-odds pricing for the ColorColor 49-ball / 4-colour game.
///
/// Every outcome of this game is an exact rational whose denominator is the same:
/// `C(49,6) = 13_983_816`. So odds are never stored as a probability or a fixed-point
/// number — we store `winCount`, the count of favourable 6-ball combinations, and all
/// payout math is exact integer arithmetic with zero rounding drift:
///
///     payout = stake * TOTAL_COMBINATIONS * (10_000 - edgeBps) / (winCount * 10_000)
///
/// Division truncates, which always rounds in the house's favour — never against it.
///
/// Two asymmetries this library exists to respect, both of which a flat "all colours pay
/// the same" table would get wrong and quietly leak money on:
///
///   1. Blue spans 37-49 — thirteen numbers, not twelve — so it wins ~23% more often
///      than Red/Yellow/Green and must pay less (5.95x vs 7.32x fair).
///   2. The HILO bands are not symmetric about the mean sum of 150: `Lo <= 120` sits 30
///      below it while `Hi >= 160` sits only 10 above, so Hi is more than twice as likely
///      as Lo (2.57x vs 5.30x fair).
///
/// Constants are generated and cross-checked by `script/odds/generate.py`, and pinned by
/// partition invariants in `test/OddsLib.t.sol` — each bet type's win counts must sum to
/// exactly TOTAL_COMBINATIONS, which no single mistyped constant can satisfy.
library OddsLib {
    /// @notice C(49,6) — the universal denominator for every outcome in this game.
    uint256 internal constant TOTAL_COMBINATIONS = 13_983_816;

    /// @notice Favourable combinations for PICK bets: C(49-k, 6-k).
    uint256 internal constant PICK1_WINCOUNT = 1_712_304; // C(48,5) — 8.1667x fair
    uint256 internal constant PICK2_WINCOUNT = 178_365;   // C(47,4) — 78.40x fair
    uint256 internal constant PICK3_WINCOUNT = 15_180;    // C(46,3) — 921.20x fair

    /// @notice Colour group sizes — Red 1-12, Yellow 13-24, Green 25-36, Blue 37-49.
    uint8 internal constant RED_MAX = 12;
    uint8 internal constant YELLOW_MAX = 24;
    uint8 internal constant GREEN_MAX = 36;
    uint8 internal constant BLUE_MAX = 49;

    uint8 internal constant MAX_NUMBER = 49;
    uint8 internal constant NUMBERS_DRAWN = 6;

    /// @notice HILO band boundaries. Sum of 6 distinct numbers from 1-49 spans 21..279.
    uint16 internal constant HILO_LO_MAX = 120;
    uint16 internal constant HILO_HI_MIN = 160;

    error InvalidSelection();
    error InvalidBetType();

    // ──────────────────────────────────────────────
    //  Selection canonicalisation
    // ──────────────────────────────────────────────

    /// @notice Normalise a selection to its canonical encoding.
    /// @dev Critical for PICK2/PICK3. Selections key the per-outcome liability buckets that
    ///      make settlement O(1); if (5,3) and (3,5) hashed to different buckets, settlement
    ///      would enumerate only one of them and undercount what the house owes. Sorting the
    ///      picks ascending makes the bucket key canonical, so logically identical bets
    ///      always share a bucket. All other bet types are already positional and canonical.
    function canonicalize(BetType betType, bytes32 selection) internal pure returns (bytes32) {
        if (betType == BetType.PICK2) {
            (uint8 a, uint8 b) = (uint8(uint256(selection) >> 8), uint8(uint256(selection)));
            if (a > b) (a, b) = (b, a);
            return bytes32((uint256(a) << 8) | uint256(b));
        }
        if (betType == BetType.PICK3) {
            uint8 a = uint8(uint256(selection) >> 16);
            uint8 b = uint8(uint256(selection) >> 8);
            uint8 c = uint8(uint256(selection));
            if (a > b) (a, b) = (b, a);
            if (b > c) (b, c) = (c, b);
            if (a > b) (a, b) = (b, a);
            return bytes32((uint256(a) << 16) | (uint256(b) << 8) | uint256(c));
        }
        return selection;
    }

    /// @notice Revert unless `selection` is a well-formed encoding for `betType`.
    function validate(BetType betType, bytes32 selection) internal pure {
        uint256 s = uint256(selection);

        if (betType == BetType.PICK1) {
            uint8 n = uint8(s);
            if (s > type(uint8).max || n < 1 || n > MAX_NUMBER) revert InvalidSelection();
        } else if (betType == BetType.PICK2) {
            if (s > type(uint16).max) revert InvalidSelection();
            uint8 a = uint8(s >> 8);
            uint8 b = uint8(s);
            if (a < 1 || a > MAX_NUMBER || b < 1 || b > MAX_NUMBER || a == b) revert InvalidSelection();
        } else if (betType == BetType.PICK3) {
            if (s > type(uint24).max) revert InvalidSelection();
            uint8 a = uint8(s >> 16);
            uint8 b = uint8(s >> 8);
            uint8 c = uint8(s);
            if (a < 1 || a > MAX_NUMBER || b < 1 || b > MAX_NUMBER || c < 1 || c > MAX_NUMBER) {
                revert InvalidSelection();
            }
            if (a == b || a == c || b == c) revert InvalidSelection();
        } else if (betType == BetType.COLOR) {
            if (s > 4) revert InvalidSelection();
        } else if (betType == BetType.HILO) {
            if (s > 2) revert InvalidSelection();
        } else if (betType == BetType.RAINBOW) {
            if (s > type(uint16).max) revert InvalidSelection();
            (uint8 r, uint8 y, uint8 g, uint8 b) = decodeRainbow(bytes32(s));
            if (uint256(r) + y + g + b != NUMBERS_DRAWN) revert InvalidSelection();
        } else {
            revert InvalidBetType();
        }
    }

    /// @notice Decode a RAINBOW selection: R*1000 + Y*100 + G*10 + B.
    function decodeRainbow(bytes32 selection) internal pure returns (uint8 r, uint8 y, uint8 g, uint8 b) {
        uint256 e = uint256(selection);
        r = uint8(e / 1000);
        y = uint8((e % 1000) / 100);
        g = uint8((e % 100) / 10);
        b = uint8(e % 10);
    }

    /// @notice Encode a RAINBOW selection.
    function encodeRainbow(uint8 r, uint8 y, uint8 g, uint8 b) internal pure returns (bytes32) {
        return bytes32(uint256(r) * 1000 + uint256(y) * 100 + uint256(g) * 10 + uint256(b));
    }

    /// @notice The colour of a number: 0=Red, 1=Yellow, 2=Green, 3=Blue.
    function colourOf(uint8 n) internal pure returns (uint8) {
        if (n <= RED_MAX) return 0;
        if (n <= YELLOW_MAX) return 1;
        if (n <= GREEN_MAX) return 2;
        return 3;
    }

    // ──────────────────────────────────────────────
    //  Odds
    // ──────────────────────────────────────────────

    /// @notice Number of the C(49,6) possible draws in which `selection` wins.
    /// @dev Assumes `selection` already passed `validate`.
    function winCount(BetType betType, bytes32 selection) internal pure returns (uint256) {
        if (betType == BetType.PICK1) return PICK1_WINCOUNT;
        if (betType == BetType.PICK2) return PICK2_WINCOUNT;
        if (betType == BetType.PICK3) return PICK3_WINCOUNT;

        if (betType == BetType.COLOR) {
            // [Red, Yellow, Green, Blue, Draw(tie)] — sums to TOTAL_COMBINATIONS.
            // Blue is larger than the other three because it holds 13 numbers, not 12.
            uint256 c = uint256(selection);
            if (c == 0 || c == 1 || c == 2) return 1_909_578; // 7.3230x fair
            if (c == 3) return 2_351_778;                     // 5.9461x fair
            return 5_903_304;                                 // Draw — 2.3688x fair
        }

        if (betType == BetType.HILO) {
            // [Lo, Mid, Hi] — sums to TOTAL_COMBINATIONS.
            uint256 band = uint256(selection);
            if (band == 0) return 2_640_092; // Lo <=120  — 5.2967x fair
            if (band == 1) return 5_907_089; // Mid       — 2.3673x fair
            return 5_436_635;                // Hi >=160  — 2.5721x fair
        }

        if (betType == BetType.RAINBOW) {
            // Exact colour distribution: C(12,r) * C(12,y) * C(12,g) * C(13,b).
            // Computed rather than tabulated — an 84-row hand-copied table is precisely the
            // kind of transcription error this codebase has already paid for twice.
            (uint8 r, uint8 y, uint8 g, uint8 b) = decodeRainbow(selection);
            return _c12(r) * _c12(y) * _c12(g) * _c13(b);
        }

        revert InvalidBetType();
    }

    /// @notice Exact payout for a winning bet, after the house edge.
    /// @dev Truncating division rounds down, always in the house's favour.
    function payoutFor(uint256 stake, BetType betType, bytes32 selection, uint256 edgeBps)
        internal
        pure
        returns (uint256)
    {
        return (stake * TOTAL_COMBINATIONS * (10_000 - edgeBps)) / (winCount(betType, selection) * 10_000);
    }

    /// @notice Payout multiplier in basis points (10_000 = 1x), for display.
    /// @dev Indicative only. `payoutFor` is authoritative — deriving a payout from this
    ///      value would round twice and disagree with what the contract actually pays.
    function multiplierBps(BetType betType, bytes32 selection, uint256 edgeBps)
        internal
        pure
        returns (uint256)
    {
        return (TOTAL_COMBINATIONS * (10_000 - edgeBps)) / winCount(betType, selection);
    }

    // ──────────────────────────────────────────────
    //  Binomial tables (k = 0..6)
    // ──────────────────────────────────────────────

    function _c12(uint256 k) private pure returns (uint256) {
        uint256[7] memory t = [uint256(1), 12, 66, 220, 495, 792, 924];
        return t[k];
    }

    function _c13(uint256 k) private pure returns (uint256) {
        uint256[7] memory t = [uint256(1), 13, 78, 286, 715, 1287, 1716];
        return t[k];
    }
}
