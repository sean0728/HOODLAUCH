// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The minimal slice of the Uniswap V2 Router interface TokenFactory
/// actually needs. Point this at whatever Uniswap V2-style router Robinhood
/// Chain's DEX exposes — the interface is the de facto standard across V2
/// forks (Uniswap, Sushiswap, Camelot's V2 mode, etc.), so no code change
/// should be needed beyond the deployed address.
interface IUniswapV2Router02 {
    function factory() external pure returns (address);
    function WETH() external pure returns (address);

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    )
        external
        payable
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);

    /// @notice Buy variant that tolerates a fee-on-transfer token on the
    /// output side — required here because LaunchedToken can carry a live
    /// transfer tax. Unlike the plain swapExactETHForTokens, this never
    /// returns a pre-computed amounts array (that array would be wrong for
    /// a taxed token); callers must measure what actually landed via a
    /// before/after balance diff on `to`, same as the router itself does
    /// internally.
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;

    /// @notice Sell variant that tolerates a fee-on-transfer token on the
    /// input side, for the same reason as above.
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;

    /// @notice Token-for-token variant, same fee-on-transfer tolerance as
    /// above. CustomToken uses this to swap collected fee tokens for
    /// whatever ERC20 a creator picked as their reflection asset, routed
    /// through WETH (path = [ourToken, WETH, reflectionAsset]) since a
    /// direct pair against an arbitrary token isn't something this project
    /// can assume exists.
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @notice The one function TokenFactory needs from the paired Uniswap V2
/// Factory contract, to look up the pair address created for a token so its
/// LP tokens can be locked and its tax can be pointed at the right pool.
interface IUniswapV2FactoryMinimal {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}
