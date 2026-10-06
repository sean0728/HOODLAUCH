// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The two Chainlink-style aggregator functions V4TaxHook reads for
/// its ETH/USD graduation check. Identical in shape to the V2 IAggregatorV3;
/// kept as a separate V4-prefixed file so the V4 set has no hidden dependency
/// on any V2 file.
interface V4IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
