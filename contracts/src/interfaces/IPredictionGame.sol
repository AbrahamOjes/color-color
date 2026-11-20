// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The slice of a game that `GaslessEntry` and `AgentMandate` call.
/// @dev `market` is a `uint8`, which is how Solidity encodes ColorColor's `BetType`, so the
///      `placeBet` selector matches ColorColor today and the Phase 1 engine after it.
interface IPredictionGame {
    function MIN_STAKE() external view returns (uint256);

    function currentDrawId() external view returns (uint256);

    function drawPending() external view returns (bool);

    /// @notice Whether a bet placed now would be accepted on timing grounds.
    function bettingOpen() external view returns (bool);

    function placeBet(uint8 market, bytes32 selection, uint256 stake, address referrer)
        external
        returns (uint256 betIndex, uint256 payout);

    function claimPrize(uint256 drawId, uint256 betIndex) external returns (uint256 payout);
}
