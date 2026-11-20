// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PredictionGameBase} from "./PredictionGameBase.sol";
import {OddsLib, BetType} from "./OddsLib.sol";

/// @title ColorColorGame
/// @notice Fixed-odds fast-draw virtual game. Six balls from 1-49 every draw interval.
///         Rounds, VRF, stakes, exposure, vault, referrals and claims live in
///         PredictionGameBase; this contract is only what the balls mean.
///
///  Board:
///    Red 1-12 | Yellow 13-24 | Green 25-36 | Blue 37-49   (Blue holds 13, the rest 12)
///    Dominant colour = strict highest count among the 6 drawn; any tie => 4 ("Draw").
///
///  Markets are the `BetType` values, and their encodings (see OddsLib):
///    0 PICK1   — one number appears.                selection = n
///    1 PICK2   — both of two numbers appear.        selection = n1<<8 | n2   (stored ascending)
///    2 PICK3   — all three numbers appear.          selection = n1<<16 | n2<<8 | n3 (ascending)
///    3 COLOR   — dominant colour.                   selection = 0..4, 4 = Draw
///    4 HILO    — sum band of the 6 balls.           selection = 0 Lo (<=120), 1 Mid, 2 Hi (>=160)
///    5 RAINBOW — exact colour distribution.         selection = R*1000 + Y*100 + G*10 + B
///
///  Prices come from OddsLib, which derives them from exact combinatorics over C(49,6).
///
///  Outcome packing, big-endian from the most significant byte of the `bytes32`:
///    bytes 0-5   numbers[0..5], sorted ascending
///    bytes 6-9   colourCount[0..3]  (red, yellow, green, blue)
///    bytes 10-11 sum (uint16)
///    byte  12    dominant colour (0-3, or 4 for a tie)
///    bytes 13-31 zero
///
///  Settlement reads 44 liability buckets per draw: 6 for PICK1, C(6,2)=15 for PICK2,
///  C(6,3)=20 for PICK3, and one each for COLOR/HILO/RAINBOW — regardless of bet volume.
contract ColorColorGame is PredictionGameBase {
    uint8 public constant NUM_BET_TYPES = 6;
    uint8 public constant NUMBERS_DRAWN = 6;

    constructor(
        address _usdc,
        address _vrfCoordinator,
        address _referralManager,
        address _houseVault,
        address _treasury,
        address _owner,
        uint256 _subscriptionId,
        bytes32 _keyHash,
        uint32 _callbackGasLimit,
        uint256 _drawInterval,
        uint256 _houseEdgeBps,
        uint256 _maxPayoutPerBet,
        uint256 _maxExposureBps
    )
        PredictionGameBase(
            _usdc,
            _vrfCoordinator,
            _referralManager,
            _houseVault,
            _treasury,
            _owner,
            _subscriptionId,
            _keyHash,
            _callbackGasLimit,
            _drawInterval,
            _houseEdgeBps,
            _maxPayoutPerBet,
            _maxExposureBps,
            0 // no bet cutoff: betting closes when upkeep requests the draw, as it always has
        )
    {}

    // ──────────────────────────────────────────────
    //  Markets and pricing
    // ──────────────────────────────────────────────

    function numMarkets() public pure override returns (uint8) {
        return NUM_BET_TYPES;
    }

    function _validate(uint256, uint8 market, bytes32 sel) internal pure override {
        OddsLib.validate(BetType(market), sel);
    }

    function _canonicalize(uint8 market, bytes32 sel) internal pure override returns (bytes32) {
        return OddsLib.canonicalize(BetType(market), sel);
    }

    function _payoutFor(uint256, uint8 market, bytes32 sel, uint256 stake, uint256 edgeBps)
        internal
        pure
        override
        returns (uint256)
    {
        return OddsLib.payoutFor(stake, BetType(market), sel, edgeBps);
    }

    /// @dev How many selections of each bet type can win simultaneously on one result.
    function _maxSimultaneousWinners(uint8 t) internal pure override returns (uint256) {
        if (t == uint8(BetType.PICK1)) return 6;  // the 6 drawn numbers
        if (t == uint8(BetType.PICK2)) return 15; // C(6,2)
        if (t == uint8(BetType.PICK3)) return 20; // C(6,3)
        return 1;                                 // COLOR / HILO / RAINBOW are single-outcome
    }

    // ──────────────────────────────────────────────
    //  Draw
    // ──────────────────────────────────────────────

    function _deriveOutcome(uint256, uint256 word) internal pure override returns (bytes32) {
        uint8[6] memory numbers = _deriveNumbers(word);
        uint8[4] memory colourCount;
        uint16 sum;

        for (uint8 i = 0; i < NUMBERS_DRAWN; i++) {
            sum += uint16(numbers[i]);
            colourCount[OddsLib.colourOf(numbers[i])]++;
        }

        return _encode(numbers, colourCount, sum, _dominantColour(colourCount));
    }

    /// @dev The O(1) core: 44 bucket reads, independent of how many bets were placed.
    function _totalPayoutFor(uint256 drawId, bytes32 outcome) internal view override returns (uint256 total) {
        (uint8[6] memory numbers, uint8[4] memory colourCount, uint16 sum, uint8 dominant) = _decode(outcome);
        mapping(uint8 => mapping(bytes32 => uint256)) storage L = liability[drawId];

        // PICK1 — the 6 drawn numbers.
        for (uint8 i = 0; i < NUMBERS_DRAWN; i++) {
            total += L[uint8(BetType.PICK1)][bytes32(uint256(numbers[i]))];
        }

        // PICK2 / PICK3 — `numbers` is sorted, so i<j<k yields canonical ascending keys.
        for (uint8 i = 0; i < NUMBERS_DRAWN; i++) {
            for (uint8 j = i + 1; j < NUMBERS_DRAWN; j++) {
                total += L[uint8(BetType.PICK2)][
                    bytes32((uint256(numbers[i]) << 8) | uint256(numbers[j]))
                ];
                for (uint8 k = j + 1; k < NUMBERS_DRAWN; k++) {
                    total += L[uint8(BetType.PICK3)][
                        bytes32(
                            (uint256(numbers[i]) << 16) | (uint256(numbers[j]) << 8) | uint256(numbers[k])
                        )
                    ];
                }
            }
        }

        total += L[uint8(BetType.COLOR)][bytes32(uint256(dominant))];
        total += L[uint8(BetType.HILO)][bytes32(uint256(_hiloBand(sum)))];
        total += L[uint8(BetType.RAINBOW)][
            OddsLib.encodeRainbow(colourCount[0], colourCount[1], colourCount[2], colourCount[3])
        ];
    }

    function _isWinner(uint256, bytes32 outcome, uint8 market, bytes32 selection)
        internal
        pure
        override
        returns (bool)
    {
        (uint8[6] memory numbers, uint8[4] memory colourCount, uint16 sum, uint8 dominant) = _decode(outcome);
        uint256 s = uint256(selection);
        BetType betType = BetType(market);

        if (betType == BetType.PICK1) {
            return _drawn(uint8(s), numbers);
        }
        if (betType == BetType.PICK2) {
            return _drawn(uint8(s >> 8), numbers) && _drawn(uint8(s), numbers);
        }
        if (betType == BetType.PICK3) {
            return _drawn(uint8(s >> 16), numbers) && _drawn(uint8(s >> 8), numbers) && _drawn(uint8(s), numbers);
        }
        if (betType == BetType.COLOR) {
            return uint8(s) == dominant;
        }
        if (betType == BetType.HILO) {
            return uint8(s) == _hiloBand(sum);
        }
        // RAINBOW — exact colour distribution.
        (uint8 r, uint8 y, uint8 g, uint8 b) = OddsLib.decodeRainbow(selection);
        return r == colourCount[0] && y == colourCount[1] && g == colourCount[2] && b == colourCount[3];
    }

    function _drawn(uint8 n, uint8[6] memory numbers) internal pure returns (bool) {
        for (uint8 i = 0; i < NUMBERS_DRAWN; i++) {
            if (numbers[i] == n) return true;
        }
        return false;
    }

    function _dominantColour(uint8[4] memory colourCount) internal pure returns (uint8) {
        uint8 maxCount;
        uint8 dominant;
        bool tied;
        for (uint8 c = 0; c < 4; c++) {
            if (colourCount[c] > maxCount) {
                maxCount = colourCount[c];
                dominant = c;
                tied = false;
            } else if (colourCount[c] == maxCount && maxCount > 0) {
                tied = true;
            }
        }
        return tied ? 4 : dominant;
    }

    function _hiloBand(uint16 sum) internal pure returns (uint8) {
        if (sum <= OddsLib.HILO_LO_MAX) return 0;
        if (sum >= OddsLib.HILO_HI_MIN) return 2;
        return 1;
    }

    /// @notice Derive 6 unique sorted numbers (1-49) from one random word.
    function _deriveNumbers(uint256 randomWord) internal pure returns (uint8[6] memory numbers) {
        uint8[49] memory deck;
        for (uint8 i = 0; i < 49; i++) {
            deck[i] = i + 1;
        }
        for (uint8 i = 0; i < NUMBERS_DRAWN; i++) {
            uint256 remaining = 49 - i;
            uint256 idx = uint256(keccak256(abi.encode(randomWord, i))) % remaining;
            numbers[i] = deck[idx];
            deck[idx] = deck[remaining - 1];
        }
        for (uint8 i = 0; i < 5; i++) {
            for (uint8 j = i + 1; j < NUMBERS_DRAWN; j++) {
                if (numbers[i] > numbers[j]) (numbers[i], numbers[j]) = (numbers[j], numbers[i]);
            }
        }
    }

    // ──────────────────────────────────────────────
    //  Outcome packing
    // ──────────────────────────────────────────────

    function _encode(uint8[6] memory numbers, uint8[4] memory colourCount, uint16 sum, uint8 dominant)
        internal
        pure
        returns (bytes32)
    {
        uint256 o;
        for (uint256 i = 0; i < 6; i++) {
            o |= uint256(numbers[i]) << (248 - 8 * i);
        }
        for (uint256 c = 0; c < 4; c++) {
            o |= uint256(colourCount[c]) << (200 - 8 * c);
        }
        o |= uint256(sum) << 160;
        o |= uint256(dominant) << 152;
        return bytes32(o);
    }

    function _decode(bytes32 outcome)
        internal
        pure
        returns (uint8[6] memory numbers, uint8[4] memory colourCount, uint16 sum, uint8 dominant)
    {
        uint256 o = uint256(outcome);
        for (uint256 i = 0; i < 6; i++) {
            numbers[i] = uint8(o >> (248 - 8 * i));
        }
        for (uint256 c = 0; c < 4; c++) {
            colourCount[c] = uint8(o >> (200 - 8 * c));
        }
        sum = uint16(o >> 160);
        dominant = uint8(o >> 152);
    }

    // ──────────────────────────────────────────────
    //  Typed views
    // ──────────────────────────────────────────────

    /// @notice Exact payout and display multiplier for a prospective bet.
    /// @dev The UI must price bets from here rather than recomputing in JS — this is the
    ///      same code path `claimPrize` pays from, so the two can never drift.
    function quote(BetType betType, bytes32 selection, uint256 stake)
        external
        view
        returns (uint256 payout, uint256 multiplierBps)
    {
        uint8 market = uint8(betType);
        _validate(currentDrawId, market, selection);
        bytes32 canonical = _canonicalize(market, selection);
        uint256 edgeBps = _edgeFor(market);
        payout = _payoutFor(currentDrawId, market, canonical, stake, edgeBps);
        multiplierBps = OddsLib.multiplierBps(betType, canonical, edgeBps);
    }

    /// @notice A draw's result, decoded from its packed outcome. Unsettled draws read as zeros.
    function getDrawResult(uint256 drawId)
        external
        view
        returns (
            uint8[6] memory numbers,
            uint8[4] memory colourCount,
            uint16 sum,
            uint8 dominantColour,
            uint256 totalPayout,
            bool settled
        )
    {
        DrawResult storage r = draws[drawId];
        (numbers, colourCount, sum, dominantColour) = _decode(r.outcome);
        return (numbers, colourCount, sum, dominantColour, r.totalPayout, r.settled);
    }
}
