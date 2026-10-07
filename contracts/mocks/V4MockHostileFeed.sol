// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only: a "price feed" that misbehaves in the ways a
/// misconfigured or hostile aggregator can. Used by the V4TaxHook audit tests.
/// modes: 0 healthy (8 decimals, $2000)  1 empty return (permissive fallback)
///        2 decimals() = 255             3 burns all gas
///        4 short return data            5 decimals() returns 256 (dirty uint8)
///        6 returns ~10 KB of data (returndata bomb)
contract V4MockHostileFeed {
    uint256 public mode;

    function setMode(uint256 m) external {
        mode = m;
    }

    function decimals() external view returns (uint256) {
        uint256 m = mode;
        if (m == 1) {
            assembly { return(0, 0) }
        }
        if (m == 2) return 255;
        if (m == 3) {
            for (;;) {}
        }
        if (m == 4) {
            assembly { mstore(0, 8) return(0, 10) }
        }
        if (m == 5) return 256;
        if (m == 6) {
            assembly { mstore(0, 8) return(0, 10000) }
        }
        return 8;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 m = mode;
        if (m == 1) {
            assembly { return(0, 0) }
        }
        if (m == 3) {
            for (;;) {}
        }
        if (m == 4) {
            assembly { mstore(0, 1) return(0, 100) }
        }
        if (m == 6) {
            assembly { mstore(0, 1) mstore(32, 200000000000) mstore(64, timestamp()) mstore(96, timestamp()) mstore(128, 1) return(0, 10000) }
        }
        return (1, 2000e8, block.timestamp, block.timestamp, 1);
    }
}
