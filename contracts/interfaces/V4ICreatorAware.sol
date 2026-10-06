// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A launched token that knows its creator (V4LaunchedToken.creator()).
interface V4ICreatorAware {
    function creator() external view returns (address);
}
