// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test helper: a marketing wallet that accepts ETH and answers with a huge return payload
/// (a "return bomb"), to measure what copying that reply costs the contract that paid it.
contract V4MockReturnBomb {
    uint256 public size = 200_000;

    function setSize(uint256 s) external {
        size = s;
    }

    receive() external payable {
        uint256 s = size;
        assembly {
            return(0, s)
        }
    }
}
