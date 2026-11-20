// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ColorColorGame as ColorColor} from "../src/ColorColorGame.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {ReferralManager} from "../src/ReferralManager.sol";
import {OddsLib, BetType} from "../src/OddsLib.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
import {ColorColorGoldenFixture as G} from "./fixtures/ColorColorGoldenFixture.sol";

/// @notice Pins what ColorColor produces for fixed VRF words and a fixed bet book. Captured
///         from the pre-extraction contract; the engine refactor must reproduce it exactly.
contract ColorColorGoldenTest is Test {
    ColorColor game;
    HouseVault vault;
    ReferralManager referralManager;
    ERC20Mock usdc;
    VRFCoordinatorV2_5Mock vrfCoordinator;

    address owner = address(1);
    address treasury = address(2);
    address lp = address(3);
    address alice = address(4);

    uint256 subId;
    uint256 constant DRAW_INTERVAL = 180;

    struct B {
        BetType t;
        uint256 sel;
        uint256 stake;
    }

    function setUp() public {
        vm.startPrank(owner);
        usdc = new ERC20Mock("USDC", "USDC", 6);
        vrfCoordinator = new VRFCoordinatorV2_5Mock(1e17, 1e9, 4e15);
        subId = vrfCoordinator.createSubscription();
        vrfCoordinator.fundSubscription(subId, 1000 ether);
        referralManager = new ReferralManager(address(usdc), treasury, owner);
        vault = new HouseVault(address(usdc), owner);
        game = new ColorColor(
            address(usdc), address(vrfCoordinator), address(referralManager), address(vault), treasury, owner,
            subId, keccak256("test"), 2_000_000, DRAW_INTERVAL, 800, 5_000e6, 5_000
        );
        vrfCoordinator.addConsumer(subId, address(game));
        referralManager.setAuthorizedGame(address(game), true);
        vault.setAuthorizedGame(address(game), true);
        vault.setAllocation(address(game), 10_000);
        vm.stopPrank();

        usdc.mint(lp, 100_000e6);
        vm.startPrank(lp);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e6);
        vm.stopPrank();

        usdc.mint(alice, 100_000e6);
        vm.prank(alice);
        usdc.approve(address(game), type(uint256).max);
    }

    /// @dev Every bet type, with selections that win on at least one golden word. PICK2/PICK3
    ///      selections are given out of order on purpose, to pin canonicalisation too.
    function _book() internal pure returns (B[30] memory b) {
        uint256 i;
        // PICK1
        b[i++] = B(BetType.PICK1, 1, 1e6);
        b[i++] = B(BetType.PICK1, 7, 1e6);
        b[i++] = B(BetType.PICK1, 8, 1e6);
        b[i++] = B(BetType.PICK1, 14, 1e6);
        b[i++] = B(BetType.PICK1, 37, 1e6);
        b[i++] = B(BetType.PICK1, 49, 1e6);
        // PICK2
        b[i++] = B(BetType.PICK2, (49 << 8) | 8, 1e6);
        b[i++] = B(BetType.PICK2, (14 << 8) | 17, 1e6);
        b[i++] = B(BetType.PICK2, (45 << 8) | 40, 1e6);
        b[i++] = B(BetType.PICK2, (3 << 8) | 5, 1e6);
        // PICK3
        b[i++] = B(BetType.PICK3, (14 << 16) | (8 << 8) | 10, 5e5);
        b[i++] = B(BetType.PICK3, (37 << 16) | (29 << 8) | 32, 5e5);
        b[i++] = B(BetType.PICK3, (1 << 16) | (2 << 8) | 3, 5e5);
        // COLOR
        b[i++] = B(BetType.COLOR, 0, 2e6);
        b[i++] = B(BetType.COLOR, 1, 2e6);
        b[i++] = B(BetType.COLOR, 2, 2e6);
        b[i++] = B(BetType.COLOR, 3, 2e6);
        b[i++] = B(BetType.COLOR, 4, 2e6);
        // HILO
        b[i++] = B(BetType.HILO, 0, 2e6);
        b[i++] = B(BetType.HILO, 1, 2e6);
        b[i++] = B(BetType.HILO, 2, 2e6);
        // RAINBOW
        b[i++] = B(BetType.RAINBOW, 2112, 1e6);
        b[i++] = B(BetType.RAINBOW, 1221, 1e6);
        b[i++] = B(BetType.RAINBOW, 1014, 1e6);
        b[i++] = B(BetType.RAINBOW, 1113, 1e6);
        // A second stake on already-backed selections, so buckets hold more than one bet.
        b[i++] = B(BetType.PICK1, 8, 3e6);
        b[i++] = B(BetType.PICK2, (8 << 8) | 49, 2e6);
        b[i++] = B(BetType.COLOR, 4, 1e6);
        b[i++] = B(BetType.HILO, 1, 1e6);
        b[i++] = B(BetType.RAINBOW, 1014, 2e6);
    }

    function _placeBook() internal {
        B[30] memory b = _book();
        for (uint256 i = 0; i < b.length; i++) {
            vm.prank(alice);
            game.placeBet(uint8(b[i].t), bytes32(b[i].sel), b[i].stake, address(0));
        }
    }

    function _draw(uint256 word) internal returns (uint256 drawId, uint256 gasUsed) {
        drawId = game.currentDrawId();
        skip(DRAW_INTERVAL + 1);
        game.performUpkeep("");
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        uint256 before = gasleft();
        vrfCoordinator.fulfillRandomWordsWithOverride(1, address(game), words);
        gasUsed = before - gasleft();
    }

    function _check(uint256 word, G.Golden memory g) internal {
        _placeBook();
        (uint256 drawId, uint256 gasUsed) = _draw(word);
        console.log("settlement gas (incl. coordinator mock)", gasUsed);

        (uint8[6] memory numbers, uint8[4] memory colourCount, uint16 sum, uint8 dominant, uint256 totalPayout, bool settled) =
            game.getDrawResult(drawId);

        assertTrue(settled, "settled");
        for (uint256 i = 0; i < 6; i++) assertEq(numbers[i], g.numbers[i], "numbers");
        for (uint256 i = 0; i < 4; i++) assertEq(colourCount[i], g.colourCount[i], "colourCount");
        assertEq(sum, g.sum, "sum");
        assertEq(dominant, g.dominant, "dominant");
        assertEq(totalPayout, g.totalPayout, "totalPayout");

        // Bucket settlement and per-bet claims must agree to the unit.
        uint256 claimed;
        uint256 n = game.getBetCount(drawId);
        for (uint256 i = 0; i < n; i++) {
            if (!game.isBetWinner(drawId, i)) continue;
            vm.prank(alice);
            claimed += game.claimPrize(drawId, i);
        }
        assertEq(claimed, g.totalPayout, "claims == totalPayout");
        assertEq(game.unclaimedLiability(), 0, "everything claimed");
    }

    function test_golden1() public {
        _check(G.WORD_1, G.golden1());
    }

    function test_golden2() public {
        _check(G.WORD_2, G.golden2());
    }

    function test_golden3() public {
        _check(G.WORD_3, G.golden3());
    }

    /// @dev Gas for a representative bet of each type into a fresh draw, logged so engine
    ///      changes can be compared before and after.
    function test_gasPlaceBet() public {
        B[30] memory b = _book();
        for (uint256 i = 0; i < b.length; i++) {
            vm.prank(alice);
            uint256 before = gasleft();
            game.placeBet(uint8(b[i].t), bytes32(b[i].sel), b[i].stake, address(0));
            if (i == 0 || i == 6 || i == 10 || i == 13 || i == 18 || i == 21 || i == 29) {
                console.log("placeBet gas, book index", i, before - gasleft());
            }
        }
    }

    /// @dev Prints the values for the fixture. Only used when (re)capturing.
    function test_captureLog() public {
        uint256[3] memory words = [G.WORD_1, G.WORD_2, G.WORD_3];
        for (uint256 w = 0; w < 3; w++) {
            uint256 snap = vm.snapshotState();
            _placeBook();
            (uint256 drawId,) = _draw(words[w]);
            (uint8[6] memory nums, uint8[4] memory cc, uint16 sum, uint8 dom, uint256 total,) = game.getDrawResult(drawId);
            console.log("word", w + 1);
            console.log(nums[0], nums[1], nums[2]);
            console.log(nums[3], nums[4], nums[5]);
            console.log(cc[0], cc[1], cc[2]);
            console.log(cc[3], sum, dom);
            console.log("total", total);
            vm.revertToState(snap);
        }
    }
}
