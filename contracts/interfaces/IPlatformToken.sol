// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice The minimal slice of PlatformToken that PlatformRewardsDistributor
/// actually needs: the standard ERC20 surface, plus burn() (from
/// ERC20Burnable), the enumerable holder registry (holderCount()/
/// holderAt()), and the per-holder generation stamps (holderGeneration()/
/// holderGenerationCounter()) PlatformToken adds on top. Declared as its
/// own interface, rather than importing the concrete PlatformToken
/// contract, so the distributor only ever depends on this exact shape —
/// including in tests, where a much simpler mock can stand in for it.
interface IPlatformToken is IERC20 {
    function burn(uint256 amount) external;
    function holderCount() external view returns (uint256);
    function holderAt(uint256 index) external view returns (address);
    /// @notice The generation `holder` was most recently (re-)added to the
    /// registry under — see PlatformToken.holderGeneration's own comment.
    /// 0 means the address has never been a holder.
    function holderGeneration(address holder) external view returns (uint256);
    /// @notice The current, live value of PlatformToken's own monotonically
    /// increasing holder-registry-entry counter — see
    /// PlatformToken.holderGenerationCounter's own comment.
    function holderGenerationCounter() external view returns (uint256);
}
