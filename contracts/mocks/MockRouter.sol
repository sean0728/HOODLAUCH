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

    /// @notice Scales every swap function's actual payout by this many bps
    /// before comparing it against the caller's amountOutMin — 10_000
    /// (100%, a pure no-op) by default, so every test in this repo that
    /// never touches this knob sees exactly the same honest fills as
    /// before. Test-only lever for CustomToken's processingSlippageBps
    /// coverage: dialing this below 10_000 simulates a router that
    /// shortchanges a swap relative to what its own reserves imply (a
    /// misbehaving router, or a multi-hop quote that drifted), so tests
    /// can confirm the resulting amountOutMin actually trips — and that
    /// tripping it degrades safely (see CustomToken._swapAndProcess's
    /// try/catch isolation) instead of reverting the whole transfer.
    uint256 public payoutBps = 10_000;

    constructor(address weth_) {
        _weth = weth_;
    }

    function setPayoutBps(uint256 newBps) external {
        payoutBps = newBps;
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

    /// @notice Permissionless, zero-liquidity pair creation -- mirrors real
    /// Uniswap V2Factory.createPair(tokenA, tokenB) exactly: callable by
    /// anyone, needs no token balance and adds no liquidity. addLiquidityETH
    /// below already creates a pair on first use if one doesn't exist yet;
    /// this exposes that same creation path standalone, for a caller who
    /// wants a pair to exist BEFORE any liquidity is ever added to it.
    ///
    /// Added specifically so CustomBondingCurveFactory.test.js can exercise
    /// AUDIT-CustomBondingCurveFactory.md's Finding 1 regression test end to
    /// end (an "attacker" pre-creating a pair for a curve token before the
    /// factory's own graduation ever runs) -- a pure addition, everything
    /// else in this mock is unchanged.
    function createPair(address token) external returns (address pair) {
        pair = pairs[token];
        if (pair == address(0)) {
            pair = address(new MockLPToken(token, _weth));
            pairs[token] = pair;
        }
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
        grossOut = (grossOut * payoutBps) / 10_000;

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
        ethOut = (ethOut * payoutBps) / 10_000;
        require(ethOut >= amountOutMin, "MockRouter: insufficient output amount");

        MockLPToken(payable(pair)).withdrawEth(payable(to), ethOut);
    }

    /// @dev Hop 1 of swapExactTokensForTokensSupportingFeeOnTransferTokens
    /// below, extracted purely to keep that function's own live-variable
    /// count low enough for solc's viaIR/Yul stack allocator -- the combined
    /// two-hop function had enough locals across both legs (tokenIn,
    /// tokenOut, pairIn, pairOut, both hops' reserves/balances/outputs) to
    /// exceed it. No behavior change: identical math and ordering to what
    /// used to be hop 1 inline -- tokenIn -> ETH, held by this router only
    /// for the duration of the outer call, no payoutBps applied to this leg
    /// (only hop 2's final output is scaled by payoutBps, matching this
    /// mock's existing, deliberate single-slippage-per-call behavior).
    function _swapTokenToEthHop(address pair, address token, uint256 amountIn) private returns (uint256 ethOut) {
        (uint256 tokenReserve, uint256 ethReserve) = _reservesFor(pair, token);
        uint256 pairBalBefore = IERC20(token).balanceOf(pair);
        bool pulled = IERC20(token).transferFrom(msg.sender, pair, amountIn);
        require(pulled, "MockRouter: transferFrom failed");
        uint256 actualIn = IERC20(token).balanceOf(pair) - pairBalBefore;
        ethOut = (ethReserve * actualIn) / (tokenReserve + actualIn);
        MockLPToken(payable(pair)).withdrawEth(payable(address(this)), ethOut);
    }

    /// @dev Hop 2 of swapExactTokensForTokensSupportingFeeOnTransferTokens
    /// below -- same extraction reasoning as hop 1 above. Identical math and
    /// ordering to what used to be hop 2 inline -- ETH -> tokenOut, sent to
    /// `to`, scaled by payoutBps, checked against the caller's amountOutMin.
    function _swapEthToTokenHop(
        address pair,
        address token,
        uint256 ethIn,
        address to,
        uint256 amountOutMin
    ) private returns (uint256 received) {
        (uint256 tokenReserve, uint256 ethReserve) = _reservesFor(pair, token);
        uint256 grossOut = (tokenReserve * ethIn) / (ethReserve + ethIn);
        grossOut = (grossOut * payoutBps) / 10_000;
        (bool sentEth, ) = pair.call{value: ethIn}("");
        require(sentEth, "MockRouter: ETH forward failed");
        uint256 balBefore = IERC20(token).balanceOf(to);
        MockLPToken(payable(pair)).withdrawToken(to, grossOut);
        received = IERC20(token).balanceOf(to) - balBefore;
        require(received >= amountOutMin, "MockRouter: insufficient output amount");
    }

    /// @dev CustomToken's only use for a 3-address path: [ourToken, WETH,
    /// reflectionAsset], to swap collected fee-tokens for whatever ERC20 a
    /// creator picked for reflections. Implemented as two hops through the
    /// same per-token/WETH pairs the rest of this mock already uses —
    /// tokenIn -> ETH (_swapTokenToEthHop, same math as the sell function
    /// above), then ETH -> tokenOut (_swapEthToTokenHop, same math as the
    /// buy function above) — rather than modeling a real router's internal
    /// WETH deposit/withdraw dance, which doesn't matter for what these
    /// tests need to prove.
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

        uint256 ethOut = _swapTokenToEthHop(pairIn, tokenIn, amountIn);
        _swapEthToTokenHop(pairOut, tokenOut, ethOut, to, amountOutMin);
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
