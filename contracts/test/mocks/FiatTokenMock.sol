// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Stand-in for Circle's USDC (FiatTokenV2) with the EIP-3009 surface this project
///         relies on. Mirrors the real typehash and the `msg.sender == to` rule on
///         `receiveWithAuthorization`, so tests exercise the same signature path production
///         will — a mock that skipped that check would hide the front-running protection it
///         provides.
contract FiatTokenMock is ERC20 {
    // keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;

    bytes32 private immutable _domainSeparator;
    uint8 private immutable _decimals;

    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    error AuthorizationUsed();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error InvalidSignature();
    error CallerMustBePayee();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
        _domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name_)),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparator;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice EIP-3009 pull transfer. Only the named payee may submit it, which is what stops
    ///         a third party from front-running a broadcast authorisation.
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
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[from][nonce]) revert AuthorizationUsed();

        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
        if (ECDSA.recover(digest, v, r, s) != from) revert InvalidSignature();

        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }

    /// @notice Digest a client must sign. Exposed so tests sign exactly what the token checks.
    function receiveDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) external view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
    }
}
