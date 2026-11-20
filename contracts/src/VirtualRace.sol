// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PredictionGameBase} from "./PredictionGameBase.sol";
import {RaceOddsLib} from "./RaceOddsLib.sol";

/// @title VirtualRace
/// @notice Fixed-odds virtual race of RUNNERS runners. Greyhounds, horses, danfo buses and
///         the rest are one contract with different config; the theme is frontend art,
///         named here only by SKIN_ID.
///
///  Race card. Each race has one form weight per runner, in [W_MIN, W_MAX], derived from a
///  card seed that is public before betting on that race opens:
///      w_i = W_MIN + uint256(keccak256(abi.encode(cardSeed, i))) % (W_MAX − W_MIN + 1)
///  When race n settles, its VRF word commits the card of race n+1:
///      cardSeed[n+1] = keccak256(abi.encodePacked(word_n, "card"))
///  Race n+1's finishing order comes from a later word that nobody can see while betting is
///  open, and the card sets the odds, so knowing the card gives no edge.
///
///  Finishing order. Weighted sampling without replacement (Plackett–Luce): at position p,
///      r = uint256(keccak256(abi.encode(word, p))) % remaining
///  walks the runners not yet placed until r falls inside one runner's weight. The bias of
///  a 256-bit draw modulo a total below 2^20 is negligible.
///
///  Outcome packing: one byte per finishing position, from the most significant byte of the
///  `bytes32`, holding the 0-based runner index. Bytes beyond RUNNERS are zero.
///
///  Markets and prices: see RaceOddsLib. Settlement reads 11 liability buckets
///  (1 + 2 + 3 + 1 + 1 + 1 + 1 + 1), regardless of bet volume.
contract VirtualRace is PredictionGameBase {
    uint8 public constant MIN_RUNNERS = 4;
    uint8 public constant MAX_RUNNERS = 12;
    uint256 public constant MAX_EDGE_BPS = 2_000;

    uint8 public immutable RUNNERS;
    uint16 public immutable W_MIN;
    uint16 public immutable W_MAX;
    bytes32 public immutable SKIN_ID;

    /// @notice Seed of each race's card. Set for race 1 at deployment and for race n+1 when
    ///         race n settles.
    mapping(uint256 => bytes32) public cardSeed;

    /// @dev keccak256(word, "replay") per settled race; drives the replay animation only.
    mapping(uint256 => bytes32) internal _replaySeed;

    /// @dev Edge per market for new bets. Bets already booked keep their edge (see the base).
    uint16[8] internal _marketEdgeBps;

    event MarketEdgeUpdated(uint8 indexed market, uint256 edgeBps);

    error InvalidSelection();
    error CardNotSet();

    struct Config {
        uint8 runners;
        uint16 wMin;
        uint16 wMax;
        bytes32 skinId;
        uint256 betCutoff;
    }

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
        uint256 _maxExposureBps,
        Config memory _config
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
            _config.betCutoff
        )
    {
        if (_config.runners < MIN_RUNNERS || _config.runners > MAX_RUNNERS) revert InvalidConfig();
        if (_config.wMin == 0 || _config.wMin > _config.wMax) revert InvalidConfig();

        RUNNERS = _config.runners;
        W_MIN = _config.wMin;
        W_MAX = _config.wMax;
        SKIN_ID = _config.skinId;

        for (uint8 m = 0; m < RaceOddsLib.NUM_MARKETS; m++) {
            _marketEdgeBps[m] = uint16(_houseEdgeBps);
        }

        // Bootstrap: race 1 has no previous VRF word, so its card comes from the parent
        // block's hash and this contract's address. The deployer's block producer could in
        // principle grind it, but a biased card is still priced exactly from its own weights,
        // so the most it buys is a different set of correctly priced odds. A dry first round
        // would cost a VRF request to prevent nothing.
        cardSeed[1] = keccak256(abi.encodePacked(blockhash(block.number - 1), address(this)));
    }

    // ──────────────────────────────────────────────
    //  Race card
    // ──────────────────────────────────────────────

    /// @dev The card of a race that bets can reach. Reverts for a race with no card yet.
    function _weights(uint256 drawId) internal view returns (uint256[] memory) {
        bytes32 seed = cardSeed[drawId];
        if (seed == bytes32(0)) revert CardNotSet();
        return _weightsFrom(seed);
    }

    /// @dev Pure function of the card seed; nothing but the seed is stored. Never reverts,
    ///      so the VRF callback uses it directly.
    function _weightsFrom(bytes32 seed) internal view returns (uint256[] memory w) {
        uint256 n = RUNNERS;
        uint256 span = uint256(W_MAX) - W_MIN + 1;
        w = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            w[i] = W_MIN + uint256(keccak256(abi.encode(seed, i))) % span;
        }
    }

    // ──────────────────────────────────────────────
    //  Markets and pricing
    // ──────────────────────────────────────────────

    function numMarkets() public pure override returns (uint8) {
        return RaceOddsLib.NUM_MARKETS;
    }

    function _validate(uint256, uint8 market, bytes32 sel) internal view override {
        uint256 s = uint256(sel);
        uint256 n = RUNNERS;

        if (market <= RaceOddsLib.SHOW) {
            if (s >= n) revert InvalidSelection();
        } else if (market == RaceOddsLib.FORECAST || market == RaceOddsLib.REVERSE_FORECAST) {
            uint256 a = s >> 8;
            uint256 b = s & 0xff;
            if (a >= n || b >= n || a == b) revert InvalidSelection();
        } else if (market == RaceOddsLib.TRICAST) {
            uint256 a = s >> 16;
            uint256 b = (s >> 8) & 0xff;
            uint256 c = s & 0xff;
            if (a >= n || b >= n || c >= n || a == b || a == c || b == c) revert InvalidSelection();
        } else {
            // ODD/EVEN and HI/LO
            if (s > 1) revert InvalidSelection();
        }
    }

    /// @dev Only REVERSE FORECAST has two spellings of one bet; settlement looks it up sorted.
    function _canonicalize(uint8 market, bytes32 sel) internal pure override returns (bytes32) {
        if (market != RaceOddsLib.REVERSE_FORECAST) return sel;
        uint256 s = uint256(sel);
        uint256 a = s >> 8;
        uint256 b = s & 0xff;
        return a < b ? sel : bytes32((b << 8) | a);
    }

    function _payoutFor(uint256 drawId, uint8 market, bytes32 sel, uint256 stake, uint256 edgeBps)
        internal
        view
        override
        returns (uint256)
    {
        return RaceOddsLib.payoutFor(_weights(drawId), market, sel, stake, edgeBps);
    }

    function _maxSimultaneousWinners(uint8 market) internal pure override returns (uint256) {
        if (market == RaceOddsLib.PLACE) return 2;
        if (market == RaceOddsLib.SHOW) return 3;
        return 1;
    }

    function _edgeFor(uint8 market) internal view override returns (uint256) {
        return _marketEdgeBps[market];
    }

    // ──────────────────────────────────────────────
    //  Race
    // ──────────────────────────────────────────────

    /// @dev Plackett–Luce sampling. Loops are bounded by RUNNERS, every weight is at least
    ///      W_MIN ≥ 1 so `remaining` is never zero, and the walk always lands on a runner.
    function _deriveOutcome(uint256 drawId, uint256 word) internal view override returns (bytes32) {
        return _sample(_weightsFrom(cardSeed[drawId]), word);
    }

    /// @dev The sampler itself, as a pure function of the card so it can be tested on any.
    function _sample(uint256[] memory w, uint256 word) internal pure returns (bytes32) {
        uint256 n = w.length;
        uint256 remaining = RaceOddsLib.total(w);
        uint256 placed; // bitmask of runners already placed
        uint256 o;

        for (uint256 pos = 0; pos < n; pos++) {
            uint256 r = uint256(keccak256(abi.encode(word, pos))) % remaining;
            uint256 j = 0;
            for (; j < n; j++) {
                if (placed & (1 << j) != 0) continue;
                if (r < w[j]) break;
                r -= w[j];
            }
            placed |= 1 << j;
            remaining -= w[j];
            o |= j << (248 - 8 * pos);
        }
        return bytes32(o);
    }

    function _top3(bytes32 outcome) internal pure returns (uint256 a, uint256 b, uint256 c) {
        uint256 o = uint256(outcome);
        a = uint8(o >> 248);
        b = uint8(o >> 240);
        c = uint8(o >> 232);
    }

    function _oddEvenOf(uint256 winner) internal pure returns (uint256) {
        return winner % 2; // 0-based even index = odd 1-based number = selection 0
    }

    function _hiLoOf(uint256 winner) internal view returns (uint256) {
        return 2 * (winner + 1) > RUNNERS ? 1 : 0;
    }

    /// @dev The O(1) core: 11 bucket reads from the top three finishers.
    function _totalPayoutFor(uint256 drawId, bytes32 outcome) internal view override returns (uint256 t) {
        (uint256 a, uint256 b, uint256 c) = _top3(outcome);
        mapping(uint8 => mapping(bytes32 => uint256)) storage L = liability[drawId];

        t += L[RaceOddsLib.WIN][bytes32(a)];
        t += L[RaceOddsLib.PLACE][bytes32(a)];
        t += L[RaceOddsLib.PLACE][bytes32(b)];
        t += L[RaceOddsLib.SHOW][bytes32(a)];
        t += L[RaceOddsLib.SHOW][bytes32(b)];
        t += L[RaceOddsLib.SHOW][bytes32(c)];
        t += L[RaceOddsLib.FORECAST][bytes32((a << 8) | b)];
        t += L[RaceOddsLib.REVERSE_FORECAST][a < b ? bytes32((a << 8) | b) : bytes32((b << 8) | a)];
        t += L[RaceOddsLib.TRICAST][bytes32((a << 16) | (b << 8) | c)];
        t += L[RaceOddsLib.ODD_EVEN][bytes32(_oddEvenOf(a))];
        t += L[RaceOddsLib.HI_LO][bytes32(_hiLoOf(a))];
    }

    function _isWinner(uint256, bytes32 outcome, uint8 market, bytes32 sel) internal view override returns (bool) {
        (uint256 a, uint256 b, uint256 c) = _top3(outcome);
        uint256 s = uint256(sel);

        if (market == RaceOddsLib.WIN) return s == a;
        if (market == RaceOddsLib.PLACE) return s == a || s == b;
        if (market == RaceOddsLib.SHOW) return s == a || s == b || s == c;
        if (market == RaceOddsLib.FORECAST) return s == ((a << 8) | b);
        if (market == RaceOddsLib.REVERSE_FORECAST) return s == (a < b ? (a << 8) | b : (b << 8) | a);
        if (market == RaceOddsLib.TRICAST) return s == ((a << 16) | (b << 8) | c);
        if (market == RaceOddsLib.ODD_EVEN) return s == _oddEvenOf(a);
        return s == _hiLoOf(a);
    }

    /// @dev Commits the next race's card and this race's replay seed. Two storage writes,
    ///      no external calls, cannot revert.
    function _afterSettle(uint256 drawId, uint256 word) internal override {
        cardSeed[drawId + 1] = keccak256(abi.encodePacked(word, "card"));
        _replaySeed[drawId] = keccak256(abi.encodePacked(word, "replay"));
    }

    // ──────────────────────────────────────────────
    //  Admin
    // ──────────────────────────────────────────────

    /// @notice Set one market's edge for new bets. Only while the open draw has no bets,
    ///         the same rule as `setRiskParams`.
    function setMarketEdge(uint8 market, uint256 edgeBps) external onlyOwner {
        if (market >= RaceOddsLib.NUM_MARKETS) revert InvalidMarket();
        if (edgeBps > MAX_EDGE_BPS) revert InvalidConfig();
        if (bets[currentDrawId].length > 0) revert BettingClosed();
        _marketEdgeBps[market] = uint16(edgeBps);
        emit MarketEdgeUpdated(market, edgeBps);
    }

    // ──────────────────────────────────────────────
    //  Views
    // ──────────────────────────────────────────────

    function marketEdgeBps(uint8 market) external view returns (uint256) {
        if (market >= RaceOddsLib.NUM_MARKETS) revert InvalidMarket();
        return _marketEdgeBps[market];
    }

    /// @notice The race card: each runner's form weight for `drawId`.
    function raceCard(uint256 drawId) external view returns (uint16[] memory weights) {
        uint256[] memory w = _weights(drawId);
        weights = new uint16[](w.length);
        for (uint256 i = 0; i < w.length; i++) weights[i] = uint16(w[i]);
    }

    /// @notice Exact payout and display multiplier for a prospective bet on `drawId`.
    /// @dev Same code path `claimPrize` pays from. Uses the edge already booked for that
    ///      draw and market if there is one, otherwise the current edge.
    function quote(uint256 drawId, uint8 market, bytes32 selection, uint256 stake)
        external
        view
        returns (uint256 payout, uint256 multiplierBps)
    {
        if (market >= RaceOddsLib.NUM_MARKETS) revert InvalidMarket();
        _validate(drawId, market, selection);
        bytes32 canonical = _canonicalize(market, selection);
        uint256 edgeBps = _bookedEdge(drawId, market);
        uint256[] memory w = _weights(drawId);
        payout = RaceOddsLib.payoutFor(w, market, canonical, stake, edgeBps);
        multiplierBps = RaceOddsLib.multiplierBps(w, market, canonical, edgeBps);
    }

    /// @notice Finishing order of a race (0-based runner per position). Unsettled races
    ///         return an empty order.
    function getRaceResult(uint256 drawId)
        external
        view
        returns (uint8[] memory order, uint256 totalPayout, bool settled)
    {
        DrawResult storage r = draws[drawId];
        if (r.settled) {
            uint256 o = uint256(r.outcome);
            order = new uint8[](RUNNERS);
            for (uint256 p = 0; p < RUNNERS; p++) order[p] = uint8(o >> (248 - 8 * p));
        }
        return (order, r.totalPayout, r.settled);
    }

    /// @notice keccak256(word, "replay") for a settled race; zero before settlement.
    function replaySeed(uint256 drawId) external view returns (bytes32) {
        return _replaySeed[drawId];
    }
}
