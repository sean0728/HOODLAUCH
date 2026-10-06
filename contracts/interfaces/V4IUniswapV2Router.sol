// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The three Uniswap V2 router functions the V4 distributors use, and
/// only for the platform token's own (V2) pool: buying it with ETH.
interface V4IUniswapV2Router {
    function WETH() external view returns (address);

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;
}
