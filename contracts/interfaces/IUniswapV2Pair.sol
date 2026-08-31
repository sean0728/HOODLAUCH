// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The minimal slice of a real Uniswap V2 pair contract that
/// LaunchedToken needs to read its own live pool reserves for the market
/// cap check that decides when its transfer tax permanently disables.
/// Matches the real interface exactly, so a real pair address drops in
/// without any code change here.
interface IUniswapV2PairMinimal {
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
}
