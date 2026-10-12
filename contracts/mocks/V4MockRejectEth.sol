// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IV4MockReflections {
    function claimReflections() external returns (uint256);
    function claimReflectionsTo(address to) external returns (uint256);
}

/// @dev Test helper: a holder that cannot receive ETH (a hostile / non-payable contract) but can
/// claim its reflections to another address.
contract V4MockRejectEth {
    receive() external payable {
        revert("no ETH");
    }

    function claim(address token) external returns (uint256) {
        return IV4MockReflections(token).claimReflections();
    }

    function claimTo(address token, address to) external returns (uint256) {
        return IV4MockReflections(token).claimReflectionsTo(to);
    }
}
