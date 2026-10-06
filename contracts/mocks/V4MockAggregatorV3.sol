// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only price feed for the V4 suite.
contract V4MockAggregatorV3 {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;
    bool public reverts;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function set(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 t) external { updatedAt = t; }
    function setReverts(bool r) external { reverts = r; }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!reverts, "feed down");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
