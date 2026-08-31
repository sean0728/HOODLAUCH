// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./MockLPToken.sol";

/// @dev Test-only stand-in for a Uniswap V2 style router + factory. It
/// implements just enough of addLiquidityETH/factory/WETH/getPair and the
/// FeeOnTransfer-supporting swap variants for TokenFactory's tests to
/// exercise the real createToken() code path end-to-end, including a live
/// transfer tax, without deploying an actual DEX.
///
/// THIS IS NOT PRODUCTION DEX LOGIC. Before deploying TokenFactory for
/// real, replace the router address with Robinhood Chain's actual
/// Uniswap V2-compatible router — nothing in TokenFactory itself needs to
/// change, since it only depends on the interface in
/// interfaces/IUniswapV2Router02.sol.
contract MockRouter {
    address private immutable _weth;
    mapping(address => address) public pairs; // launched token => mock pair (also the LP token)

    constructor(address weth_) {
        _weth = weth_;
    }

    // Holds ETH only momentarily, mid-multi-hop, in
    // swapExactTokensForTokensSupportingFeeOnTransferTokens below.
    receive() external payable {}

    function factory() external view returns (address) {
        return address(this);
    }

    function WETH() external view returns (address) {
        return _weth;
    }

    function getPair(address token, address /* pairedWith */) external view returns (address) {
        return pairs[token];
    }

    /// @dev Creates the pair on first use (mirroring how a real router's
    /// addLiquidityETH auto-creates a missing pair via the factory), pulls
    /// the token straight into the pair, and forwards the ETH into the pair
    /// too — both sides land in the contract that will act as the pool's
    /// reserves from here on, rather than sitting in the router itself.
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 /* amountTokenMin */,
        uint256 /* amountETHMin */,
        address to,
        uint256 /* deadline */
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        require(msg.value > 0 && amountTokenDesired > 0, "MockRouter: zero amounts");

        address pair = pairs[token];
        if (pair == address(0)) {
            pair = address(new MockLPToken(token, _weth));
            pairs[token] = pair;
        }

        bool pulled = IERC20(token).transferFrom(msg.sender, pair, amountTokenDesired);
        require(pulled, "MockRouter: transferFrom failed");
        (bool sentEth, ) = pair.call{value: msg.value}("");
        require(sentEth, "MockRouter: ETH forward failed");

        // Arbitrary mock LP accounting — real Uniswap V2 uses
        // sqrt(amount0 * amount1) minus a minimum liquidity burn. The exact
        // formula doesn't matter for these tests, only that liquidity > 0
        // and scales with the amounts provided.
        liquidity = amountTokenDesired + msg.value;
        MockLPToken(payable(pair)).mint(to, liquidity);

        return (amountTokenDesired, msg.value, liquidity);
    }

    /// @dev Constant-product buy against the pair's own live reserves.
    /// Computes the gross output from pre-trade reserves, forwards the ETH
    /// in, then asks the pair to send the gross amount to `to` — if the
    /// token has an active transfer tax, LaunchedToken's own _update netss
    /// that down during this exact transfer, so what `to` actually receives
    /// can be less than grossOut. This function checks the real balance
    /// diff against amountOutMin rather than trusting grossOut, exactly
    /// like a real router's "SupportingFeeOnTransferTokens" variant must.
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external payable {
        require(msg.value > 0, "MockRouter: no ETH sent");
        require(path.length == 2, "MockRouter: path must be [WETH, token]");
        require(path[0] == _weth, "MockRouter: path must start with WETH");

        address token = path[1];
        address pair = pairs[token];
        require(pair != address(0), "MockRouter: no pair for token");

        (uint256 tokenReserve, uint256 ethReserve) = _reservesFor(pair, token);
        require(tokenReserve > 0 && ethReserve > 0, "MockRouter: no liquidity for token");

        uint256 grossOut = (tokenReserve * msg.value) / (ethReserve + msg.value);

        (bool sentEth, ) = pair.call{value: msg.value}("");
        require(sentEth, "MockRouter: ETH forward failed");

        uint256 balBefore = IERC20(token).balanceOf(to);
        MockLPToken(payable(pair)).withdrawToken(to, grossOut);
        uint256 received = IERC20(token).balanceOf(to) - balBefore;
        require(received >= amountOutMin, "MockRouter: insufficient output amount");
    }

    /// @dev Constant-product sell against the pair's own live reserves.
    /// Pulls amountIn from the seller into the pair first, then measures
    /// what the pair actually received (a taxed token's transfer nets that
    /// down too — from=seller, to=pair is a taxed leg exactly like a real
    /// sell), and computes ethOut from that real amount, not the requested
    /// amountIn.
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external {
        require(path.length == 2, "MockRouter: path must be [token, WETH]");
        require(path[1] == _weth, "MockRouter: path must end with WETH");

        address token = path[0];
        address pair = pairs[token];
        require(pair != address(0), "MockRouter: no pair for token");

        (uint256 tokenReserveBefore, uint256 ethReserveBefore) = _reservesFor(pair, token);

        uint256 pairBalBefore = IERC20(token).balanceOf(pair);
        bool pulled = IERC20(token).transferFrom(msg.sender, pair, amountIn);
        require(pulled, "MockRouter: transferFrom failed");
        uint256 tokenIn = IERC20(token).balanceOf(pair) - pairBalBefore;

        uint256 ethOut = (ethReserveBefore * tokenIn) / (tokenReserveBefore + tokenIn);
        require(ethOut >= amountOutMin, "MockRouter: insufficient output amount");

        MockLPToken(payable(pair)).withdrawEth(payable(to), ethOut);
    }

    /// @dev CustomToken's only use for a 3-address path: [ourToken, WETH,
    /// reflectionAsset], to swap collected fee-tokens for whatever ERC20 a
    /// creator picked for reflections. Implemented as two hops through the
    /// same per-token/WETH pairs the rest of this mock already uses —
    /// tokenIn -> ETH (same math as the sell function above), then
    /// ETH -> tokenOut (same math as the buy function above) — rather than
    /// modeling a real router's internal WETH deposit/withdraw dance,
    /// which doesn't matter for what these tests need to prove.
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external {
        require(path.length == 3, "MockRouter: path must be [tokenIn, WETH, tokenOut]");
        require(path[1] == _weth, "MockRouter: middle hop must be WETH");

        address tokenIn = path[0];
        address tokenOut = path[2];
        address pairIn = pairs[tokenIn];
        require(pairIn != address(0), "MockRouter: no pair for input token");
        address pairOut = pairs[tokenOut];
        require(pairOut != address(0), "MockRouter: no pair for output token");

        // Hop 1: tokenIn -> ETH, held by this router only for the duration
        // of this call.
        (uint256 tokenReserveIn, uint256 ethReserveIn) = _reservesFor(pairIn, tokenIn);
        uint256 pairInBalBefore = IERC20(tokenIn).balanceOf(pairIn);
        bool pulled = IERC20(tokenIn).transferFrom(msg.sender, pairIn, amountIn);
        require(pulled, "MockRouter: transferFrom failed");
        uint256 actualIn = IERC20(tokenIn).balanceOf(pairIn) - pairInBalBefore;
        uint256 ethOut = (ethReserveIn * actualIn) / (tokenReserveIn + actualIn);
        MockLPToken(payable(pairIn)).withdrawEth(payable(address(this)), ethOut);

        // Hop 2: ETH -> tokenOut, sent to `to`.
        (uint256 tokenReserveOut, uint256 ethReserveOut) = _reservesFor(pairOut, tokenOut);
        uint256 grossOut = (tokenReserveOut * ethOut) / (ethReserveOut + ethOut);
        (bool sentEth, ) = pairOut.call{value: ethOut}("");
        require(sentEth, "MockRouter: ETH forward failed");
        uint256 balBefore = IERC20(tokenOut).balanceOf(to);
        MockLPToken(payable(pairOut)).withdrawToken(to, grossOut);
        uint256 received = IERC20(tokenOut).balanceOf(to) - balBefore;
        require(received >= amountOutMin, "MockRouter: insufficient output amount");
    }

    function _reservesFor(address pair, address token) private view returns (uint256 tokenReserve, uint256 ethReserve) {
        (uint112 reserve0, uint112 reserve1, ) = MockLPToken(payable(pair)).getReserves();
        address token0 = MockLPToken(payable(pair)).token0();
        if (token0 == token) {
            tokenReserve = reserve0;
            ethReserve = reserve1;
        } else {
            tokenReserve = reserve1;
            ethReserve = reserve0;
        }
    }
}
