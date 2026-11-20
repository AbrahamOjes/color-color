// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Golden results captured from ColorColor.sol at commit 88ede53, before the engine
///         extraction. Bets are the fixed book in ColorColorGolden.t.sol; edge 8%.
///         totalPayout values were cross-checked independently against OddsLib's formula in Python.
library ColorColorGoldenFixture {
    struct Golden {
        uint8[6] numbers;
        uint8[4] colourCount;
        uint16 sum;
        uint8 dominant;
        uint256 totalPayout;
    }

    uint256 internal constant WORD_1 = uint256(keccak256("golden-1"));
    uint256 internal constant WORD_2 = uint256(keccak256("golden-2"));
    uint256 internal constant WORD_3 = uint256(keccak256("golden-3"));

    function golden1() internal pure returns (Golden memory) {
        return Golden([8, 10, 14, 26, 44, 49], [2, 1, 1, 2], 151, 4, 715_642_163);
    }

    function golden2() internal pure returns (Golden memory) {
        return Golden([9, 14, 17, 29, 32, 37], [1, 2, 2, 1], 138, 4, 542_910_513);
    }

    function golden3() internal pure returns (Golden memory) {
        return Golden([7, 36, 38, 40, 42, 45], [1, 0, 1, 4], 208, 3, 470_172_369);
    }
}
