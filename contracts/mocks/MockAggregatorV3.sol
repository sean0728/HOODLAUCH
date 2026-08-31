// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IAggregatorV3.sol";

/// @dev Test-only stand-in for a Chainlink price feed. Lets tests set a
/// fixed ETH/USD price (and, for staleness tests, a fixed updatedAt) rather
/// than depending on a real oracle.
contract MockAggregatorV3 is IAggregatorV3 {
    uint8 private immutable _decimals;
    int256 private _answer;
    uint256 private _updatedAt;

    constructor(uint8 decimals_, int256 initialAnswer) {
        _decimals = decimals_;
        _answer = initialAnswer;
        _updatedAt = block.timestamp;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function setAnswer(int256 newAnswer) external {
        _answer = newAnswer;
        _updatedAt = block.timestamp;
    }

    function setStale(uint256 updatedAt_) external {
        _updatedAt = updatedAt_;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return (1, _answer, _updatedAt, _updatedAt, 1);
    }
}
