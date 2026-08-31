// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The slice of Chainlink's AggregatorV3Interface BondingCurve
/// actually needs. Matches the real interface exactly, so a real Chainlink
/// ETH/USD feed address can be dropped in directly — e.g. on most EVM
/// chains a feed like this is called "ETH / USD". Robinhood Chain being a
/// very new network, confirm a feed actually exists there (or that a
/// third-party oracle provider supports it) before relying on this in
/// production; there is no guarantee one does yet.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
