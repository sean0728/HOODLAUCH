// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import "./V4TokenSeller.sol";

/// @dev The slice of V4CustomToken the converter drives.
interface IV4ReflectionToken {
    function payoutMode() external view returns (uint8);
    function payoutToken() external view returns (address);
    function converter() external view returns (address);
    function pendingConversion() external view returns (uint256);
    function releaseForConversion(uint256 amount) external;
    function returnUnconverted(uint256 amount) external;
    function depositPayoutEth() external payable;
    function depositPayoutToken() external returns (uint256 received);
}

interface IV4ReflectionFlag {
    function reflectionsEnabled() external view returns (bool);
}

/// @title V4ReflectionConverter
/// @notice Turns a Custom Tax token's reflection share into what its creator chose to pay
/// holders in: ETH, or another platform token. (Paying in the token itself needs no
/// conversion and does not involve this contract.)
///
/// V4TaxHook still delivers the reflection share in kind, to the token. For an ETH / token
/// payout the token keeps those tokens in `pendingConversion`. Here, an approved keeper (the
/// relayer) or the owner calls convert():
///
///   1. the token releases (some of) its pending tokens to this contract;
///   2. they are sold for ETH into the token's own V4 pool, inside a price limit
///      (swapSlippageBps, see V4TokenSeller) and above the caller's minimum;
///   3. ETH payout: the ETH is deposited into the token, which shares it out per holding.
///      Token payout: the ETH buys the target token through the target's own V4 pool (same
///      price limit and the caller's minimum), and that token is deposited the same way.
///
/// Anything the price limit stops from filling is not lost: unsold reflection tokens go back to
/// the token's pending pile, and ETH the target pool could not absorb is carried to the next
/// conversion. Converting is limited to the owner and approved keepers. The price limit is
/// measured from the current price, so any other caller (the token's creator included: the
/// creator is a token holder with an interest in the rate, and can trade the pool before and
/// after) could sandwich a conversion and take value from the holders it is paid to.
///
/// Wiring: set this as V4TokenFactory.reflectionConverter BEFORE launching tokens that use it
/// (each token fixes its converter at launch), exempt it from the hook's tax with
/// V4TokenFactory.setTaxExempt(this, true), and make the relayer wallet a keeper.
contract V4ReflectionConverter is V4TokenSeller {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @notice Smallest pending pile (in the token's own units) worth converting, per token. 0 = any.
    mapping(address => uint256) public convertThreshold;
    /// @notice Anti-dump cap per call. 0 = uncapped.
    mapping(address => uint256) public maxConvertAmount;
    /// @notice ETH a token payout could not spend yet (the target pool's price limit), per reflection token.
    mapping(address => uint256) public carryEth;
    uint256 public totalCarryEth;

    event ConvertThresholdUpdated(address indexed token, uint256 newThreshold);
    event MaxConvertAmountUpdated(address indexed token, uint256 newMax);
    event ReflectionsConverted(
        address indexed token, uint8 mode, uint256 tokensSold, uint256 ethOut, uint256 payoutDeposited, uint256 ethCarried
    );
    event StrayEthRescued(address indexed to, uint256 amount);
    event StrayTokensRescued(address indexed token, address indexed to, uint256 amount);

    constructor(IPoolManager poolManager_, address hook_, address initialOwner_)
        V4TokenSeller(poolManager_, hook_, initialOwner_)
    {}

    function setConvertThreshold(address token, uint256 newThreshold) external onlyOwner {
        convertThreshold[token] = newThreshold;
        emit ConvertThresholdUpdated(token, newThreshold);
    }

    function setMaxConvertAmount(address token, uint256 newMax) external onlyOwner {
        maxConvertAmount[token] = newMax;
        emit MaxConvertAmountUpdated(token, newMax);
    }

    // ---------------------------------------------------------------
    // Target validation (called by a token when its creator picks "another token")
    // ---------------------------------------------------------------

    /// @notice Reverts unless `target` is a token this contract can buy: it must have a pool on the
    /// platform hook, and must not pay reflections of its own (this contract's holder would then
    /// accrue shares nobody can claim).
    function validateTarget(address target) external view {
        require(target != address(0), "V4ReflectionConverter: invalid target");
        require(_hasPool(target), "V4ReflectionConverter: target has no platform pool");
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSelector(IV4ReflectionFlag.reflectionsEnabled.selector));
        if (ok && ret.length >= 32) {
            require(!abi.decode(ret, (bool)), "V4ReflectionConverter: target pays reflections itself");
        }
    }

    // ---------------------------------------------------------------
    // Conversion
    // ---------------------------------------------------------------

    /// @notice Converts up to maxConvertAmount[token] of the token's pending reflection tokens and
    /// deposits the proceeds into the token for its holders. `minEthOut` bounds the sale;
    /// `minPayoutOut` bounds the purchase of the target token (token payouts; ignored for ETH).
    /// Returns what was deposited (wei for ETH payouts, target-token units otherwise).
    function convert(address token, uint256 minEthOut, uint256 minPayoutOut)
        external
        nonReentrant
        returns (uint256 deposited)
    {
        IV4ReflectionToken t = IV4ReflectionToken(token);
        uint8 mode = t.payoutMode();
        require(mode != 0 && t.converter() == address(this), "V4ReflectionConverter: not served by this converter");
        require(_isKeeper(msg.sender), "V4ReflectionConverter: not authorized to convert");

        uint256 pending = t.pendingConversion();
        uint256 carry = carryEth[token];
        bool sell = pending > 0 && pending >= convertThreshold[token];
        require(sell || (mode == 2 && carry > 0), "V4ReflectionConverter: nothing to convert");

        uint256 sold;
        uint256 ethOut;
        if (sell) {
            uint256 cap = maxConvertAmount[token];
            uint256 amountIn = (cap > 0 && pending > cap) ? cap : pending;
            t.releaseForConversion(amountIn);
            (sold, ethOut) = _swap(0, token, amountIn, minEthOut);
            if (sold < amountIn) {
                t.returnUnconverted(amountIn - sold);
            }
        }

        if (mode == 1) {
            deposited = ethOut;
            t.depositPayoutEth{value: ethOut}();
            emit ReflectionsConverted(token, mode, sold, ethOut, deposited, 0);
            return deposited;
        }

        address target = t.payoutToken();
        uint256 ethIn = ethOut + carry;
        carryEth[token] = 0;
        totalCarryEth -= carry;
        (uint256 ethSpent, uint256 got) = _swap(1, target, ethIn, minPayoutOut);
        uint256 left = ethIn - ethSpent;
        if (left > 0) {
            carryEth[token] = left;
            totalCarryEth += left;
        }
        IERC20(target).safeTransfer(token, got);
        deposited = t.depositPayoutToken();
        emit ReflectionsConverted(token, mode, sold, ethOut, deposited, left);
    }

    // ---------------------------------------------------------------
    // Swaps (op 0: sell `token` for ETH, op 1: buy `token` with ETH)
    // ---------------------------------------------------------------

    function _buyPriceLimit(PoolKey memory key) private view returns (uint160) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        require(sqrtPriceX96 != 0, "V4ReflectionConverter: no pool for token");
        // buying pushes the price (tokens per ETH) DOWN, so the limit is the current sqrt price shrunk by the slippage
        uint256 factorX4 = Math.sqrt((10_000 - swapSlippageBps) * 1e4); // sqrt(1 - slip) * 1e4
        uint256 limit = FullMath.mulDiv(sqrtPriceX96, factorX4, 1e4);
        uint256 minLimit = uint256(TickMath.MIN_SQRT_PRICE) + 1;
        return uint160(limit < minLimit ? minLimit : limit);
    }

    function _swap(uint8 op, address token, uint256 amountIn, uint256 minOut)
        private
        returns (uint256 spent, uint256 out)
    {
        require(amountIn > 0, "V4ReflectionConverter: nothing to swap");
        PoolKey memory key = _poolKey(token);
        uint160 limit = op == 0 ? _sellPriceLimit(key) : _buyPriceLimit(key);
        bytes memory result = poolManager.unlock(abi.encode(op, key, amountIn, limit));
        (spent, out) = abi.decode(result, (uint256, uint256));
        require(out > 0 && out >= minOut, "V4ReflectionConverter: output below minimum");
    }

    /// @dev Runs inside PoolManager.unlock, which only this contract calls.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "V4ReflectionConverter: only pool manager");
        (uint8 op, PoolKey memory key, uint256 amountIn, uint160 limit) = abi.decode(data, (uint8, PoolKey, uint256, uint160));
        if (op == 0) {
            // token -> ETH (token is currency1, so oneForZero)
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
        // ETH -> token (ETH is currency0, so zeroForOne)
        BalanceDelta d = poolManager.swap(
            key, SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: limit}), ""
        );
        uint256 ethSpent = uint256(uint128(-d.amount0()));
        uint256 tokensOut = uint256(uint128(d.amount1()));
        if (ethSpent > 0) poolManager.settle{value: ethSpent}();
        if (tokensOut > 0) poolManager.take(key.currency1, address(this), tokensOut);
        return abi.encode(ethSpent, tokensOut);
    }

    // ---------------------------------------------------------------
    // Rescue (stray balances only; carried ETH and in-flight tokens are never touched)
    // ---------------------------------------------------------------

    function rescueStrayEth(address to) external onlyOwner nonReentrant returns (uint256 amount) {
        require(to != address(0), "V4ReflectionConverter: invalid recipient");
        uint256 bal = address(this).balance;
        amount = bal > totalCarryEth ? bal - totalCarryEth : 0;
        require(amount > 0, "V4ReflectionConverter: nothing to rescue");
        (bool sent,) = payable(to).call{value: amount}("");
        require(sent, "V4ReflectionConverter: ETH transfer failed");
        emit StrayEthRescued(to, amount);
    }

    /// @dev Between calls this contract holds no tokens, so any balance is stray.
    function rescueStrayTokens(address token, address to) external onlyOwner nonReentrant returns (uint256 amount) {
        require(to != address(0), "V4ReflectionConverter: invalid recipient");
        amount = IERC20(token).balanceOf(address(this));
        require(amount > 0, "V4ReflectionConverter: nothing to rescue");
        IERC20(token).safeTransfer(to, amount);
        emit StrayTokensRescued(token, to, amount);
    }
}
