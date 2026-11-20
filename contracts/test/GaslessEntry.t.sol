// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GaslessEntry} from "../src/GaslessEntry.sol";
import {ColorColorGame as ColorColor} from "../src/ColorColorGame.sol";
import {PredictionGameBase} from "../src/PredictionGameBase.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {ReferralManager} from "../src/ReferralManager.sol";
import {BetType} from "../src/OddsLib.sol";
import {FiatTokenMock} from "./mocks/FiatTokenMock.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";

/// @notice The promise being tested: a player holding **only USDC and zero native token** can
/// bet and be paid. Every test therefore asserts the player's gas balance stays at zero.
contract GaslessEntryTest is Test {
    GaslessEntry entry;
    ColorColor game;
    HouseVault vault;
    ReferralManager referralManager;
    FiatTokenMock usdc;
    VRFCoordinatorV2_5Mock vrfCoordinator;

    address owner = address(1);
    address treasury = address(2);
    address lp = address(3);
    address relayer = address(4);
    address attacker = address(5);

    uint256 playerKey = 0xA11CE;
    address player;

    uint256 subId;
    uint256 nextRequestId;

    uint256 constant DRAW_INTERVAL = 180;
    uint256 constant EDGE_BPS = 800;
    uint256 constant STAKE = 10e6;

    function setUp() public {
        player = vm.addr(playerKey);

        vm.startPrank(owner);
        usdc = new FiatTokenMock("USDC", "USDC", 6);
        vrfCoordinator = new VRFCoordinatorV2_5Mock(1e17, 1e9, 4e15);
        subId = vrfCoordinator.createSubscription();
        vrfCoordinator.fundSubscription(subId, 1000 ether);

        referralManager = new ReferralManager(address(usdc), treasury, owner);
        vault = new HouseVault(address(usdc), owner);
        game = new ColorColor(
            address(usdc), address(vrfCoordinator), address(referralManager), address(vault),
            treasury, owner, subId, keccak256("k"), 2_000_000,
            DRAW_INTERVAL, EDGE_BPS, 5_000e6, 5_000
        );
        vrfCoordinator.addConsumer(subId, address(game));
        referralManager.setAuthorizedGame(address(game), true);
        vault.setAuthorizedGame(address(game), true);
        vault.setAllocation(address(game), 10_000);
        vm.stopPrank();

        entry = new GaslessEntry(address(usdc));

        usdc.mint(lp, 100_000e6);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6);
        vm.stopPrank();

        // The player has USDC and, deliberately, not a single wei of gas.
        usdc.mint(player, 1_000e6);
        vm.deal(player, 0);
        vm.deal(relayer, 10 ether);
    }

    // ──────────────────────────────────────────────
    //  Helpers
    // ──────────────────────────────────────────────

    struct Auth {
        bytes32 salt;
        uint256 validAfter;
        uint256 validBefore;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @dev Signs exactly what the token will verify, with the bet committed in the nonce.
    function _sign(BetType t, bytes32 sel, uint256 stake, bytes32 salt, uint256 signerKey)
        internal
        view
        returns (Auth memory a)
    {
        a.salt = salt;
        a.validAfter = 0;
        a.validBefore = block.timestamp + 1 hours;
        bytes32 nonce = entry.betNonce(address(game), uint8(t), sel, stake, salt);
        bytes32 digest =
            usdc.receiveDigest(player, address(entry), stake, a.validAfter, a.validBefore, nonce);
        (a.v, a.r, a.s) = vm.sign(signerKey, digest);
    }

    function _relay(BetType t, bytes32 sel, uint256 stake, Auth memory a)
        internal
        returns (uint256 drawId, uint256 betIndex)
    {
        vm.prank(relayer);
        (drawId, betIndex,) = entry.placeBetWithAuthorization(
            player, address(game), uint8(t), sel, stake, a.salt, a.validAfter, a.validBefore, a.v, a.r, a.s
        );
    }

    function _draw(uint256 word) internal {
        skip(DRAW_INTERVAL + 1);
        game.performUpkeep("");
        nextRequestId++;
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        vrfCoordinator.fulfillRandomWordsWithOverride(nextRequestId, address(game), words);
    }

    function _hiloBandOf(uint16 sum) internal pure returns (uint8) {
        if (sum <= 120) return 0;
        if (sum >= 160) return 2;
        return 1;
    }

    // ──────────────────────────────────────────────
    //  The promise
    // ──────────────────────────────────────────────

    function test_playerWithZeroGasCanBet() public {
        assertEq(player.balance, 0, "player holds no native token");

        Auth memory a = _sign(BetType.COLOR, bytes32(uint256(2)), STAKE, bytes32("s1"), playerKey);
        (uint256 drawId, uint256 betIndex) = _relay(BetType.COLOR, bytes32(uint256(2)), STAKE, a);

        assertEq(player.balance, 0, "still holds no native token");
        assertEq(usdc.balanceOf(player), 1_000e6 - STAKE, "stake left the player's wallet");
        assertEq(entry.betOwner(address(game), drawId, betIndex), player, "bet is recorded as the player's");

        // As far as the game is concerned the entry contract placed it.
        (address betPlayer,,,,,) = game.getBet(drawId, betIndex);
        assertEq(betPlayer, address(entry));
    }

    /// @dev End to end: bet and get paid without ever holding gas.
    function test_playerWithZeroGasGetsPaid() public {
        uint256[3] memory idx;
        for (uint8 band = 0; band < 3; band++) {
            Auth memory a = _sign(BetType.HILO, bytes32(uint256(band)), STAKE, bytes32(uint256(band)), playerKey);
            (, idx[band]) = _relay(BetType.HILO, bytes32(uint256(band)), STAKE, a);
        }

        _draw(uint256(keccak256("gasless")));
        (,, uint16 sum,,,) = game.getDrawResult(1);
        uint8 winner = _hiloBandOf(sum);

        uint256 before = usdc.balanceOf(player);
        vm.prank(relayer);
        uint256 payout = entry.claimFor(address(game), 1, idx[winner]);

        assertGt(payout, 0);
        assertEq(usdc.balanceOf(player) - before, payout, "winnings went straight to the player");
        assertEq(usdc.balanceOf(address(entry)), 0, "entry contract holds nothing afterwards");
        assertEq(player.balance, 0, "player never needed gas");
    }

    // ──────────────────────────────────────────────
    //  What the signature must protect
    // ──────────────────────────────────────────────

    /// @dev The whole reason the bet is committed to the nonce. A relayer that tries to spend
    ///      the authorisation on a different bet must fail — otherwise it could take the
    ///      player's stake and put it on a losing selection.
    function test_relayerCannotAlterTheBet() public {
        Auth memory a = _sign(BetType.COLOR, bytes32(uint256(2)), STAKE, bytes32("s1"), playerKey);

        vm.prank(relayer);
        vm.expectRevert(); // recomputed nonce differs -> signature does not verify
        entry.placeBetWithAuthorization(
            player, address(game), uint8(BetType.COLOR), bytes32(uint256(3)), STAKE, a.salt,
            a.validAfter, a.validBefore, a.v, a.r, a.s
        );

        vm.prank(relayer);
        vm.expectRevert(); // different bet type
        entry.placeBetWithAuthorization(
            player, address(game), uint8(BetType.HILO), bytes32(uint256(2)), STAKE, a.salt,
            a.validAfter, a.validBefore, a.v, a.r, a.s
        );
    }

    function test_relayerCannotInflateTheStake() public {
        Auth memory a = _sign(BetType.COLOR, bytes32(uint256(2)), STAKE, bytes32("s1"), playerKey);

        vm.prank(relayer);
        vm.expectRevert();
        entry.placeBetWithAuthorization(
            player, address(game), uint8(BetType.COLOR), bytes32(uint256(2)), STAKE * 10, a.salt,
            a.validAfter, a.validBefore, a.v, a.r, a.s
        );
        assertEq(usdc.balanceOf(player), 1_000e6, "nothing was taken");
    }

    function test_authorizationCannotBeReplayed() public {
        Auth memory a = _sign(BetType.COLOR, bytes32(uint256(2)), STAKE, bytes32("s1"), playerKey);
        _relay(BetType.COLOR, bytes32(uint256(2)), STAKE, a);

        vm.prank(relayer);
        vm.expectRevert(); // nonce already consumed
        entry.placeBetWithAuthorization(
            player, address(game), uint8(BetType.COLOR), bytes32(uint256(2)), STAKE, a.salt,
            a.validAfter, a.validBefore, a.v, a.r, a.s
        );
    }

    /// @dev The same bet twice is legitimate; the salt is what keeps the nonces distinct.
    function test_saltAllowsRepeatingTheSameBet() public {
        Auth memory a1 = _sign(BetType.COLOR, bytes32(uint256(2)), STAKE, bytes32("s1"), playerKey);
        Auth memory a2 = _sign(BetType.COLOR, bytes32(uint256(2)), STAKE, bytes32("s2"), playerKey);
        _relay(BetType.COLOR, bytes32(uint256(2)), STAKE, a1);
        _relay(BetType.COLOR, bytes32(uint256(2)), STAKE, a2);
        assertEq(entry.playerBetCount(player), 2);
    }

    function test_forgedSignatureRejected() public {
        uint256 wrongKey = 0xBAD;
        Auth memory a = _sign(BetType.COLOR, bytes32(uint256(2)), STAKE, bytes32("s1"), wrongKey);

        vm.prank(relayer);
        vm.expectRevert();
        entry.placeBetWithAuthorization(
            player, address(game), uint8(BetType.COLOR), bytes32(uint256(2)), STAKE, a.salt,
            a.validAfter, a.validBefore, a.v, a.r, a.s
        );
    }

    function test_expiredAuthorizationRejected() public {
        Auth memory a = _sign(BetType.COLOR, bytes32(uint256(2)), STAKE, bytes32("s1"), playerKey);
        skip(2 hours);

        vm.prank(relayer);
        vm.expectRevert();
        entry.placeBetWithAuthorization(
            player, address(game), uint8(BetType.COLOR), bytes32(uint256(2)), STAKE, a.salt,
            a.validAfter, a.validBefore, a.v, a.r, a.s
        );
    }

    /// @dev An authorisation is safe to broadcast, protected twice over. The recipient is part
    ///      of the signed struct, so redirecting it invalidates the signature; and the token
    ///      additionally refuses anyone but the named payee to submit it.
    function test_authorizationIsUselessToAnyoneElse() public {
        Auth memory a = _sign(BetType.COLOR, bytes32(uint256(2)), STAKE, bytes32("s1"), playerKey);
        bytes32 nonce = entry.betNonce(address(game), uint8(BetType.COLOR), bytes32(uint256(2)), STAKE, a.salt);

        // Redirect to themselves: passes the payee check, fails the signature - `to` is signed.
        vm.prank(attacker);
        vm.expectRevert(FiatTokenMock.InvalidSignature.selector);
        usdc.receiveWithAuthorization(
            player, attacker, STAKE, a.validAfter, a.validBefore, nonce, a.v, a.r, a.s
        );

        // Submit it unaltered: signature is valid, but only the payee may present it.
        vm.prank(attacker);
        vm.expectRevert(FiatTokenMock.CallerMustBePayee.selector);
        usdc.receiveWithAuthorization(
            player, address(entry), STAKE, a.validAfter, a.validBefore, nonce, a.v, a.r, a.s
        );

        assertEq(usdc.balanceOf(player), 1_000e6, "nothing was taken either way");
    }

    // ──────────────────────────────────────────────
    //  Payouts
    // ──────────────────────────────────────────────

    /// @dev The payout address is read from storage, never from the caller, so a hostile
    ///      relayer settling a bet cannot divert the winnings to itself.
    function test_relayerCannotRedirectWinnings() public {
        uint256[3] memory idx;
        for (uint8 band = 0; band < 3; band++) {
            Auth memory a = _sign(BetType.HILO, bytes32(uint256(band)), STAKE, bytes32(uint256(band)), playerKey);
            (, idx[band]) = _relay(BetType.HILO, bytes32(uint256(band)), STAKE, a);
        }
        _draw(uint256(keccak256("redirect")));
        (,, uint16 sum,,,) = game.getDrawResult(1);

        uint256 attackerBefore = usdc.balanceOf(attacker);
        vm.prank(attacker);
        entry.claimFor(address(game), 1, idx[_hiloBandOf(sum)]);

        assertEq(usdc.balanceOf(attacker), attackerBefore, "attacker gains nothing by relaying");
    }

    function test_claimOnUnknownBetReverts() public {
        vm.expectRevert(GaslessEntry.UnknownBet.selector);
        entry.claimFor(address(game), 1, 0);
    }

    function test_losingBetCannotBeClaimed() public {
        uint256 word = uint256(keccak256("lose"));

        // Probe the result, then back a colour that is guaranteed not to win.
        uint256 snap = vm.snapshotState();
        Auth memory probe = _sign(BetType.COLOR, bytes32(uint256(0)), STAKE, bytes32("p"), playerKey);
        _relay(BetType.COLOR, bytes32(uint256(0)), STAKE, probe);
        _draw(word);
        (,,, uint8 dominant,,) = game.getDrawResult(1);
        vm.revertToState(snap);

        uint8 loser = (dominant + 1) % 5;
        Auth memory a = _sign(BetType.COLOR, bytes32(uint256(loser)), STAKE, bytes32("s1"), playerKey);
        (, uint256 idx) = _relay(BetType.COLOR, bytes32(uint256(loser)), STAKE, a);
        _draw(word);

        vm.prank(relayer);
        vm.expectRevert(PredictionGameBase.NotWinner.selector);
        entry.claimFor(address(game), 1, idx);
    }

    function test_getPlayerBetsListsRelayedBets() public {
        Auth memory a1 = _sign(BetType.COLOR, bytes32(uint256(2)), STAKE, bytes32("s1"), playerKey);
        Auth memory a2 = _sign(BetType.HILO, bytes32(uint256(1)), STAKE, bytes32("s2"), playerKey);
        _relay(BetType.COLOR, bytes32(uint256(2)), STAKE, a1);
        _relay(BetType.HILO, bytes32(uint256(1)), STAKE, a2);

        GaslessEntry.BetRef[] memory bets = entry.getPlayerBets(player);
        assertEq(bets.length, 2);
        assertEq(bets[0].drawId, 1);
    }

    // ──────────────────────────────────────────────
    //  One entry contract, several games
    // ──────────────────────────────────────────────

    /// @dev A second, independent game on the same vault, for cross-game tests.
    function _deployGameB() internal returns (ColorColor gameB) {
        vm.startPrank(owner);
        uint256 subB = vrfCoordinator.createSubscription();
        vrfCoordinator.fundSubscription(subB, 1000 ether);
        gameB = new ColorColor(
            address(usdc), address(vrfCoordinator), address(referralManager), address(vault),
            treasury, owner, subB, keccak256("b"), 2_000_000,
            DRAW_INTERVAL, 800, 5_000e6, 5_000
        );
        vrfCoordinator.addConsumer(subB, address(gameB));
        referralManager.setAuthorizedGame(address(gameB), true);
        vault.setAuthorizedGame(address(gameB), true);
        vault.setAllocation(address(game), 5_000);
        vault.setAllocation(address(gameB), 5_000);
        vm.stopPrank();
    }

    /// @dev Market ids are per game: market 3 is COLOR here and FORECAST on a race. A
    ///      signature for one game must never be spendable on another.
    function test_signatureForGameARejectedByGameB() public {
        ColorColor gameB = _deployGameB();
        Auth memory a = _sign(BetType.COLOR, bytes32(uint256(2)), STAKE, bytes32("s1"), playerKey);

        vm.prank(relayer);
        vm.expectRevert(FiatTokenMock.InvalidSignature.selector);
        entry.placeBetWithAuthorization(
            player, address(gameB), uint8(BetType.COLOR), bytes32(uint256(2)), STAKE, a.salt,
            a.validAfter, a.validBefore, a.v, a.r, a.s
        );
        assertEq(gameB.getBetCount(1), 0, "game B took no bet");
        assertEq(usdc.balanceOf(player), 1_000e6, "nothing was taken");

        // The same signature is still good on the game it was made for.
        (uint256 drawId, uint256 betIndex) = _relay(BetType.COLOR, bytes32(uint256(2)), STAKE, a);
        assertEq(entry.betOwner(address(game), drawId, betIndex), player);
        assertEq(game.getBetCount(1), 1);
    }

    function test_nonceCommitsToTheGame() public {
        ColorColor gameB = _deployGameB();
        bytes32 onA = entry.betNonce(address(game), uint8(BetType.COLOR), bytes32(uint256(2)), STAKE, bytes32("s"));
        bytes32 onB = entry.betNonce(address(gameB), uint8(BetType.COLOR), bytes32(uint256(2)), STAKE, bytes32("s"));
        assertTrue(onA != onB);
    }

    function test_betsOnOneGameAreNotClaimableAsAnother() public {
        ColorColor gameB = _deployGameB();
        Auth memory a = _sign(BetType.COLOR, bytes32(uint256(2)), STAKE, bytes32("s1"), playerKey);
        (uint256 drawId, uint256 betIndex) = _relay(BetType.COLOR, bytes32(uint256(2)), STAKE, a);

        assertEq(entry.betOwner(address(gameB), drawId, betIndex), address(0));
        vm.expectRevert(GaslessEntry.UnknownBet.selector);
        entry.claimFor(address(gameB), drawId, betIndex);
    }

    function test_noStandingApprovalToAnyGame() public {
        Auth memory a = _sign(BetType.COLOR, bytes32(uint256(2)), STAKE, bytes32("s1"), playerKey);
        _relay(BetType.COLOR, bytes32(uint256(2)), STAKE, a);
        assertEq(usdc.allowance(address(entry), address(game)), 0);
    }
}
