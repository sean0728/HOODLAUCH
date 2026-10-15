// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The slice of PlatformToken the V4 distributors use: ERC20, burn(), the append-only holder
/// registry, and balance snapshots (snapshot() is open only to addresses the token's owner has authorised).
interface V4IPlatformToken is IERC20 {
    function burn(uint256 amount) external;
    function holderCount() external view returns (uint256);
    function holderAt(uint256 index) external view returns (address);
    function holderGenerationCounter() external view returns (uint256);
    function holderGeneration(address account) external view returns (uint256);
    function snapshot() external returns (uint256);
    function isSnapshotter(address account) external view returns (bool);
    function balanceOfAt(address account, uint256 id) external view returns (uint256);
    function totalSupplyAt(uint256 id) external view returns (uint256);
}
