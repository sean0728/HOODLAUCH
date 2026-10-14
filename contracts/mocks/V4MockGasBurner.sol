// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test helper: a fee recipient that accepts ETH but burns a lot of gas doing so
/// (many storage writes), to show what an uncapped fee call costs.
contract V4MockGasBurner {
    uint256 public sink;
    uint256 public rounds = 150;

    function setRounds(uint256 r) external {
        rounds = r;
    }

    receive() external payable {
        for (uint256 i = 0; i < rounds; i++) {
            sink = sink + i + 1;
            // distinct slots so every write is a fresh 20,000-gas store
            assembly { sstore(add(0x1000, i), add(i, 1)) }
        }
    }
}
