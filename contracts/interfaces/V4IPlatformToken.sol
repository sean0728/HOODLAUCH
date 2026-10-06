// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The slice of PlatformToken the V4 distributors use: ERC20, burn(),
/// and the enumerable holder registry (with its generation stamps). V4 copy of
/// IPlatformToken so the V4 set has no hidden V2 dependency.
interface V4IPlatformToken is IERC20 {
    function burn(uint256 amount) external;
    function holderCount() external view returns (uint256);
    function holderAt(uint256 index) external view returns (address);
    function holderGenerationCounter() external view returns (uint256);
    function holderGeneration(address account) external view returns (uint256);
}
