// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A minimal contract that reverts on receiving plain ETH -- used to
/// simulate a misbehaving feeTreasury/rewardsDistributor for
/// BondingCurveFactory's fee-distribution isolation tests. See
/// AUDIT-BondingCurveFactory.md Finding 1: before the fix, a fee recipient
/// like this one could block every buy()/sell()/createCurveToken() call --
/// most seriously sell(), trapping every holder's ability to exit.
contract RevertingReceiver {
    receive() external payable {
        revert("RevertingReceiver: nope");
    }
}
