// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

/// @title V4LiquidityCompounder
/// @notice Turns the "liquidity" share of a custom fee into pool liquidity.
///
/// On V2 the token swapped half of its liquidity fee to ETH and added the pair
/// to the pool, burning the LP. This is the V4 equivalent. The hook sends the
/// liquidity share of every taxed swap here, in the token. compound(token):
/// anyone may call it (a keeper normally does), and it
///
///   1. sells half of the tokens it holds into the token's own pool,
///   2. adds the ETH it got plus the other half as a full-range position, and
///   3. keeps that position for good: this contract has NO function that
///      removes liquidity or sends the position anywhere, so it is permanently
///      locked -- the same end state as V2's burned LP.
///
/// MEV: the sale is capped at a 3% price move (it simply sells less if the
/// pool is pushed further), and the amounts at stake are fee dust (a few % of
/// volume), so a sandwich costs the attacker more than it can win.
///
/// The sale must not be taxed or it would pay itself: the platform owner
/// marks this contract tax-exempt on the factory (setTaxExempt), exactly like
/// the distributors.
contract V4LiquidityCompounder is ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint24 public constant LP_FEE = 3000;
    int24 public constant TICK_SPACING = 60;
    /// @dev sqrtP * 10149/10000 ~ a 3% price move.
    uint256 public constant MAX_SQRT_MOVE_BPS = 149;

    IPoolManager public immutable poolManager;
    address public immutable hook;

    mapping(address => uint256) public totalTokensCompounded;
    mapping(address => uint256) public totalEthCompounded;

    event Compounded(address indexed token, uint256 tokensSold, uint256 ethAdded, uint256 tokensAdded, uint128 liquidity);

    constructor(IPoolManager poolManager_, address hook_) {
        require(address(poolManager_) != address(0) && hook_ != address(0), "V4LiquidityCompounder: invalid address");
        poolManager = poolManager_;
        hook = hook_;
    }

    receive() external payable {
        require(msg.sender == address(poolManager), "V4LiquidityCompounder: unexpected ETH");
    }

    /// @notice Tokens waiting to be compounded for `token`.
    function pending(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
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

    /// @notice Adds everything waiting for `token` to its pool, permanently.
    function compound(address token) external nonReentrant returns (uint128 liquidity) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal >= 2, "V4LiquidityCompounder: nothing to compound");
        PoolKey memory key = _key(token);
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        require(sqrtPriceX96 != 0, "V4LiquidityCompounder: no pool");

        bytes memory result = poolManager.unlock(abi.encode(key, bal / 2, sqrtPriceX96));
        uint256 sold;
        uint256 ethAdded;
        uint256 tokensAdded;
        (sold, ethAdded, tokensAdded, liquidity) = abi.decode(result, (uint256, uint256, uint256, uint128));
        require(liquidity > 0, "V4LiquidityCompounder: zero liquidity");
        totalTokensCompounded[token] += sold + tokensAdded;
        totalEthCompounded[token] += ethAdded;
        emit Compounded(token, sold, ethAdded, tokensAdded, liquidity);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "V4LiquidityCompounder: only pool manager");
        (PoolKey memory key, uint256 sellAmount, uint160 startSqrt) = abi.decode(data, (PoolKey, uint256, uint160));
        address token = Currency.unwrap(key.currency1);

        // 1. Sell half, price-capped. (Selling the token raises sqrtP.)
        uint256 limit = (uint256(startSqrt) * (10_000 + MAX_SQRT_MOVE_BPS)) / 10_000;
        if (limit >= TickMath.MAX_SQRT_PRICE) limit = TickMath.MAX_SQRT_PRICE - 1;
        BalanceDelta d = poolManager.swap(
            key, SwapParams({zeroForOne: false, amountSpecified: -int256(sellAmount), sqrtPriceLimitX96: uint160(limit)}), ""
        );
        uint256 sold = uint256(uint128(-d.amount1()));
        uint256 ethOut = d.amount0() > 0 ? uint256(uint128(d.amount0())) : 0;
        if (sold > 0) {
            poolManager.sync(key.currency1);
            IERC20(token).safeTransfer(address(poolManager), sold);
            poolManager.settle();
        }
        if (ethOut > 0) poolManager.take(key.currency0, address(this), ethOut);

        // 2. Add the ETH + remaining tokens as full-range liquidity at the new price.
        (uint256 ethAdded, uint256 tokensAdded, uint128 liquidity) = _addAll(key, token);
        return abi.encode(sold, ethAdded, tokensAdded, liquidity);
    }

    function _addAll(PoolKey memory key, address token)
        private
        returns (uint256 ethAdded, uint256 tokensAdded, uint128 liquidity)
    {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(TICK_SPACING)),
            TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(TICK_SPACING)),
            address(this).balance,
            IERC20(token).balanceOf(address(this))
        );
        if (liquidity == 0) return (0, 0, 0);
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(TICK_SPACING),
                tickUpper: TickMath.maxUsableTick(TICK_SPACING),
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );
        ethAdded = uint256(uint128(-delta.amount0()));
        tokensAdded = uint256(uint128(-delta.amount1()));
        if (ethAdded > 0) poolManager.settle{value: ethAdded}();
        if (tokensAdded > 0) {
            poolManager.sync(key.currency1);
            IERC20(token).safeTransfer(address(poolManager), tokensAdded);
            poolManager.settle();
        }
    }
}
