// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title HouseVault
/// @notice The bankroll behind the fixed-odds virtual game. LPs deposit USDC and take the
///         other side of every bet: they absorb losing draws and keep winning ones.
///
/// This exists because `LPVault` structurally cannot back a fixed-odds game. Its
/// `yieldPerShare` accounting only ever increases — there is no way to express a draw where
/// the house lost. Here, share price is `totalAssets / totalShares` and moves in both
/// directions: a losing draw dilutes it, a winning draw lifts it.
///
/// Two guards protect LPs and players from each other:
///
///   - `lockedCollateral` — each game reports its worst-case outstanding liability into
///     `lockedBy`, the vault keeps the sum, and LPs cannot withdraw below it. Without this an
///     LP could watch a large bet land and withdraw the bankroll before the draw settles,
///     leaving the winner unpayable. Per-game locks matter as soon as there are two games:
///     a single global value would let one game's report overwrite the other's.
///   - `allocationBps` — the share of the bankroll each game may size its exposure against.
///     The sum stays at or under 100%, so two games cannot both commit the whole bankroll.
///   - Dead shares on first deposit, the standard guard against a first depositor inflating
///     share price and stealing later deposits through rounding.
///
/// `totalAssets` is tracked explicitly rather than read from `balanceOf`, so a direct USDC
/// transfer to this contract cannot move the share price.
contract HouseVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Shares burned on the first deposit so share price cannot be inflated.
    uint256 public constant DEAD_SHARES = 1_000;

    /// @notice Minimum first deposit, so `DEAD_SHARES` is never a meaningful fraction.
    uint256 public constant MIN_INITIAL_DEPOSIT = 1e6; // $1 USDC

    IERC20 public immutable usdc;

    /// @notice Total USDC backing the vault. Moves with deposits, withdrawals, and draw P&L.
    uint256 public totalAssets;

    /// @notice Total shares outstanding, including `DEAD_SHARES`.
    uint256 public totalShares;

    mapping(address => uint256) public shares;

    /// @notice Game contracts allowed to settle P&L against the bankroll.
    mapping(address => bool) public authorizedGames;

    /// @notice Worst-case liability the bankroll must stay able to cover: the sum of `lockedBy`.
    uint256 public lockedCollateral;

    /// @notice Each game's own reported worst-case liability.
    mapping(address => uint256) public lockedBy;

    /// @notice Share of the bankroll, in bps, each game may size its exposure against.
    mapping(address => uint16) public allocationBps;

    /// @notice Sum of `allocationBps` across games. Never above 10_000.
    uint256 public totalAllocationBps;

    event GameAuthorized(address indexed game, bool authorized);
    event Deposited(address indexed user, uint256 assets, uint256 sharesMinted);
    event Withdrawn(address indexed user, uint256 assets, uint256 sharesBurned);
    event ProfitPushed(address indexed game, uint256 amount, uint256 newTotalAssets);
    event LossPulled(address indexed game, uint256 amount, uint256 newTotalAssets);
    event CollateralLocked(address indexed game, uint256 amount);
    event AllocationSet(address indexed game, uint16 bps, uint256 totalBps);
    /// @dev The owner wrote off a de-authorised game's lock. Never happens implicitly.
    event CollateralReleased(address indexed game, uint256 amount);
    /// @dev Emitted when the game asked for more than the bankroll held. Should be
    ///      unreachable while the game's exposure cap is set sanely; loud if it ever fires.
    event BankrollShortfall(address indexed game, uint256 requested, uint256 available);

    error NotAuthorizedGame();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientShares();
    error WouldUndercollateralize();
    error InitialDepositTooSmall();
    error AllocationExceeded();
    error GameStillAuthorized();

    modifier onlyAuthorizedGame() {
        if (!authorizedGames[msg.sender]) revert NotAuthorizedGame();
        _;
    }

    constructor(address _usdc, address _owner) Ownable(_owner) {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
    }

    // ──────────────────────────────────────────────
    //  Admin
    // ──────────────────────────────────────────────

    /// @notice Authorise or de-authorise a game.
    /// @dev De-authorising always succeeds, because it is the emergency stop for a broken or
    ///      compromised game. It frees the game's allocation, so it can take no new exposure,
    ///      but deliberately leaves `lockedBy[game]` in place: the game may still have an open
    ///      draw with bets on it, and dropping the lock would let LPs withdraw the money
    ///      backing them. The lock clears either when the game is re-authorised and settles,
    ///      or when the owner explicitly calls `releaseCollateral`.
    function setAuthorizedGame(address game, bool authorized) external onlyOwner {
        if (game == address(0)) revert ZeroAddress();
        authorizedGames[game] = authorized;
        emit GameAuthorized(game, authorized);

        if (!authorized && allocationBps[game] != 0) {
            totalAllocationBps -= allocationBps[game];
            allocationBps[game] = 0;
            emit AllocationSet(game, 0, totalAllocationBps);
        }
    }

    /// @notice Set the share of the bankroll a game may size its exposure against.
    function setAllocation(address game, uint16 bps) external onlyOwner {
        if (!authorizedGames[game]) revert NotAuthorizedGame();

        uint256 total = totalAllocationBps - allocationBps[game] + bps;
        if (total > 10_000) revert AllocationExceeded();

        totalAllocationBps = total;
        allocationBps[game] = bps;
        emit AllocationSet(game, bps, total);
    }

    /// @notice Write off a de-authorised game's lock, once its open draw is resolved.
    /// @dev Only for games that can no longer report their own lock. An authorised game
    ///      releases its lock itself when its draw settles.
    function releaseCollateral(address game) external onlyOwner {
        if (authorizedGames[game]) revert GameStillAuthorized();

        uint256 amount = lockedBy[game];
        lockedCollateral -= amount;
        lockedBy[game] = 0;
        emit CollateralReleased(game, amount);
    }

    // ──────────────────────────────────────────────
    //  LP entry / exit
    // ──────────────────────────────────────────────

    /// @notice Deposit USDC and mint shares at the current share price.
    function deposit(uint256 assets) external nonReentrant returns (uint256 minted) {
        if (assets == 0) revert ZeroAmount();

        uint256 supply = totalShares;
        if (supply == 0) {
            if (assets < MIN_INITIAL_DEPOSIT) revert InitialDepositTooSmall();
            // Burn DEAD_SHARES to the vault itself so no one can own 100% of a tiny supply
            // and round later depositors to zero.
            minted = assets - DEAD_SHARES;
            totalShares = assets;
            shares[address(this)] = DEAD_SHARES;
        } else {
            minted = (assets * supply) / totalAssets;
            if (minted == 0) revert ZeroAmount();
            totalShares = supply + minted;
        }

        shares[msg.sender] += minted;
        totalAssets += assets;

        usdc.safeTransferFrom(msg.sender, address(this), assets);
        emit Deposited(msg.sender, assets, minted);
    }

    /// @notice Burn shares and withdraw the corresponding assets.
    /// @dev Blocked if it would drop the bankroll below the game's outstanding liability.
    function withdraw(uint256 shareAmount) external nonReentrant returns (uint256 assets) {
        if (shareAmount == 0) revert ZeroAmount();
        if (shares[msg.sender] < shareAmount) revert InsufficientShares();

        assets = (shareAmount * totalAssets) / totalShares;
        if (assets == 0) revert ZeroAmount();
        if (totalAssets - assets < lockedCollateral) revert WouldUndercollateralize();

        shares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
        totalAssets -= assets;

        usdc.safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shareAmount);
    }

    // ──────────────────────────────────────────────
    //  Draw settlement (game only)
    // ──────────────────────────────────────────────

    /// @notice The game hands over a winning draw's profit. Lifts share price for all LPs.
    /// @dev Pulls via `transferFrom` so the reported amount cannot disagree with the
    ///      amount actually received.
    function pushProfit(uint256 amount) external onlyAuthorizedGame {
        if (amount == 0) return;
        totalAssets += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit ProfitPushed(msg.sender, amount, totalAssets);
    }

    /// @notice The game covers a losing draw from the bankroll. Dilutes share price.
    /// @dev Caps at what the vault actually holds and returns the amount sent rather than
    ///      reverting. This is called from inside the VRF callback, and a revert there
    ///      would leave the draw permanently pending — the exact failure that bricked
    ///      ColorColor v2. Undercapitalisation must degrade, never brick.
    function pullLoss(uint256 amount) external onlyAuthorizedGame returns (uint256 sent) {
        if (amount == 0) return 0;

        sent = amount > totalAssets ? totalAssets : amount;
        if (sent < amount) emit BankrollShortfall(msg.sender, amount, totalAssets);
        if (sent == 0) return 0;

        totalAssets -= sent;
        usdc.safeTransfer(msg.sender, sent);
        emit LossPulled(msg.sender, sent, totalAssets);
    }

    /// @notice The game reports its worst-case outstanding liability.
    /// @dev An absolute value per game, not a delta, so a missed call cannot desynchronise
    ///      it. Only the caller's own entry moves; other games' locks are untouched.
    function lockCollateral(uint256 amount) external onlyAuthorizedGame {
        lockedCollateral = lockedCollateral - lockedBy[msg.sender] + amount;
        lockedBy[msg.sender] = amount;
        emit CollateralLocked(msg.sender, amount);
    }

    // ──────────────────────────────────────────────
    //  Views
    // ──────────────────────────────────────────────

    /// @notice The whole bankroll, across every game.
    function bankroll() external view returns (uint256) {
        return totalAssets;
    }

    /// @notice The part of the bankroll a game may size its exposure against. Rounds down.
    function gameBankroll(address game) external view returns (uint256) {
        return (totalAssets * allocationBps[game]) / 10_000;
    }

    /// @notice Assets an LP could withdraw right now, given the outstanding lock.
    function availableToWithdraw() external view returns (uint256) {
        return totalAssets > lockedCollateral ? totalAssets - lockedCollateral : 0;
    }

    /// @notice Current value of a user's position in USDC.
    function assetsOf(address user) external view returns (uint256) {
        if (totalShares == 0) return 0;
        return (shares[user] * totalAssets) / totalShares;
    }

    /// @notice Share price scaled by 1e18. Starts at 1e18 and moves with draw P&L.
    function sharePrice() external view returns (uint256) {
        if (totalShares == 0) return 1e18;
        return (totalAssets * 1e18) / totalShares;
    }

    /// @notice Shares that `assets` would mint at the current price.
    function previewDeposit(uint256 assets) external view returns (uint256) {
        if (totalShares == 0) return assets > DEAD_SHARES ? assets - DEAD_SHARES : 0;
        return (assets * totalShares) / totalAssets;
    }
}
