// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IPredictionGame} from "./interfaces/IPredictionGame.sol";

/// @notice The slice of EIP-3009 this needs. Circle's USDC implements it on every chain we
///         target; verified live on Amoy at implementation 0xc8a087ac…8a5e00.
interface IEIP3009 {
    /// @dev Pull-based transfer. The token itself requires `msg.sender == to`, so an
    ///      authorisation made out to this contract can only ever be spent by this contract.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title GaslessEntry
/// @notice Lets a player bet holding nothing but USDC.
///
/// The player signs one EIP-3009 authorisation off-chain — free, no wallet gas, no native
/// token. Anyone (normally the house's relayer) submits it and pays the POL. The house
/// recovers that cost from the rake it already charges.
///
/// This matters more than it sounds: a player can go from a fiat on-ramp
/// purchase straight to placing a bet without ever learning what POL is, acquiring it, or
/// bridging it. Needing a second token purely to touch your first one is the single largest
/// drop-off in onchain betting onboarding.
///
/// ## One signature, not two
///
/// The bet parameters have to be authenticated, or a hostile relayer could take the player's
/// USDC and place a different bet with it. Rather than demand a second signature, the bet is
/// committed **inside the authorisation nonce**, as an EIP-712 digest under this contract's
/// own domain:
///
///     nonce = hashTypedData(BetIntent(game, market, selection, stake, salt))
///
/// EIP-3009 nonces are arbitrary caller-chosen bytes32, so this costs nothing. The contract
/// recomputes the nonce from the parameters it was handed and passes that to the token. Alter
/// any parameter and the recomputed nonce changes, so the signature no longer verifies and the
/// token rejects it. The player's signature therefore covers the transfer *and* the bet, and
/// `salt` keeps repeat bets on the same selection distinct.
///
/// ## Why the game is in the signed struct
///
/// One entry contract serves every game, and market ids are only meaningful per game: market
/// 3 is COLOR on ColorColor and FORECAST on a race. Without `game` in the struct, a signature
/// for a low-risk bet on one game could be relayed as a high-variance bet on another.
///
/// ## Why the bets are held here
///
/// A game records `msg.sender` as the bet owner, so a relayer-submitted bet would belong
/// to the relayer. This contract places the bet, remembers who it was really for, and pays any
/// winnings straight out to that player. It never holds a player balance between actions —
/// stake goes in, payout goes out.
contract GaslessEntry is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant BET_INTENT_TYPEHASH = keccak256(
        "BetIntent(address game,uint8 market,bytes32 selection,uint256 stake,bytes32 salt)"
    );

    IERC20 public immutable usdc;

    struct BetRef {
        address game;
        uint256 drawId;
        uint256 betIndex;
    }

    /// @notice Who a relayed bet really belongs to. game => drawId => betIndex => player.
    mapping(address => mapping(uint256 => mapping(uint256 => address))) public betOwner;

    /// @notice Every relayed bet per player, so a UI can list and settle them.
    mapping(address => BetRef[]) internal playerBets;

    event GaslessBetPlaced(
        address indexed player,
        address indexed game,
        uint256 indexed drawId,
        uint256 betIndex,
        uint8 market,
        uint256 stake,
        uint256 potentialPayout,
        address relayer
    );
    event GaslessPrizeClaimed(
        address indexed player, address indexed game, uint256 indexed drawId, uint256 betIndex, uint256 payout
    );

    error ZeroAddress();
    error UnknownBet();

    constructor(address _usdc) EIP712("GaslessEntry", "1") {
        if (_usdc == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
    }

    /// @notice The nonce a player must sign for a given bet. Exposed so the client signs
    ///         exactly what this contract will recompute — never derive it separately.
    function betNonce(address game, uint8 market, bytes32 selection, uint256 stake, bytes32 salt)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(BET_INTENT_TYPEHASH, game, market, selection, stake, salt))
        );
    }

    /// @notice Place a bet paid for by a player's off-chain signature.
    /// @dev Permissionless. The authorisation names this contract as recipient, so it is safe
    ///      to broadcast — anyone may relay it, and the funds can only reach this contract and
    ///      then the game. If the house relayer stalls, the player is not stranded.
    function placeBetWithAuthorization(
        address player,
        address game,
        uint8 market,
        bytes32 selection,
        uint256 stake,
        bytes32 salt,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 drawId, uint256 betIndex, uint256 payout) {
        // Recomputed, never taken from the caller: this is what binds the signature to the bet.
        bytes32 nonce = betNonce(game, market, selection, stake, salt);

        IEIP3009(address(usdc)).receiveWithAuthorization(
            player, address(this), stake, validAfter, validBefore, nonce, v, r, s
        );

        // Exactly this stake, for exactly the game the player signed for. No standing
        // approval, so a game can never pull more than the bet it was handed.
        usdc.forceApprove(game, stake);
        drawId = IPredictionGame(game).currentDrawId();
        (betIndex, payout) = IPredictionGame(game).placeBet(market, selection, stake, address(0));
        usdc.forceApprove(game, 0);

        betOwner[game][drawId][betIndex] = player;
        playerBets[player].push(BetRef({game: game, drawId: drawId, betIndex: betIndex}));

        emit GaslessBetPlaced(player, game, drawId, betIndex, market, stake, payout, msg.sender);
    }

    /// @notice Claim a relayed winning bet. Pays the player directly.
    /// @dev Permissionless so the house relayer can settle winnings without the player ever
    ///      needing gas — the whole point. The payout address comes from storage, not the
    ///      caller, so a relayer cannot redirect it. The amount paid is what actually arrived,
    ///      not what the game says it sent, so a game cannot make this contract pay out more
    ///      than it received.
    function claimFor(address game, uint256 drawId, uint256 betIndex)
        external
        nonReentrant
        returns (uint256 payout)
    {
        address player = betOwner[game][drawId][betIndex];
        if (player == address(0)) revert UnknownBet();

        uint256 before = usdc.balanceOf(address(this));
        IPredictionGame(game).claimPrize(drawId, betIndex);
        payout = usdc.balanceOf(address(this)) - before;
        usdc.safeTransfer(player, payout);

        emit GaslessPrizeClaimed(player, game, drawId, betIndex, payout);
    }

    // ──────────────────────────────────────────────
    //  Views
    // ──────────────────────────────────────────────

    function getPlayerBets(address player) external view returns (BetRef[] memory) {
        return playerBets[player];
    }

    function playerBetCount(address player) external view returns (uint256) {
        return playerBets[player].length;
    }
}
