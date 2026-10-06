// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title V4SwapRouter
/// @notice The site's trading entry point for V4 launches. A wallet can't call
/// the PoolManager's swap directly (swaps run inside unlock()), so this tiny
/// stateless router does it: exact-in buy (ETH -> token) and exact-in sell
/// (token -> ETH) on a launch pool, with a minimum-out guard and a deadline.
///
/// It holds no funds between transactions, has no owner and no settings. The
/// hook's trading tax is applied by the pool exactly as for any other
/// swapper, so `minOut` is compared against what the trader actually receives
/// (net of the tax). Anyone can use it; it only ever swaps the caller's own
/// ETH / tokens and pays the output to the caller.
contract V4SwapRouter is ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    // Must match V4TokenFactory's pool parameters.
    uint24 public constant LP_FEE = 3000;
    int24 public constant TICK_SPACING = 60;

    IPoolManager public immutable poolManager;
    address public immutable hook;

    event Bought(address indexed token, address indexed trader, uint256 ethIn, uint256 tokensOut);
    event Sold(address indexed token, address indexed trader, uint256 tokensIn, uint256 ethOut);

    constructor(IPoolManager poolManager_, address hook_) {
        require(address(poolManager_) != address(0) && hook_ != address(0), "V4SwapRouter: invalid address");
        poolManager = poolManager_;
        hook = hook_;
    }

    function _key(address token) private view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    /// @notice Spends all of msg.value on `token` and sends the tokens to the
    /// caller. Reverts if the tokens received (after the hook's tax) are below
    /// `minTokensOut`.
    function buy(address token, uint256 minTokensOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        require(block.timestamp <= deadline, "V4SwapRouter: expired");
        require(msg.value > 0, "V4SwapRouter: no ETH sent");
        bytes memory result = poolManager.unlock(abi.encode(true, _key(token), msg.value, msg.sender));
        uint256 ethSpent;
        (ethSpent, tokensOut) = abi.decode(result, (uint256, uint256));
        require(tokensOut > 0 && tokensOut >= minTokensOut, "V4SwapRouter: output below minimum");
        if (msg.value > ethSpent) {
            (bool ok,) = payable(msg.sender).call{value: msg.value - ethSpent}("");
            require(ok, "V4SwapRouter: refund failed");
        }
        emit Bought(token, msg.sender, ethSpent, tokensOut);
    }

    /// @notice Sells exactly `amountIn` of `token` (the caller must have
    /// approved this router) and sends the ETH to the caller. Reverts if the
    /// ETH received is below `minEthOut`.
    function sell(address token, uint256 amountIn, uint256 minEthOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        require(block.timestamp <= deadline, "V4SwapRouter: expired");
        require(amountIn > 0, "V4SwapRouter: nothing to sell");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        bytes memory result = poolManager.unlock(abi.encode(false, _key(token), amountIn, msg.sender));
        uint256 tokenSpent;
        (tokenSpent, ethOut) = abi.decode(result, (uint256, uint256));
        require(ethOut > 0 && ethOut >= minEthOut, "V4SwapRouter: output below minimum");
        if (amountIn > tokenSpent) IERC20(token).safeTransfer(msg.sender, amountIn - tokenSpent);
        emit Sold(token, msg.sender, tokenSpent, ethOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "V4SwapRouter: only pool manager");
        (bool isBuy, PoolKey memory key, uint256 amountIn, address trader) =
            abi.decode(data, (bool, PoolKey, uint256, address));

        if (isBuy) {
            BalanceDelta delta = poolManager.swap(
                key,
                SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
                ""
            );
            uint256 ethSpent = uint256(uint128(-delta.amount0()));
            uint256 tokensOut = uint256(uint128(delta.amount1()));
            poolManager.settle{value: ethSpent}();
            if (tokensOut > 0) poolManager.take(key.currency1, trader, tokensOut);
            return abi.encode(ethSpent, tokensOut);
        } else {
            BalanceDelta delta = poolManager.swap(
                key,
                SwapParams({zeroForOne: false, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
                ""
            );
            uint256 tokenSpent = uint256(uint128(-delta.amount1()));
            uint256 ethOut = uint256(uint128(delta.amount0()));
            if (tokenSpent > 0) {
                poolManager.sync(key.currency1);
                IERC20(Currency.unwrap(key.currency1)).safeTransfer(address(poolManager), tokenSpent);
                poolManager.settle();
            }
            if (ethOut > 0) poolManager.take(key.currency0, trader, ethOut);
            return abi.encode(tokenSpent, ethOut);
        }
    }

    /// @notice Everything the page needs to quote a trade locally: the pool's
    /// current sqrt price (Q96, tokens per wei) and in-range liquidity.
    /// sqrtPriceX96 is 0 when the token has no pool.
    function poolState(address token) external view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity) {
        PoolKey memory key = _key(token);
        (sqrtPriceX96, tick,,) = poolManager.getSlot0(key.toId());
        liquidity = poolManager.getLiquidity(key.toId());
    }
}
