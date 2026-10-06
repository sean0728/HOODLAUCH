// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @title V4TokenSeller
/// @notice Shared base of the V4 distributors. On V4 the trading tax arrives
/// in kind (the launched token itself, pushed here by V4TaxHook), and these
/// contracts turn it into ETH by selling it into that token's own
/// (native ETH, token) V4 pool, the V4 counterpart of what the V2
/// distributors did through the V2 router.
///
/// Two things differ from V2 and are deliberate:
///  - The sale is a swap on a taxed pool, so the hook must exempt this
///    contract (V4TokenFactory.setTaxExempt) or each conversion would pay the
///    tax again. Without the exemption a sale still works, it just loses
///    feeBps to a second round of tax.
///  - V2 derived a slippage floor from pair reserves. Here the guard is a
///    PRICE LIMIT handed to the pool: the swap may move the pool's price by at
///    most swapSlippageBps (5.00%-8.00%, same band as everywhere else), and
///    simply stops there. Whatever it couldn't sell stays here for the next
///    call. The caller's own minimum ETH out applies on top.
abstract contract V4TokenSeller is Ownable2Step, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    // Must match V4TokenFactory's pool parameters.
    uint24 public constant LP_FEE = 3000;
    int24 public constant TICK_SPACING = 60;

    IPoolManager public immutable poolManager;
    /// @notice The V4TaxHook every launch pool uses.
    address public immutable hook;

    uint256 public swapSlippageBps = 600; // 6.00% default
    uint256 public constant MIN_SWAP_SLIPPAGE_BPS = 500; // 5.00%
    uint256 public constant MAX_SWAP_SLIPPAGE_BPS = 800; // 8.00%

    event SwapSlippageBpsUpdated(uint256 newBps);

    constructor(IPoolManager poolManager_, address hook_, address initialOwner_) Ownable(initialOwner_) {
        require(address(poolManager_) != address(0), "V4TokenSeller: invalid pool manager");
        require(hook_ != address(0), "V4TokenSeller: invalid hook");
        poolManager = poolManager_;
        hook = hook_;
    }

    /// @notice ETH only ever arrives from the PoolManager (sale proceeds), the
    /// V4 factory (its 50% fee share, for the rewards distributor) or, in
    /// the platform distributor's case, a plain transfer.
    receive() external payable {}

    function setSwapSlippageBps(uint256 newBps) external onlyOwner {
        require(newBps >= MIN_SWAP_SLIPPAGE_BPS, "V4TokenSeller: slippage below 5% floor");
        require(newBps <= MAX_SWAP_SLIPPAGE_BPS, "V4TokenSeller: slippage above 8% ceiling");
        swapSlippageBps = newBps;
        emit SwapSlippageBpsUpdated(newBps);
    }

    function _poolKey(address token) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    /// @dev The price (tokens per ETH) rises as the token is sold into the
    /// pool, so the limit is the current sqrt price grown by the slippage.
    function _sellPriceLimit(PoolKey memory key) private view returns (uint160) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        require(sqrtPriceX96 != 0, "V4TokenSeller: no pool for token");
        uint256 factorX4 = Math.sqrt((10_000 + swapSlippageBps) * 1e4); // sqrt(1 + slip) * 1e4
        uint256 limit = FullMath.mulDiv(sqrtPriceX96, factorX4, 1e4);
        uint256 maxLimit = uint256(TickMath.MAX_SQRT_PRICE) - 1;
        return uint160(limit > maxLimit ? maxLimit : limit);
    }

    /// @dev Sells up to `amountIn` of `token` for ETH through the token's V4
    /// pool, within the price limit. Returns what was actually sold and the
    /// ETH received (now held by this contract).
    function _sellForEth(address token, uint256 amountIn, uint256 minEthOut)
        internal
        returns (uint256 tokenSpent, uint256 ethOut)
    {
        require(amountIn > 0, "V4TokenSeller: nothing to sell");
        PoolKey memory key = _poolKey(token);
        uint160 limit = _sellPriceLimit(key);
        bytes memory result = poolManager.unlock(abi.encode(key, amountIn, limit));
        (tokenSpent, ethOut) = abi.decode(result, (uint256, uint256));
        require(ethOut > 0 && ethOut >= minEthOut, "V4TokenSeller: output below minimum");
    }

    /// @dev Runs inside PoolManager.unlock, which only this contract calls.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "V4TokenSeller: only pool manager");
        (PoolKey memory key, uint256 amountIn, uint160 limit) = abi.decode(data, (PoolKey, uint256, uint160));

        // Exact-in token -> ETH (token is currency1, so oneForZero).
        BalanceDelta delta = poolManager.swap(
            key, SwapParams({zeroForOne: false, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: limit}), ""
        );
        uint256 tokenSpent = uint256(uint128(-delta.amount1()));
        uint256 ethOut = uint256(uint128(delta.amount0()));

        if (tokenSpent > 0) {
            poolManager.sync(key.currency1);
            IERC20(Currency.unwrap(key.currency1)).safeTransfer(address(poolManager), tokenSpent);
            poolManager.settle();
        }
        if (ethOut > 0) poolManager.take(key.currency0, address(this), ethOut);
        return abi.encode(tokenSpent, ethOut);
    }
}
