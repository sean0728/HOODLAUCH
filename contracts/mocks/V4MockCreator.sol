// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IV4CurveLaunch {
    function createCurveToken(string calldata, string calldata, uint256, uint256, uint256, uint256)
        external
        payable
        returns (address, uint256);
}

/// @notice Test-only: a smart-contract token creator whose ETH receive hook can
/// be switched to accept (0), reject (1) or burn all gas (2). Used by the
/// V4PoolLauncher audit tests.
contract V4MockCreator {
    uint256 public mode;

    function setMode(uint256 m) external {
        mode = m;
    }

    function launch(address factory, string calldata n, string calldata s, uint256 supply, uint256 salt)
        external
        payable
        returns (address t)
    {
        (t,) = IV4CurveLaunch(factory).createCurveToken{value: msg.value}(n, s, supply, 0, 0, salt);
    }

    receive() external payable {
        if (mode == 1) revert("no ETH");
        if (mode == 2) {
            for (;;) {}
        }
    }
}
