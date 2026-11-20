// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {AutomationCompatibleInterface} from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";
import {ReferralManager} from "./ReferralManager.sol";
import {HouseVault} from "./HouseVault.sol";
import {IPredictionGame} from "./interfaces/IPredictionGame.sol";

/// @title PredictionGameBase
/// @notice The engine shared by every fixed-odds game: rounds on a clock, Chainlink VRF v2.5
///         draws, Automation, USDC stakes, liability buckets, worst-case exposure, the house
///         vault, referrals, claims and pause. A concrete game supplies only what a random
///         word means and how its markets are priced, through the hooks below.
///
///  Payouts are FIXED ODDS, not parimutuel. A bet's payout is known the moment it is placed
///  and depends only on the bet and the result — never on what anyone else wagered.
///
///  Economics, all charged against the gross stake:
///    - `houseEdgeBps` (default 8%) is priced into the payout multiplier.
///    - Of the gross stake, 2% goes to referrals and 1% to treasury at bet time.
///    - The remaining ~5% of turnover is the house's expected margin and accrues to
///      HouseVault as draw profit. LPs take the variance in both directions.
///
///  Settlement is O(1) in the number of bets. Because a fixed-odds payout depends only on the
///  bet and the result, liability is bucketed per (market, selection) at bet time, and each
///  game bounds how many buckets a single result can make winners. The VRF callback reads
///  that fixed number of buckets and never walks the bet array, so it cannot run out of gas
///  as volume grows.
///
///  Games are concrete contracts inheriting this one, not external modules called from it.
///  An external call inside `fulfillRandomWords` would be a new way for the callback to
///  revert, and a reverting callback is exactly how ColorColor v2 bricked.
abstract contract PredictionGameBase is
    IPredictionGame,
    VRFConsumerBaseV2Plus,
    AutomationCompatibleInterface,
    ReentrancyGuard,
    Pausable
{
    using SafeERC20 for IERC20;

    /// @notice Minimum stake per bet, in USDC (6 decimals).
    uint256 public constant MIN_STAKE = 100_000; // $0.10

    /// @notice Referral and treasury cuts, in bps of the gross stake.
    uint256 public constant REFERRAL_BPS = 200; // 2%
    uint256 public constant TREASURY_BPS = 100; // 1%

    // ──────────────────────────────────────────────
    //  Structs
    // ──────────────────────────────────────────────

    struct Bet {
        address player;
        uint96 stake;       // gross stake; uint96 is far beyond any real USDC amount
        bytes32 selection;  // canonical encoding
        uint8 market;
        bool claimed;
    }

    struct DrawResult {
        bytes32 outcome;      // game-specific packing; see each game's `_deriveOutcome`
        uint64 timestamp;
        uint256 totalPayout;  // total owed to winners, computed at settlement
        bool settled;
    }

    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────

    IERC20 public immutable usdc;
    ReferralManager public immutable referralManager;
    HouseVault public houseVault;
    address public treasury;

    /// @notice Priced into every payout multiplier.
    uint256 public houseEdgeBps;

    /// @notice Hard cap on a single bet's payout. Mandatory: rare outcomes pay thousands of
    ///         times the stake, so an uncapped bet could obligate the house for a fortune.
    uint256 public maxPayoutPerBet;

    /// @notice Worst-case draw liability allowed, as bps of this game's allocated bankroll.
    uint256 public maxExposureBps;

    uint256 public drawInterval;

    /// @notice Seconds before the draw time that betting closes. Zero means betting stays
    ///         open until upkeep requests the draw, which is ColorColor's original behaviour.
    uint256 public betCutoff;

    uint256 public lastDrawTimestamp;
    uint256 public currentDrawId;
    bool public drawPending;

    /// @notice The VRF request the open draw is waiting on. Zero when no draw is pending.
    /// @dev A cancelled request can still be fulfilled later. Without this the late callback
    ///      would settle a draw that a newer request has since settled, or is about to.
    uint256 public pendingRequestId;

    uint256 public s_subscriptionId;
    bytes32 public s_keyHash;
    uint32 public s_callbackGasLimit;
    uint16 public s_requestConfirmations;

    /// @notice Bill VRF to the subscription's native balance (POL on Polygon) instead of LINK.
    /// @dev Defaults to LINK. Running on native means one funding token instead of two, which
    ///      removes a whole class of outage: a subscription that quietly runs dry presents
    ///      exactly like a bricked draw, and having two balances to watch doubles the chance
    ///      of missing one.
    bool public s_nativePayment;

    mapping(uint256 => uint256) public vrfRequestToDrawId;
    mapping(uint256 => DrawResult) public draws;
    mapping(uint256 => Bet[]) public bets;

    /// @notice Payout owed if a given selection wins. drawId => market => selection => payout.
    ///         This is what makes settlement O(1).
    mapping(uint256 => mapping(uint8 => mapping(bytes32 => uint256))) public liability;

    /// @notice Largest single-selection liability per market, for the exposure bound.
    mapping(uint256 => mapping(uint8 => uint256)) public maxBucket;

    /// @notice Total liability across every selection of a market, for the exposure bound.
    mapping(uint256 => mapping(uint8 => uint256)) public totalLiability;

    /// @notice Stake retained by the house this draw (gross minus referral and treasury).
    mapping(uint256 => uint256) public drawRetained;

    /// @notice Bet indices per player per draw, so the UI can list and claim without an indexer.
    mapping(uint256 => mapping(address => uint256[])) internal playerBets;

    /// @notice The edge each market's bets were booked at, plus one, per draw. Zero means no
    ///         bet has been booked in that market yet.
    /// @dev Claims pay at the booked edge rather than the current one. Otherwise an edge
    ///      change after settlement would make claims disagree with the `totalPayout` that
    ///      settlement reserved: a lower edge would pay out funds reserved for other draws.
    mapping(uint256 => mapping(uint8 => uint256)) internal _bookedEdgePlusOne;

    /// @notice Total owed to winners across all settled, unclaimed bets.
    uint256 public unclaimedLiability;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

    event BetPlaced(
        uint256 indexed drawId,
        uint256 indexed betIndex,
        address indexed player,
        uint8 market,
        uint256 stake,
        bytes32 selection,
        uint256 potentialPayout
    );
    event DrawRequested(uint256 indexed drawId, uint256 vrfRequestId);
    event DrawSettled(uint256 indexed drawId, bytes32 outcome, uint256 totalPayout);
    event PrizeClaimed(uint256 indexed drawId, uint256 indexed betIndex, address indexed player, uint256 payout);
    event DrawCancelled(uint256 indexed drawId);
    /// @dev A VRF callback arrived for a request that is no longer the open draw's, or for a
    ///      draw already settled. It is ignored; the word is discarded unused.
    event StaleFulfilment(uint256 indexed vrfRequestId, uint256 indexed drawId);
    event TreasuryUpdated(address indexed treasury);
    /// @dev The draw settled but its P&L did not reach the bankroll. Should be unreachable;
    ///      if it fires, the vault wiring is broken and needs owner attention.
    event HouseSettlementFailed(uint256 indexed drawId, bool wasProfit, uint256 amount);
    event VRFConfigUpdated(uint256 subscriptionId, bytes32 keyHash, uint32 callbackGasLimit, uint16 requestConfirmations);
    event DrawIntervalUpdated(uint256 newInterval);
    event BetCutoffUpdated(uint256 newCutoff);
    event NativePaymentUpdated(bool nativePayment);
    event RiskParamsUpdated(uint256 houseEdgeBps, uint256 maxPayoutPerBet, uint256 maxExposureBps);
    event HouseVaultUpdated(address indexed vault);

    // ──────────────────────────────────────────────
    //  Errors
    // ──────────────────────────────────────────────

    error StakeTooLow();
    error BettingClosed();
    error DrawNotSettled();
    error AlreadyClaimed();
    error NotWinner();
    error NotBetOwner();
    error NotReadyToDraw();
    error NoPendingDraw();
    error PayoutExceedsCap();
    error ExposureLimitReached();
    error InsufficientBankroll();
    error InvalidConfig();
    error InvalidMarket();

    // ──────────────────────────────────────────────
    //  Game hooks
    // ──────────────────────────────────────────────

    /// @notice Number of markets this game offers. Market ids are 0..numMarkets()-1.
    function numMarkets() public pure virtual returns (uint8);

    /// @dev Reverts on an invalid selection. `drawId` lets a game read per-round state.
    ///      Only called with `market < numMarkets()`.
    function _validate(uint256 drawId, uint8 market, bytes32 sel) internal view virtual;

    /// @dev Map logically identical selections to one bucket key. Settlement enumerates
    ///      canonical keys only, so a non-canonical bucket would be silently unpaid.
    function _canonicalize(uint8 market, bytes32 sel) internal pure virtual returns (bytes32);

    /// @dev Exact payout for a winning bet, after `edgeBps`. Must round DOWN.
    function _payoutFor(uint256 drawId, uint8 market, bytes32 sel, uint256 stake, uint256 edgeBps)
        internal
        view
        virtual
        returns (uint256);

    /// @dev Upper bound on how many distinct selections of `market` can win on one result.
    function _maxSimultaneousWinners(uint8 market) internal pure virtual returns (uint256);

    /// @dev Turn a VRF word into a packed result. Runs inside the VRF callback: must be pure
    ///      or bounded, and must never revert.
    function _deriveOutcome(uint256 drawId, uint256 word) internal view virtual returns (bytes32 outcome);

    /// @dev Sum liability over every winning bucket implied by `outcome`. Runs inside the VRF
    ///      callback: bounded loop over buckets, never over bets, and must never revert.
    function _totalPayoutFor(uint256 drawId, bytes32 outcome) internal view virtual returns (uint256);

    function _isWinner(uint256 drawId, bytes32 outcome, uint8 market, bytes32 sel)
        internal
        view
        virtual
        returns (bool);

    /// @dev Optional: runs at the end of settlement, e.g. to commit the next race card. Runs
    ///      inside the VRF callback, so the same never-revert rule applies.
    function _afterSettle(uint256 drawId, uint256 word) internal virtual {}

    /// @dev Edge applied to `market` for new bets. Flat by default; a game may price some
    ///      markets higher. It must not change while the open draw has bets, because every
    ///      bet in a (draw, market) bucket shares one booked edge — `setRiskParams` enforces
    ///      that for the flat edge. Claims use `_bookedEdge`, not this.
    function _edgeFor(uint8) internal view virtual returns (uint256) {
        return houseEdgeBps;
    }

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────

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
        uint256 _betCutoff
    ) VRFConsumerBaseV2Plus(_vrfCoordinator) {
        if (_houseEdgeBps > 2_000 || _maxExposureBps > 10_000) revert InvalidConfig();
        _checkCutoff(_betCutoff, _drawInterval);

        usdc = IERC20(_usdc);
        referralManager = ReferralManager(_referralManager);
        houseVault = HouseVault(_houseVault);
        treasury = _treasury;

        s_subscriptionId = _subscriptionId;
        s_keyHash = _keyHash;
        s_callbackGasLimit = _callbackGasLimit;
        s_requestConfirmations = 3;

        drawInterval = _drawInterval;
        betCutoff = _betCutoff;
        houseEdgeBps = _houseEdgeBps;
        maxPayoutPerBet = _maxPayoutPerBet;
        maxExposureBps = _maxExposureBps;

        lastDrawTimestamp = block.timestamp;
        currentDrawId = 1;

        // The vault pulls profit via transferFrom, so it needs a standing allowance.
        IERC20(_usdc).forceApprove(_houseVault, type(uint256).max);

        if (_owner != msg.sender) transferOwnership(_owner);
    }

    // ──────────────────────────────────────────────
    //  Betting
    // ──────────────────────────────────────────────

    /// @notice Place a fixed-odds bet on the current draw.
    /// @dev The payout is locked in here and cannot change afterwards. `market` is a `uint8`,
    ///      which is also how Solidity ABI-encodes an enum, so a game whose markets were once
    ///      an enum keeps the same selector and calldata.
    function placeBet(uint8 market, bytes32 selection, uint256 stake, address referrer)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 betIndex, uint256 payout)
    {
        if (stake < MIN_STAKE) revert StakeTooLow();
        if (drawPending) revert BettingClosed();
        if (market >= numMarkets()) revert InvalidMarket();

        if (betCutoff != 0) {
            uint256 start = _roundStart();
            if (start != lastDrawTimestamp) lastDrawTimestamp = start;
            if (block.timestamp >= start + drawInterval - betCutoff) revert BettingClosed();
        }

        uint256 drawId = currentDrawId;

        _validate(drawId, market, selection);
        selection = _canonicalize(market, selection);

        uint256 edgeBps = _edgeFor(market);
        payout = _payoutFor(drawId, market, selection, stake, edgeBps);
        if (payout > maxPayoutPerBet) revert PayoutExceedsCap();

        // Book the liability, then re-check the worst case a single result could cost us.
        uint256 bucket = liability[drawId][market][selection] + payout;
        liability[drawId][market][selection] = bucket;
        if (bucket > maxBucket[drawId][market]) maxBucket[drawId][market] = bucket;
        totalLiability[drawId][market] += payout;
        if (_bookedEdgePlusOne[drawId][market] == 0) _bookedEdgePlusOne[drawId][market] = edgeBps + 1;

        uint256 exposure = _worstCaseExposure(drawId);
        uint256 allowed = (houseVault.gameBankroll(address(this)) * maxExposureBps) / 10_000;
        if (exposure > allowed) revert ExposureLimitReached();

        usdc.safeTransferFrom(msg.sender, address(this), stake);
        uint256 retained = _distributeCuts(stake, msg.sender, referrer);
        drawRetained[drawId] += retained;

        betIndex = bets[drawId].length;
        bets[drawId].push(
            Bet({
                player: msg.sender,
                stake: uint96(stake),
                selection: selection,
                market: market,
                claimed: false
            })
        );
        playerBets[drawId][msg.sender].push(betIndex);

        // LPs cannot withdraw the bankroll out from under a bet that has already landed.
        houseVault.lockCollateral(exposure);

        emit BetPlaced(drawId, betIndex, msg.sender, market, stake, selection, payout);
    }

    /// @dev Start of the open round. With a cutoff, a round whose betting window passed with
    ///      no bets never draws (`_canDraw` needs a bet), so on its own it would stay closed
    ///      forever. Instead it rolls forward by whole intervals to the first window still
    ///      open, which keeps every round on the same `lastDrawTimestamp + k·interval` grid.
    ///      `k = (elapsed + cutoff) / interval` is the smallest k with
    ///      `now < start + k·interval + interval − cutoff`.
    function _roundStart() internal view returns (uint256 start) {
        start = lastDrawTimestamp;
        if (betCutoff == 0 || bets[currentDrawId].length > 0) return start;
        if (block.timestamp < start + drawInterval - betCutoff) return start;
        uint256 elapsed = block.timestamp - start;
        start += ((elapsed + betCutoff) / drawInterval) * drawInterval;
    }

    /// @dev A cutoff of zero disables the time-based close. Otherwise it must leave part of
    ///      every interval open for betting.
    function _checkCutoff(uint256 cutoff, uint256 interval) internal pure {
        if (cutoff != 0 && cutoff >= interval) revert InvalidConfig();
    }

    /// @dev The edge `market`'s bets in `drawId` were booked at. Falls back to the current
    ///      edge for a market with no bets, which can only matter for a quote.
    function _bookedEdge(uint256 drawId, uint8 market) internal view returns (uint256) {
        uint256 booked = _bookedEdgePlusOne[drawId][market];
        return booked == 0 ? _edgeFor(market) : booked - 1;
    }

    /// @dev Strict upper bound on what any single result could cost the house this draw.
    ///
    ///      Two independent bounds per market, whichever is tighter:
    ///        - at most `_maxSimultaneousWinners` selections can win, and none can be worth
    ///          more than the largest bucket;
    ///        - and no result can possibly pay out more than every bet of that market combined.
    ///
    ///      The second bound matters a lot in practice. ColorColor's PICK3 allows 20
    ///      simultaneous winners, so the first bound alone reserves 20x the largest bucket even
    ///      when only one selection has been backed — throttling a $1 bet as if it were $20.
    ///      Taking the min stays strictly correct while letting real volume through.
    function _worstCaseExposure(uint256 drawId) internal view returns (uint256 total) {
        uint8 n = numMarkets();
        for (uint8 t = 0; t < n; t++) {
            uint256 spread = _maxSimultaneousWinners(t) * maxBucket[drawId][t];
            uint256 everything = totalLiability[drawId][t];
            total += spread < everything ? spread : everything;
        }
    }

    /// @dev Pay referral and treasury out of the gross stake; the rest is house working capital.
    function _distributeCuts(uint256 stake, address player, address referrer)
        internal
        returns (uint256 retained)
    {
        uint256 referralCut = (stake * REFERRAL_BPS) / 10_000;
        uint256 treasuryCut = (stake * TREASURY_BPS) / 10_000;

        if (referralCut > 0) {
            usdc.safeTransfer(address(referralManager), referralCut);
            referralManager.recordSale(player, referrer, referralCut);
        }
        if (treasuryCut > 0 && treasury != address(0)) {
            usdc.safeTransfer(treasury, treasuryCut);
        }

        retained = stake - referralCut - treasuryCut;
    }

    // ──────────────────────────────────────────────
    //  Draw execution
    // ──────────────────────────────────────────────

    /// @dev `performData` must be explicitly assigned. Leaving a `bytes memory` return
    ///      unset ABI-encodes a garbage offset under via_ir, which corrupts memory in
    ///      whatever calls this.
    function checkUpkeep(bytes calldata)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        upkeepNeeded = _canDraw();
        performData = "";
    }

    function performUpkeep(bytes calldata) external override nonReentrant {
        if (!_canDraw()) revert NotReadyToDraw();

        drawPending = true;

        uint256 requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: s_keyHash,
                subId: s_subscriptionId,
                requestConfirmations: s_requestConfirmations,
                callbackGasLimit: s_callbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: s_nativePayment})
                )
            })
        );

        vrfRequestToDrawId[requestId] = currentDrawId;
        pendingRequestId = requestId;
        emit DrawRequested(currentDrawId, requestId);
    }

    /// @dev Draws run on the clock, but only when there is something to settle. An empty
    ///      draw would spend a VRF request (and LINK) to decide nothing, and at a 180s
    ///      interval that is ~480 wasted requests a day while nobody is playing.
    function _canDraw() internal view returns (bool) {
        return !drawPending
            && block.timestamp >= lastDrawTimestamp + drawInterval
            && bets[currentDrawId].length > 0;
    }

    /// @notice VRF callback. Records the result, settles house P&L, opens the next draw.
    /// @dev Must never revert: a revert here leaves `drawPending` stuck high forever, which
    ///      is exactly how ColorColor v2 bricked. Every operation below is either pure or
    ///      bounded, the game hooks are held to the same rule, and every vault call sits
    ///      inside a try/catch.
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        uint256 drawId = vrfRequestToDrawId[requestId];
        DrawResult storage result = draws[drawId];

        // Only the request the open draw is waiting on may settle it. Anything else is a
        // callback for a request that was cancelled and superseded, and settling on it would
        // record a second outcome for the same draw, double its liability and P&L, and
        // re-seed the next round's card after bets may already be priced on it. Returning,
        // not reverting, keeps the "never revert" rule.
        if (pendingRequestId == 0 || requestId != pendingRequestId || result.settled) {
            emit StaleFulfilment(requestId, drawId);
            return;
        }

        uint256 word = randomWords[0];

        bytes32 outcome = _deriveOutcome(drawId, word);
        result.outcome = outcome;
        result.timestamp = uint64(block.timestamp);
        result.settled = true;

        uint256 totalPayout = _totalPayoutFor(drawId, outcome);
        result.totalPayout = totalPayout;
        unclaimedLiability += totalPayout;

        _settleHousePnL(drawId, totalPayout);

        lastDrawTimestamp = block.timestamp;
        currentDrawId = drawId + 1;
        drawPending = false;
        pendingRequestId = 0;

        _afterSettle(drawId, word);

        emit DrawSettled(drawId, outcome, totalPayout);
    }

    /// @dev Move the draw's net result to or from the bankroll, leaving exactly `totalPayout`
    ///      in this contract to cover the winners.
    ///
    ///      Every vault call is wrapped, because this runs inside the VRF callback and that
    ///      callback must not be able to revert. A vault that has been migrated, or that has
    ///      de-authorised this game mid-draw, would otherwise pin `drawPending` high forever
    ///      and brick the game permanently — the failure that killed v2. Degrading here
    ///      leaves the draw settled and the P&L unsettled, which the owner can repair;
    ///      reverting here leaves nothing to repair.
    function _settleHousePnL(uint256 drawId, uint256 totalPayout) internal {
        uint256 retained = drawRetained[drawId];

        if (retained > totalPayout) {
            try houseVault.pushProfit(retained - totalPayout) {}
            catch {
                emit HouseSettlementFailed(drawId, true, retained - totalPayout);
            }
        } else if (totalPayout > retained) {
            try houseVault.pullLoss(totalPayout - retained) returns (uint256) {}
            catch {
                emit HouseSettlementFailed(drawId, false, totalPayout - retained);
            }
        }

        // Next draw starts with no exposure.
        try houseVault.lockCollateral(0) {} catch {}
    }

    // ──────────────────────────────────────────────
    //  Claiming
    // ──────────────────────────────────────────────

    /// @notice Claim a winning bet. Payout is fixed odds on the gross stake.
    function claimPrize(uint256 drawId, uint256 betIndex) external nonReentrant returns (uint256 payout) {
        DrawResult storage result = draws[drawId];
        if (!result.settled) revert DrawNotSettled();

        Bet storage bet = bets[drawId][betIndex];
        if (bet.player != msg.sender) revert NotBetOwner();
        if (bet.claimed) revert AlreadyClaimed();
        if (!_isWinner(drawId, result.outcome, bet.market, bet.selection)) revert NotWinner();

        bet.claimed = true;
        payout = _payoutFor(drawId, bet.market, bet.selection, bet.stake, _bookedEdge(drawId, bet.market));

        // Should never bind: settlement already secured exactly `totalPayout` for this draw.
        // If it ever does, fail loudly and recoverably rather than paying a partial amount.
        if (usdc.balanceOf(address(this)) < payout) revert InsufficientBankroll();

        unclaimedLiability -= payout;
        usdc.safeTransfer(msg.sender, payout);

        emit PrizeClaimed(drawId, betIndex, msg.sender, payout);
    }

    // ──────────────────────────────────────────────
    //  Views
    // ──────────────────────────────────────────────

    function getBet(uint256 drawId, uint256 betIndex)
        external
        view
        returns (address player, uint8 market, uint256 stake, bytes32 selection, bool claimed, uint256 payout)
    {
        Bet storage b = bets[drawId][betIndex];
        return (
            b.player,
            b.market,
            b.stake,
            b.selection,
            b.claimed,
            _payoutFor(drawId, b.market, b.selection, b.stake, _bookedEdge(drawId, b.market))
        );
    }

    function getBetCount(uint256 drawId) external view returns (uint256) {
        return bets[drawId].length;
    }

    /// @notice Bet indices belonging to a player in a draw — powers the "my bets" and claim UI.
    function getPlayerBets(uint256 drawId, address player) external view returns (uint256[] memory) {
        return playerBets[drawId][player];
    }

    function isBetWinner(uint256 drawId, uint256 betIndex) external view returns (bool) {
        DrawResult storage result = draws[drawId];
        if (!result.settled) return false;
        Bet storage b = bets[drawId][betIndex];
        return _isWinner(drawId, result.outcome, b.market, b.selection);
    }

    /// @notice Seconds until the next draw can be triggered.
    function timeUntilDraw() external view returns (uint256) {
        uint256 next = lastDrawTimestamp + drawInterval;
        return block.timestamp >= next ? 0 : next - block.timestamp;
    }

    /// @notice When betting on the open draw closes, for the frontend countdown.
    /// @dev With no cutoff this is the earliest moment upkeep can request the draw; bets are
    ///      still accepted after it until upkeep actually fires.
    function bettingClosesAt() external view returns (uint256) {
        return _roundStart() + drawInterval - betCutoff;
    }

    /// @notice Whether a bet placed now would be accepted on timing grounds: not paused, no
    ///         draw in flight, and the cutoff not yet passed. Mirrors the gating in `placeBet`
    ///         so a pre-flight check (`AgentMandate.canBet`, a relayer) agrees with it.
    function bettingOpen() external view returns (bool) {
        if (paused() || drawPending) return false;
        if (betCutoff == 0) return true;
        return block.timestamp < _roundStart() + drawInterval - betCutoff;
    }

    /// @notice The edge bets in `market` of `drawId` were booked at (the current edge if none).
    function bookedEdgeBps(uint256 drawId, uint8 market) external view returns (uint256) {
        return _bookedEdge(drawId, market);
    }

    /// @notice Worst-case liability of the open draw, and the limit it is checked against.
    function currentExposure() external view returns (uint256 exposure, uint256 allowed) {
        exposure = _worstCaseExposure(currentDrawId);
        allowed = (houseVault.gameBankroll(address(this)) * maxExposureBps) / 10_000;
    }

    // ──────────────────────────────────────────────
    //  Admin
    // ──────────────────────────────────────────────

    function updateVRFConfig(
        uint256 _subscriptionId,
        bytes32 _keyHash,
        uint32 _callbackGasLimit,
        uint16 _requestConfirmations
    ) external onlyOwner {
        s_subscriptionId = _subscriptionId;
        s_keyHash = _keyHash;
        s_callbackGasLimit = _callbackGasLimit;
        s_requestConfirmations = _requestConfirmations;
        emit VRFConfigUpdated(_subscriptionId, _keyHash, _callbackGasLimit, _requestConfirmations);
    }

    /// @notice Switch VRF billing between LINK and the chain's native token.
    /// @dev Fund the matching balance first — `fundSubscription` for LINK,
    ///      `fundSubscriptionWithNative` for native. Flipping onto an empty balance makes
    ///      every draw request revert on the coordinator.
    function setNativePayment(bool _nativePayment) external onlyOwner {
        s_nativePayment = _nativePayment;
        emit NativePaymentUpdated(_nativePayment);
    }

    function setDrawInterval(uint256 _drawInterval) external onlyOwner {
        _checkCutoff(betCutoff, _drawInterval);
        drawInterval = _drawInterval;
        emit DrawIntervalUpdated(_drawInterval);
    }

    function setBetCutoff(uint256 _betCutoff) external onlyOwner {
        _checkCutoff(_betCutoff, drawInterval);
        betCutoff = _betCutoff;
        emit BetCutoffUpdated(_betCutoff);
    }

    /// @dev Applies to bets placed from here on. Bets already booked keep the odds they were
    ///      quoted: claims pay at the edge booked for their draw. The edge still must not
    ///      change while the open draw has bets, because a bucket holds one booked edge.
    function setRiskParams(uint256 _houseEdgeBps, uint256 _maxPayoutPerBet, uint256 _maxExposureBps)
        external
        onlyOwner
    {
        if (_houseEdgeBps > 2_000 || _maxExposureBps > 10_000) revert InvalidConfig();
        if (bets[currentDrawId].length > 0) revert BettingClosed();

        houseEdgeBps = _houseEdgeBps;
        maxPayoutPerBet = _maxPayoutPerBet;
        maxExposureBps = _maxExposureBps;
        emit RiskParamsUpdated(_houseEdgeBps, _maxPayoutPerBet, _maxExposureBps);
    }

    function setHouseVault(address _houseVault) external onlyOwner {
        if (_houseVault == address(0)) revert InvalidConfig();
        usdc.forceApprove(address(houseVault), 0);
        houseVault = HouseVault(_houseVault);
        usdc.forceApprove(_houseVault, type(uint256).max);
        emit HouseVaultUpdated(_houseVault);
    }

    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    /// @notice Owner escape hatch for a VRF request that is never fulfilled.
    /// @dev Without this a dropped callback pins `drawPending` high forever and bricks the
    ///      game — this happened to ColorColor v2 on Amoy. Bets stay in the open draw and
    ///      settle on the next successful one.
    function cancelPendingDraw() external onlyOwner {
        if (!drawPending) revert NoPendingDraw();
        drawPending = false;
        pendingRequestId = 0;
        lastDrawTimestamp = block.timestamp;
        emit DrawCancelled(currentDrawId);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
