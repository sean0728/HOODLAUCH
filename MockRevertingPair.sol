// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal stand-in for a pair contract whose getReserves()/token0()
/// always revert — used to verify that a misbehaving (or simply broken)
/// pair can't brick a taxed token's transfers. See
/// LaunchedToken._computeMarketCapFromPair / CustomToken's identical
/// twin, and the try/catch wrapping each of them.
contract MockRevertingPair {
    function getReserves() external pure returns (uint112, uint112, uint32) {
        revert("MockRevertingPair: always reverts");
    }

    function token0() external pure returns (address) {
        revert("MockRevertingPair: always reverts");
    }
}
