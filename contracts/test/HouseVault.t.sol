// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @notice Share-price accounting for the house bankroll.
///
/// The property that matters, and the reason `LPVault` could not be reused: share price must
/// move in BOTH directions. `LPVault.yieldPerShare` only ever increases, so it cannot
/// represent a draw the house lost.
contract HouseVaultTest is Test {
    HouseVault vault;
    ERC20Mock usdc;

    address owner = address(1);
    address game = address(2);
    address alice = address(3);
    address bob = address(4);

    function setUp() public {
        usdc = new ERC20Mock("USDC", "USDC", 6);
        vm.prank(owner);
        vault = new HouseVault(address(usdc), owner);
        vm.prank(owner);
        vault.setAuthorizedGame(game, true);

        for (uint256 i = 0; i < 3; i++) {
            address p = [alice, bob, game][i];
            usdc.mint(p, 1_000_000e6);
            vm.prank(p);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function _deposit(address who, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return vault.deposit(amount);
    }

    // ──────────────────────────────────────────────
    //  Deposits and withdrawals
    // ──────────────────────────────────────────────

    function test_firstDepositBurnsDeadShares() public {
        uint256 minted = _deposit(alice, 1_000e6);

        assertEq(minted, 1_000e6 - vault.DEAD_SHARES(), "dead shares withheld from the first LP");
        assertEq(vault.totalShares(), 1_000e6);
        assertEq(vault.shares(address(vault)), vault.DEAD_SHARES());
        assertEq(vault.sharePrice(), 1e18, "share price starts at 1.0");
    }

    function test_initialDepositMustClearMinimum() public {
        // Resolve first — an external call in the argument list would be the one that
        // `expectRevert` and `prank` bind to.
        uint256 tooSmall = vault.MIN_INITIAL_DEPOSIT() - 1;

        vm.prank(alice);
        vm.expectRevert(HouseVault.InitialDepositTooSmall.selector);
        vault.deposit(tooSmall);
    }

    function test_secondDepositorGetsProportionalShares() public {
        _deposit(alice, 1_000e6);
        uint256 bobShares = _deposit(bob, 500e6);

        assertApproxEqRel(bobShares, 500e6, 1e15, "same price, half the shares");
        assertApproxEqAbs(vault.assetsOf(bob), 500e6, 1, "bob's position is worth what he paid");
    }

    function test_withdrawReturnsProRataAssets() public {
        _deposit(alice, 1_000e6);
        uint256 shares = vault.shares(alice);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.withdraw(shares / 2);

        assertApproxEqAbs(usdc.balanceOf(alice) - before, 500e6, 1e3);
    }

    function test_cannotWithdrawMoreSharesThanOwned() public {
        _deposit(alice, 1_000e6);
        uint256 shares = vault.shares(alice);

        vm.prank(alice);
        vm.expectRevert(HouseVault.InsufficientShares.selector);
        vault.withdraw(shares + 1);
    }

    // ──────────────────────────────────────────────
    //  Draw P&L — the whole point of this contract
    // ──────────────────────────────────────────────

    function test_profitLiftsSharePriceForAllLPs() public {
        _deposit(alice, 1_000e6);
        uint256 priceBefore = vault.sharePrice();

        vm.prank(game);
        vault.pushProfit(100e6);

        assertEq(vault.totalAssets(), 1_100e6);
        assertGt(vault.sharePrice(), priceBefore);
        assertApproxEqRel(vault.assetsOf(alice), 1_100e6, 1e15, "LP captures the whole profit");
    }

    function test_lossDilutesSharePriceForAllLPs() public {
        _deposit(alice, 1_000e6);
        uint256 priceBefore = vault.sharePrice();

        vm.prank(game);
        vault.pullLoss(200e6);

        assertEq(vault.totalAssets(), 800e6);
        assertLt(vault.sharePrice(), priceBefore, "share price must be able to fall");
        assertApproxEqRel(vault.assetsOf(alice), 800e6, 1e15, "LP absorbs the whole loss");
    }

    /// @dev An LP who joins after a loss must buy in at the depressed price, not be handed
    ///      the earlier LPs' losses or profits.
    function test_lateDepositorBuysInAtCurrentPrice() public {
        _deposit(alice, 1_000e6);

        vm.prank(game);
        vault.pullLoss(500e6); // share price halves

        _deposit(bob, 500e6);

        assertApproxEqRel(vault.assetsOf(alice), 500e6, 1e15, "alice keeps her loss");
        assertApproxEqRel(vault.assetsOf(bob), 500e6, 1e15, "bob is unaffected by it");
    }

    /// @dev Called from inside the VRF callback. A revert there would pin `drawPending` high
    ///      forever and brick the game — undercapitalisation must degrade, not brick.
    function test_pullLossCapsAtBankrollInsteadOfReverting() public {
        _deposit(alice, 1_000e6);

        vm.expectEmit(true, false, false, true);
        emit HouseVault.BankrollShortfall(game, 5_000e6, 1_000e6);

        vm.prank(game);
        uint256 sent = vault.pullLoss(5_000e6);

        assertEq(sent, 1_000e6, "sends what it has");
        assertEq(vault.totalAssets(), 0);
    }

    // ──────────────────────────────────────────────
    //  Guards
    // ──────────────────────────────────────────────

    function test_lockedCollateralBlocksWithdrawal() public {
        _deposit(alice, 1_000e6);
        uint256 shares = vault.shares(alice);

        vm.prank(game);
        vault.lockCollateral(900e6);

        assertEq(vault.availableToWithdraw(), 100e6);

        vm.prank(alice);
        vm.expectRevert(HouseVault.WouldUndercollateralize.selector);
        vault.withdraw(shares);
    }

    function test_lockedCollateralStillAllowsPartialWithdrawal() public {
        _deposit(alice, 1_000e6);

        vm.prank(game);
        vault.lockCollateral(900e6);

        vm.prank(alice);
        vault.withdraw(50e6); // well inside the free 100e6
        assertEq(vault.totalAssets(), 950e6);
    }

    function test_onlyAuthorizedGameCanSettleOrLock() public {
        _deposit(alice, 1_000e6);

        vm.startPrank(alice);
        vm.expectRevert(HouseVault.NotAuthorizedGame.selector);
        vault.pullLoss(1e6);
        vm.expectRevert(HouseVault.NotAuthorizedGame.selector);
        vault.pushProfit(1e6);
        vm.expectRevert(HouseVault.NotAuthorizedGame.selector);
        vault.lockCollateral(1e6);
        vm.stopPrank();
    }

    function test_deauthorizedGameLosesAccess() public {
        _deposit(alice, 1_000e6);

        vm.prank(owner);
        vault.setAuthorizedGame(game, false);

        vm.prank(game);
        vm.expectRevert(HouseVault.NotAuthorizedGame.selector);
        vault.pullLoss(1e6);
    }

    function test_onlyOwnerCanAuthorizeGames() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.setAuthorizedGame(alice, true);
    }

    /// @dev `totalAssets` is tracked explicitly rather than read from `balanceOf`, so a
    ///      direct transfer cannot be used to move share price under existing LPs.
    function test_directDonationDoesNotMoveSharePrice() public {
        _deposit(alice, 1_000e6);
        uint256 priceBefore = vault.sharePrice();

        vm.prank(bob);
        usdc.transfer(address(vault), 10_000e6);

        assertEq(vault.sharePrice(), priceBefore, "donation must not reprice shares");
        assertEq(vault.totalAssets(), 1_000e6);
    }

    function test_previewDepositMatchesActualMint() public {
        _deposit(alice, 1_000e6);

        vm.prank(game);
        vault.pushProfit(250e6); // move price off 1.0

        uint256 predicted = vault.previewDeposit(400e6);
        uint256 actual = _deposit(bob, 400e6);
        assertEq(actual, predicted);
    }

    function test_zeroAmountsRevert() public {
        vm.prank(alice);
        vm.expectRevert(HouseVault.ZeroAmount.selector);
        vault.deposit(0);

        _deposit(alice, 1_000e6);
        vm.prank(alice);
        vm.expectRevert(HouseVault.ZeroAmount.selector);
        vault.withdraw(0);
    }

    // ──────────────────────────────────────────────
    //  Several games on one bankroll
    // ──────────────────────────────────────────────

    address gameB = address(0xB);

    function _authorizeGameB() internal {
        vm.prank(owner);
        vault.setAuthorizedGame(gameB, true);
    }

    function _lock(address who, uint256 amount) internal {
        vm.prank(who);
        vault.lockCollateral(amount);
    }

    /// @dev The bug this replaces: one global value, so whichever game reported last erased
    ///      the other's lock and freed LP money that was backing live bets.
    function test_gamesLockIndependently() public {
        _authorizeGameB();
        _deposit(alice, 1_000e6);

        _lock(game, 300e6);
        _lock(gameB, 200e6);

        assertEq(vault.lockedBy(game), 300e6, "B's report must not overwrite A's");
        assertEq(vault.lockedBy(gameB), 200e6);
        assertEq(vault.lockedCollateral(), 500e6, "total is the sum");

        // A settles and releases; B's lock is untouched.
        _lock(game, 0);
        assertEq(vault.lockedBy(gameB), 200e6);
        assertEq(vault.lockedCollateral(), 200e6);

        // A game raising and lowering its own lock moves only its own entry.
        _lock(gameB, 50e6);
        _lock(game, 700e6);
        assertEq(vault.lockedCollateral(), 750e6);
    }

    function testFuzz_lockedCollateralIsAlwaysTheSum(uint256[8] memory amounts, uint8 who) public {
        _authorizeGameB();
        for (uint256 i = 0; i < amounts.length; i++) {
            address g = (who >> (i % 8)) & 1 == 0 ? game : gameB;
            _lock(g, bound(amounts[i], 0, 1e15));
            assertEq(
                vault.lockedCollateral(),
                vault.lockedBy(game) + vault.lockedBy(gameB),
                "lockedCollateral == sum of lockedBy after every report"
            );
        }
    }

    function test_lpCannotWithdrawCollateralLockedByEitherGame() public {
        _authorizeGameB();
        _deposit(alice, 1_000e6);
        uint256 shares = vault.shares(alice);

        _lock(game, 400e6);
        _lock(gameB, 500e6);
        assertEq(vault.availableToWithdraw(), 100e6);

        // A's lock alone would leave 600 free; B's must still count.
        vm.prank(alice);
        vm.expectRevert(HouseVault.WouldUndercollateralize.selector);
        vault.withdraw(shares / 2);

        // A releases. B's lock alone still blocks a full exit.
        _lock(game, 0);
        vm.prank(alice);
        vm.expectRevert(HouseVault.WouldUndercollateralize.selector);
        vault.withdraw(shares);

        // Inside the free 500 is fine.
        vm.prank(alice);
        vault.withdraw(shares / 4);
    }

    function test_allocationSumAbove10000Reverts() public {
        _authorizeGameB();

        vm.startPrank(owner);
        vault.setAllocation(game, 6_000);
        vault.setAllocation(gameB, 4_000);
        assertEq(vault.totalAllocationBps(), 10_000);

        vm.expectRevert(HouseVault.AllocationExceeded.selector);
        vault.setAllocation(gameB, 4_001);

        // Re-setting a game replaces its share rather than adding to it.
        vault.setAllocation(game, 5_000);
        vault.setAllocation(gameB, 5_000);
        assertEq(vault.totalAllocationBps(), 10_000);
        vm.stopPrank();
    }

    function test_singleAllocationAbove10000Reverts() public {
        vm.prank(owner);
        vm.expectRevert(HouseVault.AllocationExceeded.selector);
        vault.setAllocation(game, 10_001);
    }

    function test_allocationOnlyForAuthorizedGamesAndOnlyByOwner() public {
        vm.prank(owner);
        vm.expectRevert(HouseVault.NotAuthorizedGame.selector);
        vault.setAllocation(gameB, 1_000);

        vm.prank(alice);
        vm.expectRevert();
        vault.setAllocation(game, 1_000);
    }

    function test_gameBankrollIsTheAllocatedShare() public {
        _authorizeGameB();
        _deposit(alice, 1_000e6);

        assertEq(vault.gameBankroll(game), 0, "no allocation, nothing to risk");

        vm.startPrank(owner);
        vault.setAllocation(game, 6_000);
        vault.setAllocation(gameB, 4_000);
        vm.stopPrank();

        assertEq(vault.gameBankroll(game), 600e6);
        assertEq(vault.gameBankroll(gameB), 400e6);

        // It tracks P&L like the rest of the bankroll.
        vm.prank(game);
        vault.pushProfit(1_000e6);
        assertEq(vault.gameBankroll(gameB), 800e6);
    }

    // ──────────────────────────────────────────────
    //  De-authorising a game
    // ──────────────────────────────────────────────

    /// @dev De-authorising frees the game's allocation but keeps its lock: the game may still
    ///      have an open draw, and dropping the lock would hand LPs the money backing it.
    function test_deauthorizingKeepsTheLockAndFreesTheAllocation() public {
        _authorizeGameB();
        _deposit(alice, 1_000e6);
        uint256 shares = vault.shares(alice);

        vm.startPrank(owner);
        vault.setAllocation(game, 6_000);
        vault.setAllocation(gameB, 4_000);
        vm.stopPrank();
        _lock(game, 800e6);

        vm.prank(owner);
        vault.setAuthorizedGame(game, false);

        assertEq(vault.allocationBps(game), 0, "no new exposure");
        assertEq(vault.gameBankroll(game), 0);
        assertEq(vault.totalAllocationBps(), 4_000, "allocation is freed for other games");
        assertEq(vault.lockedBy(game), 800e6, "the lock is not dropped");
        assertEq(vault.lockedCollateral(), 800e6);

        vm.prank(alice);
        vm.expectRevert(HouseVault.WouldUndercollateralize.selector);
        vault.withdraw(shares);

        // The de-authorised game cannot release it either.
        vm.prank(game);
        vm.expectRevert(HouseVault.NotAuthorizedGame.selector);
        vault.lockCollateral(0);

        // The freed share can go to another game.
        vm.prank(owner);
        vault.setAllocation(gameB, 10_000);
    }

    function test_releaseCollateralIsExplicitAndOnlyForDeauthorizedGames() public {
        _authorizeGameB();
        _deposit(alice, 1_000e6);
        _lock(game, 800e6);
        _lock(gameB, 100e6);

        vm.prank(owner);
        vm.expectRevert(HouseVault.GameStillAuthorized.selector);
        vault.releaseCollateral(game);

        vm.prank(owner);
        vault.setAuthorizedGame(game, false);

        vm.prank(alice);
        vm.expectRevert();
        vault.releaseCollateral(game);

        vm.expectEmit(true, false, false, true);
        emit HouseVault.CollateralReleased(game, 800e6);
        vm.prank(owner);
        vault.releaseCollateral(game);

        assertEq(vault.lockedBy(game), 0);
        assertEq(vault.lockedCollateral(), 100e6, "only that game's lock is released");
        assertEq(vault.availableToWithdraw(), 900e6);
    }

    /// @dev The other way to clear a de-authorised game's lock: re-authorise it and let it
    ///      settle. Its allocation does not come back on its own.
    function test_reauthorizedGameClearsItsOwnLock() public {
        _deposit(alice, 1_000e6);
        vm.prank(owner);
        vault.setAllocation(game, 5_000);
        _lock(game, 300e6);

        vm.startPrank(owner);
        vault.setAuthorizedGame(game, false);
        vault.setAuthorizedGame(game, true);
        vm.stopPrank();

        assertEq(vault.lockedBy(game), 300e6, "lock survived the round trip");
        assertEq(vault.allocationBps(game), 0, "allocation must be set again deliberately");

        _lock(game, 0);
        assertEq(vault.lockedCollateral(), 0);
    }

    // ──────────────────────────────────────────────
    //  Round-trip invariant
    // ──────────────────────────────────────────────

    /// @dev Two LPs, arbitrary P&L: neither can ever extract more than their share of what
    ///      the vault actually holds.
    function testFuzz_lpsNeverExtractMoreThanTheVaultHolds(uint256 profit, uint256 loss) public {
        profit = bound(profit, 0, 5_000e6);
        loss = bound(loss, 0, 900e6);

        _deposit(alice, 1_000e6);
        _deposit(bob, 1_000e6);

        vm.startPrank(game);
        vault.pushProfit(profit);
        vault.pullLoss(loss);
        vm.stopPrank();

        uint256 aliceShares = vault.shares(alice);
        uint256 bobShares = vault.shares(bob);

        vm.prank(alice);
        vault.withdraw(aliceShares);
        vm.prank(bob);
        vault.withdraw(bobShares);

        assertLe(vault.totalAssets(), usdc.balanceOf(address(vault)), "vault stays solvent");
    }
}
