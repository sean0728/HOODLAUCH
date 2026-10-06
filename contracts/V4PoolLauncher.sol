// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {V4LiquidityLocker} from "./V4LiquidityLocker.sol";
import {V4TaxHook} from "./V4TaxHook.sol";

/// @dev The part of V4TokenFactory the other V4 launchers read, so the
/// platform's tax terms, treasury and distributor slots are configured in ONE
/// place (V4TokenFactory) and every launch mode follows them.
interface IV4TaxSource {
    function poolManager() external view returns (address);
    function locker() external view returns (address);
    function hook() external view returns (address);
    function feeTreasury() external view returns (address);
    function platformFeeWallet() external view returns (address);
    function feeBps() external view returns (uint256);
    function priceFeed() external view returns (address);
    function graduationTargetUsd() external view returns (uint256);
    function maxOracleStaleness() external view returns (uint256);
    function rewardsDistributor() external view returns (address);
    function rewardBps() external view returns (uint256);
    function creatorRewardsDistributor() external view returns (address);
    function creatorRewardBps() external view returns (uint256);
    function feeWalletDistributor() external view returns (address);
}

/// @dev The slice of a launched token (V4LaunchedToken or V4CustomToken) a
/// launcher needs.
interface IV4LaunchToken {
    function registerPool(bytes32 poolId, address hook) external;
    function burn(uint256 amount) external;
}

/// @title V4PoolLauncher
/// @notice Shared plumbing for the V4 launch modes beyond V4TokenFactory's own
/// (custom tax and bonding curve): create the (ETH, token) pool at an exact
/// launch price on the shared hook, snapshot the platform tax terms into it,
/// seed a full-range position through the locker, and deal with rounding dust.
/// Nothing here is specific to a token type; the custom-tax part is an optional
/// extra `configureCustomPool` call.
abstract contract V4PoolLauncher is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using PoolIdLibrary for PoolKey;

    uint24 public constant LP_FEE = 3000;
    int24 public constant TICK_SPACING = 60;

    IPoolManager public immutable poolManager;
    V4LiquidityLocker public immutable locker;
    V4TaxHook public immutable hook;
    IV4TaxSource public immutable taxSource;

    uint256 public lpLockDuration;
    uint256 public maxCreatorBuyBps = 500; // 5.00% of supply

    mapping(address => address) public creatorOf;
    mapping(address => bytes32) public poolIdOf;

    /// @dev Platform tax terms for one pool, snapshotted from the tax source.
    struct TaxTerms {
        address feeWallet;
        uint256 feeBps;
        address priceFeed;
        uint256 graduationTargetUsd;
        uint256 maxOracleStaleness;
        uint256 rewardBps;
        uint256 creatorRewardBps;
    }

    event LpLockDurationUpdated(uint256 newDuration);
    event MaxCreatorBuyBpsUpdated(uint256 newBps);
    event TokenPriceFeedUpdated(address indexed token, address newPriceFeed, uint256 newMaxOracleStaleness);
    event LiquidityAdded(
        address indexed token,
        address indexed creator,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint256 liquidity,
        uint256 unlockTime,
        uint256 indexed lockId
    );

    constructor(address taxSource_, uint256 lpLockDuration_) Ownable(msg.sender) {
        require(taxSource_ != address(0), "V4PoolLauncher: invalid tax source");
        taxSource = IV4TaxSource(taxSource_);
        poolManager = IPoolManager(IV4TaxSource(taxSource_).poolManager());
        locker = V4LiquidityLocker(IV4TaxSource(taxSource_).locker());
        hook = V4TaxHook(IV4TaxSource(taxSource_).hook());
        lpLockDuration = lpLockDuration_;
    }

    // ---------------------------------------------------------------
    // Platform terms (read from V4TokenFactory)
    // ---------------------------------------------------------------

    function _currentTerms() internal view returns (TaxTerms memory t) {
        t.feeWallet = taxSource.platformFeeWallet();
        t.feeBps = taxSource.feeBps();
        t.priceFeed = taxSource.priceFeed();
        t.graduationTargetUsd = taxSource.graduationTargetUsd();
        t.maxOracleStaleness = taxSource.maxOracleStaleness();
        t.rewardBps = taxSource.rewardBps();
        t.creatorRewardBps = taxSource.creatorRewardBps();
    }

    function _requireTermsReady(TaxTerms memory t) internal pure {
        require(t.feeWallet != address(0), "V4PoolLauncher: platform fee wallet not configured");
        require(t.priceFeed != address(0), "V4PoolLauncher: price feed not configured");
    }

    /// @dev launch / deploy fee: 50/50 between treasury and the platform
    /// rewards distributor when one is set, all to the treasury otherwise.
    /// Same rule as V4TokenFactory._finalizeLaunch.
    function _splitFee(uint256 amount) internal returns (bool okAll, address failedTo, uint256 failedAmt) {
        okAll = true;
        if (amount == 0) return (true, address(0), 0);
        address rd = taxSource.rewardsDistributor();
        address treasury = taxSource.feeTreasury();
        if (rd != address(0)) {
            uint256 toRewards = amount / 2;
            uint256 toTreasury = amount - toRewards;
            if (toRewards > 0) {
                (bool s1,) = rd.call{value: toRewards}("");
                if (!s1) return (false, rd, toRewards);
            }
            (bool s2,) = treasury.call{value: toTreasury}("");
            if (!s2) return (false, treasury, toTreasury);
        } else {
            (bool s3,) = treasury.call{value: amount}("");
            if (!s3) return (false, treasury, amount);
        }
    }

    // ---------------------------------------------------------------
    // Pool creation + seeding
    // ---------------------------------------------------------------

    /// @dev Initializes the pool at exactly tokenAmount : ethAmount, snapshots
    /// the platform tax into the hook, optionally attaches a custom fee split,
    /// and records the pool on the token.
    function _initPool(
        address token,
        uint256 tokenAmount,
        uint256 ethAmount,
        TaxTerms memory t,
        bool custom,
        V4TaxHook.CustomFees memory fees
    ) internal returns (PoolKey memory key, bytes32 poolId) {
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        poolManager.initialize(key, _initialSqrtPriceX96(tokenAmount, ethAmount));
        _configureHook(key, t);
        if (custom) hook.configureCustomPool(key, fees);
        poolId = PoolId.unwrap(key.toId());
        IV4LaunchToken(token).registerPool(poolId, address(hook));
        poolIdOf[token] = poolId;
    }

    function _configureHook(PoolKey memory key, TaxTerms memory t) private {
        address rd = taxSource.rewardsDistributor();
        address crd = taxSource.creatorRewardsDistributor();
        hook.configurePool(
            key,
            t.feeWallet,
            t.feeBps,
            t.priceFeed,
            t.graduationTargetUsd,
            t.maxOracleStaleness,
            rd,
            rd != address(0) ? t.rewardBps : 0,
            crd,
            crd != address(0) ? t.creatorRewardBps : 0,
            taxSource.feeWalletDistributor()
        );
    }

    /// @dev sqrtPriceX96 = sqrt(tokens / wei) * 2^96, computed as
    /// sqrt(tokens * 2^96 / wei) * 2^48 so the intermediate never overflows.
    function _initialSqrtPriceX96(uint256 tokenAmount, uint256 ethAmount) internal pure returns (uint160) {
        uint256 ratioX96 = FullMath.mulDiv(tokenAmount, 1 << 96, ethAmount);
        return (Math.sqrt(ratioX96) << 48).toUint160();
    }

    /// @dev Hands tokenAmount of the token + ethAmount of ETH to the locker for
    /// a full-range position locked to `creator_`. Dust comes back here: ETH to
    /// the creator, leftover tokens burned.
    function _seed(PoolKey memory key, address creator_, uint256 tokenAmount, uint256 ethAmount)
        internal
        returns (uint256 lockId, uint256 liquidity, uint256 ethUsed, uint256 tokenUsed)
    {
        address token = Currency.unwrap(key.currency1);
        IERC20(token).safeTransfer(address(locker), tokenAmount);
        uint128 liq;
        (lockId, liq, ethUsed, tokenUsed) = locker.seedAndLock{value: ethAmount}(
            key, creator_, block.timestamp + lpLockDuration, tokenAmount, address(this)
        );
        liquidity = liq;
        uint256 tokenDust = IERC20(token).balanceOf(address(this));
        if (tokenDust > 0) IV4LaunchToken(token).burn(tokenDust);
        uint256 ethDust = ethAmount - ethUsed;
        if (ethDust > 0) _sendEth(creator_, ethDust);
        emit LiquidityAdded(token, creator_, ethUsed, tokenUsed, liquidity, block.timestamp + lpLockDuration, lockId);
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "V4PoolLauncher: ETH transfer failed");
    }

    // ---------------------------------------------------------------
    // Owner settings
    // ---------------------------------------------------------------

    function setLpLockDuration(uint256 newDuration) external onlyOwner {
        require(newDuration > 0, "V4PoolLauncher: lock duration must be > 0");
        lpLockDuration = newDuration;
        emit LpLockDurationUpdated(newDuration);
    }

    function setMaxCreatorBuyBps(uint256 newBps) external onlyOwner {
        require(newBps <= 2_000, "V4PoolLauncher: max creator buy above 20% ceiling");
        maxCreatorBuyBps = newBps;
        emit MaxCreatorBuyBpsUpdated(newBps);
    }

    /// @notice Dead-oracle escape hatch; see V4TaxHook.updatePriceFeed.
    function updateTokenPriceFeed(address token, address newPriceFeed_, uint256 newMaxOracleStaleness_) external onlyOwner {
        bytes32 id = poolIdOf[token];
        require(id != bytes32(0), "V4PoolLauncher: token has no pool");
        hook.updatePriceFeed(PoolId.wrap(id), newPriceFeed_, newMaxOracleStaleness_);
        emit TokenPriceFeedUpdated(token, newPriceFeed_, newMaxOracleStaleness_);
    }
}
