// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IUniswapV2Router02.sol";

/// @notice The minimal slice of TokenFactory's/CustomTokenFactory's own
/// public tax-default getters that a "deploy only" LaunchedToken/
/// CustomToken needs when it automatically detects, on an ordinary
/// transfer, that a real DEX pool now exists for it — see
/// LaunchedToken._maybeAutoActivateTax and
/// CustomToken._maybeAutoConfigurePlatformTax. TokenFactory and
/// CustomTokenFactory expose an identical set of tax-default getters
/// (same names, same types — confirmed field-by-field against both
/// contracts), so this one interface serves both call sites: router() is
/// only ever called through it from LaunchedToken (CustomToken already
/// has its own `router` state variable and never needs this factory's).
/// Every function here is already a plain public state-variable getter on
/// both factories today — neither factory needed any code change to
/// support this.
interface ITokenFactoryTaxDefaults {
    function router() external view returns (IUniswapV2Router02);
    function feeBps() external view returns (uint256);
    function platformFeeWallet() external view returns (address);
    function priceFeed() external view returns (address);
    function graduationTargetUsd() external view returns (uint256);
    function maxOracleStaleness() external view returns (uint256);
    function rewardsDistributor() external view returns (address);
    function rewardBps() external view returns (uint256);
    function creatorRewardsDistributor() external view returns (address);
    function creatorRewardBps() external view returns (uint256);
    function feeWalletDistributor() external view returns (address);
}
