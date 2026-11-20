// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPredictionGame} from "./interfaces/IPredictionGame.sol";

/// @title AgentMandate
/// @notice Lets a human hand an autonomous agent a bounded licence to play one game.
///
/// The agent holds its own key, so it can sign and act without the human present. It never
/// holds the money: funds sit here, and every limit is enforced by the EVM rather than by the
/// agent's own good behaviour. A buggy, looping, or outright compromised agent cannot exceed
/// what the principal authorised, and the principal can revoke in a single transaction.
///
/// Limits, all per mandate:
///   - `game`             — the one game this mandate may bet on, fixed for its lifetime
///   - `balance`          — the agent can never spend money that was not deposited for it
///   - `maxStakePerBet`   — caps a single bet
///   - `dailyBudget`      — caps total stake per 24h window. The window is fixed, not rolling:
///                          it opens with the mandate (or the first bet after a day idle) and
///                          resets 24h later, so up to two budgets can be spent across a boundary
///   - `cooldownSeconds`  — minimum gap between bets; the practical stop on a runaway loop
///   - `allowedMarkets`   — bitmask over that game's markets; bit i permits market i
///   - `expiry`           — the licence dies on its own
///   - `revoked`          — and the principal can kill it sooner
///
/// One contract serves every game, so the game is part of the mandate rather than of the
/// deployment. Market ids only mean something per game (market 3 is COLOR on ColorColor and
/// FORECAST on a race), so a mask approved for one game must never reach another.
///
/// A NOTE ON WHAT AGENTS CAN AND CANNOT DO HERE. Draws come from Chainlink VRF, so every
/// draw is independent, and payouts are fixed odds with the house edge priced in. There is no
/// statistical edge for an agent to discover: hot and cold numbers are gambler's fallacy, and
/// every bet is negative expected value by construction. This contract exists to make
/// *delegation* safe, not to enable alpha. Treat an agent's play as automated entertainment
/// under a budget — which is exactly why the budget is enforced here and not in the agent.
contract AgentMandate is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    uint256 public constant DAY = 1 days;

    struct Mandate {
        address principal;
        address agent;
        address game;
        address referrer;
        uint256 balance;
        uint256 maxStakePerBet;
        uint256 dailyBudget;
        uint256 spentInWindow;
        uint256 windowStart;
        uint256 lastBetAt;
        uint256 cooldownSeconds;
        uint64 expiry;
        uint32 allowedMarkets; // bit i set => market i on `game` permitted
        bool revoked;
    }

    struct BetRef {
        address game;
        uint256 drawId;
        uint256 betIndex;
    }

    Mandate[] private mandates;

    /// @notice Which mandate owns a given bet. game => drawId => betIndex => mandateId + 1 (0 = none).
    mapping(address => mapping(uint256 => mapping(uint256 => uint256))) private betOwner;

    /// @notice Every bet placed under a mandate, so an agent can enumerate and claim.
    mapping(uint256 => BetRef[]) private mandateBets;

    event MandateOpened(
        uint256 indexed mandateId,
        address indexed principal,
        address indexed agent,
        address game,
        uint256 funding,
        uint256 maxStakePerBet,
        uint256 dailyBudget,
        uint256 cooldownSeconds,
        uint64 expiry,
        uint32 allowedMarkets
    );
    event MandateFunded(uint256 indexed mandateId, uint256 amount, uint256 newBalance);
    event MandateWithdrawn(uint256 indexed mandateId, uint256 amount, uint256 newBalance);
    event MandateLimitsUpdated(
        uint256 indexed mandateId,
        uint256 maxStakePerBet,
        uint256 dailyBudget,
        uint256 cooldownSeconds,
        uint64 expiry,
        uint32 allowedMarkets
    );
    event MandateRevoked(uint256 indexed mandateId);
    event AgentBetPlaced(
        uint256 indexed mandateId,
        uint256 indexed drawId,
        uint256 indexed betIndex,
        address game,
        uint8 market,
        uint256 stake,
        uint256 potentialPayout
    );
    event AgentBetClaimed(
        uint256 indexed mandateId, address indexed game, uint256 drawId, uint256 betIndex, uint256 payout
    );

    error NotPrincipal();
    error NotAgent();
    error MandateInactive();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientMandateBalance();
    error StakeAboveMandateCap();
    error DailyBudgetExhausted();
    error CoolingDown();
    error BetTypeNotAllowed();
    error UnknownBet();
    error NoBetTypesAllowed();
    error StakeCapAboveBudget();

    constructor(address _usdc) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
    }

    // ──────────────────────────────────────────────
    //  Principal
    // ──────────────────────────────────────────────

    /// @notice Open a mandate and fund it in one call.
    /// @param game The only game this mandate may bet on.
    /// @param allowedMarkets Bitmask over `game`'s markets; bit i permits market i. For
    ///        ColorColor, 0x3F permits all six bet types.
    function openMandate(
        address agent,
        address game,
        uint256 funding,
        uint256 maxStakePerBet,
        uint256 dailyBudget,
        uint256 cooldownSeconds,
        uint64 expiry,
        uint32 allowedMarkets,
        address referrer
    ) external nonReentrant returns (uint256 mandateId) {
        if (agent == address(0) || game == address(0)) revert ZeroAddress();
        if (funding == 0 || maxStakePerBet == 0 || dailyBudget == 0) revert ZeroAmount();
        if (allowedMarkets == 0) revert NoBetTypesAllowed();
        if (maxStakePerBet > dailyBudget) revert StakeCapAboveBudget();
        if (expiry <= block.timestamp) revert MandateInactive();

        mandateId = mandates.length;
        mandates.push(
            Mandate({
                principal: msg.sender,
                agent: agent,
                game: game,
                referrer: referrer,
                balance: funding,
                maxStakePerBet: maxStakePerBet,
                dailyBudget: dailyBudget,
                spentInWindow: 0,
                windowStart: block.timestamp,
                lastBetAt: 0,
                cooldownSeconds: cooldownSeconds,
                expiry: expiry,
                allowedMarkets: allowedMarkets,
                revoked: false
            })
        );

        usdc.safeTransferFrom(msg.sender, address(this), funding);
        emit MandateOpened(
            mandateId, msg.sender, agent, game, funding, maxStakePerBet, dailyBudget, cooldownSeconds, expiry, allowedMarkets
        );
    }

    function fund(uint256 mandateId, uint256 amount) external nonReentrant {
        Mandate storage m = _mandate(mandateId);
        if (msg.sender != m.principal) revert NotPrincipal();
        if (amount == 0) revert ZeroAmount();

        m.balance += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit MandateFunded(mandateId, amount, m.balance);
    }

    /// @notice Pull funds back out. Available at any time, including after revoking.
    function withdraw(uint256 mandateId, uint256 amount) external nonReentrant {
        Mandate storage m = _mandate(mandateId);
        if (msg.sender != m.principal) revert NotPrincipal();
        if (amount == 0) revert ZeroAmount();
        if (amount > m.balance) revert InsufficientMandateBalance();

        m.balance -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit MandateWithdrawn(mandateId, amount, m.balance);
    }

    /// @notice Kill the licence immediately. Funds stay withdrawable, and bets already placed
    ///         stay claimable — revoking stops future play, it does not forfeit anything.
    function revoke(uint256 mandateId) external {
        Mandate storage m = _mandate(mandateId);
        if (msg.sender != m.principal) revert NotPrincipal();
        m.revoked = true;
        emit MandateRevoked(mandateId);
    }

    /// @dev The game is deliberately not updatable: approving a different game means opening
    ///      a new mandate, so its market mask is chosen with that game in mind.
    function updateLimits(
        uint256 mandateId,
        uint256 maxStakePerBet,
        uint256 dailyBudget,
        uint256 cooldownSeconds,
        uint64 expiry,
        uint32 allowedMarkets
    ) external {
        Mandate storage m = _mandate(mandateId);
        if (msg.sender != m.principal) revert NotPrincipal();
        if (maxStakePerBet == 0 || dailyBudget == 0) revert ZeroAmount();
        if (allowedMarkets == 0) revert NoBetTypesAllowed();
        if (maxStakePerBet > dailyBudget) revert StakeCapAboveBudget();
        if (expiry <= block.timestamp) revert MandateInactive();

        m.maxStakePerBet = maxStakePerBet;
        m.dailyBudget = dailyBudget;
        m.cooldownSeconds = cooldownSeconds;
        m.expiry = expiry;
        m.allowedMarkets = allowedMarkets;
        emit MandateLimitsUpdated(mandateId, maxStakePerBet, dailyBudget, cooldownSeconds, expiry, allowedMarkets);
    }

    // ──────────────────────────────────────────────
    //  Agent
    // ──────────────────────────────────────────────

    /// @notice Place a bet under a mandate, on the mandate's game. Only its agent may call this.
    function placeBet(uint256 mandateId, uint8 market, bytes32 selection, uint256 stake)
        external
        nonReentrant
        returns (uint256 drawId, uint256 betIndex, uint256 payout)
    {
        Mandate storage m = _mandate(mandateId);
        if (msg.sender != m.agent) revert NotAgent();

        _assertActive(m);
        if (stake == 0) revert ZeroAmount();
        if (stake > m.maxStakePerBet) revert StakeAboveMandateCap();
        if (stake > m.balance) revert InsufficientMandateBalance();
        if (!_marketAllowed(m.allowedMarkets, market)) revert BetTypeNotAllowed();
        if (m.lastBetAt != 0 && block.timestamp < m.lastBetAt + m.cooldownSeconds) revert CoolingDown();

        _rollWindow(m);
        if (m.spentInWindow + stake > m.dailyBudget) revert DailyBudgetExhausted();

        // Debit before the external call. The stake is committed either way, and this keeps
        // the accounting correct if the game reverts and the whole call unwinds.
        m.balance -= stake;
        m.spentInWindow += stake;
        m.lastBetAt = block.timestamp;

        // Exactly this stake, for exactly this mandate's game. No standing approval, so no
        // game can pull another mandate's money.
        address game = m.game;
        usdc.forceApprove(game, stake);
        drawId = IPredictionGame(game).currentDrawId();
        (betIndex, payout) = IPredictionGame(game).placeBet(market, selection, stake, m.referrer);
        usdc.forceApprove(game, 0);

        betOwner[game][drawId][betIndex] = mandateId + 1;
        mandateBets[mandateId].push(BetRef({game: game, drawId: drawId, betIndex: betIndex}));

        emit AgentBetPlaced(mandateId, drawId, betIndex, game, market, stake, payout);
    }

    /// @notice Claim a winning bet back into its mandate's balance.
    /// @dev Permissionless: the agent, the principal, or a keeper can all trigger it, and the
    ///      proceeds can only ever land in the mandate that placed the bet. The mandate is
    ///      credited with what actually arrived, not what the game reports, so a game cannot
    ///      inflate one mandate's balance at the expense of the others held here.
    function claim(address game, uint256 drawId, uint256 betIndex)
        external
        nonReentrant
        returns (uint256 payout)
    {
        uint256 owner = betOwner[game][drawId][betIndex];
        if (owner == 0) revert UnknownBet();
        uint256 mandateId = owner - 1;

        uint256 before = usdc.balanceOf(address(this));
        IPredictionGame(game).claimPrize(drawId, betIndex);
        payout = usdc.balanceOf(address(this)) - before;
        mandates[mandateId].balance += payout;

        emit AgentBetClaimed(mandateId, game, drawId, betIndex, payout);
    }

    // ──────────────────────────────────────────────
    //  Views
    // ──────────────────────────────────────────────

    function mandateCount() external view returns (uint256) {
        return mandates.length;
    }

    function getMandate(uint256 mandateId) external view returns (Mandate memory) {
        return _mandateView(mandateId);
    }

    function getMandateBets(uint256 mandateId) external view returns (BetRef[] memory) {
        return mandateBets[mandateId];
    }

    function betMandate(address game, uint256 drawId, uint256 betIndex)
        external
        view
        returns (bool known, uint256 mandateId)
    {
        uint256 owner = betOwner[game][drawId][betIndex];
        return (owner != 0, owner == 0 ? 0 : owner - 1);
    }

    /// @notice Stake still permitted in the current 24h window.
    function remainingDailyBudget(uint256 mandateId) public view returns (uint256) {
        Mandate memory m = _mandateView(mandateId);
        uint256 spent = block.timestamp >= m.windowStart + DAY ? 0 : m.spentInWindow;
        return spent >= m.dailyBudget ? 0 : m.dailyBudget - spent;
    }

    /// @notice Seconds until the agent may bet again.
    function cooldownRemaining(uint256 mandateId) public view returns (uint256) {
        Mandate memory m = _mandateView(mandateId);
        if (m.lastBetAt == 0) return 0;
        uint256 ready = m.lastBetAt + m.cooldownSeconds;
        return block.timestamp >= ready ? 0 : ready - block.timestamp;
    }

    /// @notice The single call an agent should make before trying to bet. Returns a reason
    ///         string rather than reverting, so an agent can reason about the refusal instead
    ///         of burning gas discovering it.
    function canBet(uint256 mandateId, uint8 market, uint256 stake)
        external
        view
        returns (bool ok, string memory reason)
    {
        Mandate memory m = _mandateView(mandateId);

        if (m.revoked) return (false, "mandate revoked");
        if (block.timestamp >= m.expiry) return (false, "mandate expired");
        if (stake == 0) return (false, "zero stake");
        if (stake > m.maxStakePerBet) return (false, "stake above per-bet cap");
        if (stake > m.balance) return (false, "insufficient mandate balance");
        if (!_marketAllowed(m.allowedMarkets, market)) return (false, "bet type not allowed");
        if (cooldownRemaining(mandateId) > 0) return (false, "cooling down");
        if (stake > remainingDailyBudget(mandateId)) return (false, "daily budget exhausted");
        if (IPredictionGame(m.game).drawPending()) return (false, "draw in progress, betting closed");
        if (!IPredictionGame(m.game).bettingOpen()) return (false, "betting closed for this round");
        if (stake < IPredictionGame(m.game).MIN_STAKE()) return (false, "stake below game minimum");

        return (true, "");
    }

    // ──────────────────────────────────────────────
    //  Internal
    // ──────────────────────────────────────────────

    function _mandate(uint256 mandateId) internal view returns (Mandate storage) {
        require(mandateId < mandates.length, "no such mandate");
        return mandates[mandateId];
    }

    function _mandateView(uint256 mandateId) internal view returns (Mandate memory) {
        require(mandateId < mandates.length, "no such mandate");
        return mandates[mandateId];
    }

    /// @dev Markets are below 32 on every game; anything at or above can never be allowed.
    function _marketAllowed(uint32 allowedMarkets, uint8 market) internal pure returns (bool) {
        return market < 32 && allowedMarkets & (uint32(1) << market) != 0;
    }

    function _assertActive(Mandate storage m) internal view {
        if (m.revoked || block.timestamp >= m.expiry) revert MandateInactive();
    }

    /// @dev Start a fresh budget window once a full day has elapsed since the current one
    ///      opened. The window is fixed, not rolling: `remainingDailyBudget` and this function
    ///      must agree, and a rolling sum would need per-bet history. Whole idle days are
    ///      skipped in one step.
    function _rollWindow(Mandate storage m) internal {
        if (block.timestamp >= m.windowStart + DAY) {
            m.windowStart = block.timestamp;
            m.spentInWindow = 0;
        }
    }
}
