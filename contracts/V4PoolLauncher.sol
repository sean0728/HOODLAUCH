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
    /// @notice Longest LP lock the owner can configure. The locker stores the
    /// unlock time as a uint64; an unbounded duration could wrap it into the
    /// past and hand the creator an already-expired lock.
    uint256 public constant MAX_LOCK_DURATION = 3650 days;
    /// @notice Floor on the LP lock, so a launcher can never be configured to lock liquidity for seconds.
    uint256 public constant MIN_LOCK_DURATION = 1 days;
    /// @dev Gas given to the creator when returning seed-rounding ETH dust. Enough
    /// for a smart wallet's receive hook, not enough to be used to grief.
    uint256 private constant DUST_CALL_GAS = 50_000;
    /// @dev Gas given to every other ETH payment this contract makes to an address someone else
    /// controls (the platform treasury, the rewards distributor). Same cap as V4LaunchRelay and
    /// V4CurveFactory use: ample for a multisig or a distributor's receive hook, and a recipient that
    /// burns gas can no longer make a launch or a graduation cost millions more.
    uint256 private constant PAY_GAS = 300_000;

    IPoolManager public immutable poolManager;
    V4LiquidityLocker public immutable locker;
    V4TaxHook public immutable hook;
    IV4TaxSource public immutable taxSource;

    uint256 public lpLockDuration;
    uint256 public maxCreatorBuyBps = 500; // 5.00% of supply

    mapping(address => address) public creatorOf;
    mapping(address => bytes32) public poolIdOf;

    /// @notice The gasless launch relay (V4LaunchRelay): the only caller whose
    /// launch calls are made on someone else's behalf. Zero = gasless launches off.
    address public launchRelay;
    event LaunchRelayUpdated(address newRelay);
    /// @notice The rewards distributor could not receive its share of a launch fee; the share went to
    /// the treasury instead so the launch still succeeds (same rule as V4TokenFactory).
    event RewardsPayoutFailed(address indexed distributor, uint256 amount);
    /// @notice Seed-rounding ETH that neither the creator nor the treasury would take. It stays on the
    /// factory as stray ETH, which the owner can sweep, rather than blocking the launch or graduation.
    event DustKept(address indexed creator, uint256 amount);

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
    event SnipeProtectionUpdated(uint256 startBps, uint256 duration);
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
        _checkLockDuration(lpLockDuration_);
        taxSource = IV4TaxSource(taxSource_);
        address pm_ = IV4TaxSource(taxSource_).poolManager();
        address locker_ = IV4TaxSource(taxSource_).locker();
        address hook_ = IV4TaxSource(taxSource_).hook();
        require(pm_ != address(0) && locker_ != address(0) && hook_ != address(0), "V4PoolLauncher: tax source not fully wired");
        poolManager = IPoolManager(pm_);
        locker = V4LiquidityLocker(locker_);
        hook = V4TaxHook(payable(hook_));
        lpLockDuration = lpLockDuration_;
    }

    /// @dev True when the current call comes from the launch relay.
    function _isRelayed() internal view returns (bool) {
        return msg.sender == launchRelay && msg.sender != address(0);
    }

    /// @dev Who a launch call is for. A direct caller launches for themselves. The
    /// launch relay (a trusted contract that has verified the creator's EIP-712
    /// signature and holds the launch fee) appends the creator's address to the
    /// calldata, the same convention as ERC-2771 forwarders; nobody else can take
    /// this branch, so a direct caller cannot name another creator.
    function _creator() internal view returns (address c) {
        c = msg.sender;
        if (_isRelayed()) {
            require(msg.data.length >= 20, "V4PoolLauncher: relayed call without creator");
            c = address(bytes20(msg.data[msg.data.length - 20:]));
            require(c != address(0), "V4PoolLauncher: invalid creator");
        }
    }

    /// @dev The launch fee this call must carry: the relay keeps the fee itself,
    /// so a relayed call carries none.
    function _feeDue(uint256 fee) internal view returns (uint256) {
        return _isRelayed() ? 0 : fee;
    }

    /// @notice Sets (or, with address(0), turns off) the gasless launch relay. The relay is a contract
    /// (V4LaunchRelay): whoever sits in this slot launches for any creator it names and pays no launch
    /// fee, so an address with no code (a mistyped address, a plain wallet) is refused.
    function setLaunchRelay(address newRelay) external onlyOwner {
        require(newRelay == address(0) || newRelay.code.length > 0, "V4PoolLauncher: relay is not a contract");
        launchRelay = newRelay;
        emit LaunchRelayUpdated(newRelay);
    }

    function _checkLockDuration(uint256 d) private pure {
        require(d >= MIN_LOCK_DURATION, "V4PoolLauncher: lock duration below the 1 day floor");
        require(d <= MAX_LOCK_DURATION, "V4PoolLauncher: lock duration above 10 year ceiling");
    }

    /// @notice Ownership can never be renounced: the owner is the only caller of
    /// the dead-oracle escape hatch and of every setting on the launch modes.
    /// Hand it over with the (two-step) transferOwnership instead.
    function renounceOwnership() public view override onlyOwner {
        revert("V4PoolLauncher: ownership cannot be renounced");
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

    /// @dev Refuses a launch whose snapshotted terms the hook would later
    /// reject. This matters most for the bonding curve, which only configures
    /// the hook at GRADUATION: terms the hook refuses would otherwise be
    /// accepted at creation and leave a curve that can never graduate. The
    /// checks mirror V4TaxHook.configurePool.
    function _requireTermsReady(TaxTerms memory t) internal view {
        require(t.feeWallet != address(0), "V4PoolLauncher: platform fee wallet not configured");
        require(t.priceFeed != address(0), "V4PoolLauncher: price feed not configured");
        require(t.priceFeed.code.length > 0, "V4PoolLauncher: price feed is not a contract");
        require(t.feeBps <= hook.MAX_FEE_BPS(), "V4PoolLauncher: platform fee above the hook ceiling");
        require(t.graduationTargetUsd > 0, "V4PoolLauncher: graduation target must be > 0");
        require(
            t.maxOracleStaleness > 0 && t.maxOracleStaleness <= type(uint32).max, "V4PoolLauncher: oracle staleness out of range"
        );
        require(t.rewardBps + t.creatorRewardBps <= t.feeBps, "V4PoolLauncher: reward bps exceed fee bps");
    }

    /// @dev launch / deploy fee: 50/50 between treasury and the platform rewards
    /// distributor when one is set, all to the treasury otherwise (the same rule as
    /// V4TokenFactory._finalizeLaunch). A rewards distributor that cannot take its half (it reverts, or
    /// needs more than PAY_GAS) must not block every launch: its half goes to the treasury and the
    /// failure is logged. The treasury is the fee's final home, so a treasury that cannot take it makes
    /// this return false and the caller reverts, leaving the creator's ETH with the creator.
    function _splitFee(uint256 amount) internal returns (bool) {
        if (amount == 0) return true;
        address rd = taxSource.rewardsDistributor();
        uint256 toTreasury = amount;
        if (rd != address(0)) {
            uint256 toRewards = amount / 2;
            if (toRewards > 0) {
                if (_pay(rd, toRewards, PAY_GAS)) toTreasury -= toRewards;
                else emit RewardsPayoutFailed(rd, toRewards);
            }
        }
        return _pay(taxSource.feeTreasury(), toTreasury, PAY_GAS);
    }

    /// @dev Plain ETH transfer with a gas cap. The reply is never copied (a recipient answering with
    /// megabytes costs nothing extra) and a zero address, which would just burn the ETH, counts as a
    /// failure.
    function _pay(address to, uint256 value, uint256 gasCap) private returns (bool ok) {
        if (to == address(0)) return false;
        assembly ("memory-safe") {
            ok := call(gasCap, to, value, 0, 0, 0, 0)
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
    /// a full-range position locked to `creator_` for `lockDuration` (the caller
    /// picks it: a custom launch uses the current setting, a curve the one it was created under).
    /// Dust comes back here: ETH to the creator, leftover tokens burned.
    function _seed(PoolKey memory key, address creator_, uint256 tokenAmount, uint256 ethAmount, uint256 lockDuration)
        internal
        returns (uint256 lockId, uint256 liquidity, uint256 ethUsed, uint256 tokenUsed)
    {
        address token = Currency.unwrap(key.currency1);
        IERC20(token).safeTransfer(address(locker), tokenAmount);
        uint128 liq;
        (lockId, liq, ethUsed, tokenUsed) = locker.seedAndLock{value: ethAmount}(
            key, creator_, block.timestamp + lockDuration, tokenAmount, address(this)
        );
        liquidity = liq;
        _returnDust(token, creator_, ethAmount - ethUsed);
        emit LiquidityAdded(token, creator_, ethUsed, tokenUsed, liquidity, block.timestamp + lockDuration, lockId);
    }

    /// @dev Leftover tokens are burned (the launcher's whole balance, so nothing is stranded), the ETH
    /// rounding dust goes back to the creator.
    function _returnDust(address token, address creator_, uint256 ethDust) private {
        uint256 tokenDust = IERC20(token).balanceOf(address(this));
        if (tokenDust > 0) IV4LaunchToken(token).burn(tokenDust);
        if (ethDust > 0) _sendDust(creator_, ethDust);
    }

    /// @dev Returns seed-rounding ETH to the creator without ever letting the
    /// creator, or the treasury, block the launch or graduation: both calls are
    /// gas-capped, the creator is tried first, then the platform treasury, and
    /// dust that neither takes stays on this contract as stray ETH (the owner
    /// can sweep it; it is never a curve's reserve). Graduation is permissionless
    /// and must not depend on anybody's receive hook.
    function _sendDust(address creator_, uint256 amount) internal {
        if (_pay(creator_, amount, DUST_CALL_GAS)) return;
        if (_pay(taxSource.feeTreasury(), amount, PAY_GAS)) return;
        emit DustKept(creator_, amount);
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "V4PoolLauncher: ETH transfer failed");
    }

    // ---------------------------------------------------------------
    // Owner settings
    // ---------------------------------------------------------------

    function setLpLockDuration(uint256 newDuration) external onlyOwner {
        _checkLockDuration(newDuration);
        lpLockDuration = newDuration;
        emit LpLockDurationUpdated(newDuration);
    }

    /// @notice Snipe protection for FUTURE pools this launcher creates: a
    /// surcharge on buys that starts at `startBps` when the pool is created and
    /// falls linearly to zero over `duration` seconds (max 70% and 1 hour; both
    /// zero = off). Each pool copies the value when it is created, so changing
    /// it never touches a pool that already trades. For a bonding curve the
    /// pool is created at graduation, so that is when its window starts. See
    /// V4TaxHook. This launcher's value is independent of V4TokenFactory's.
    function setSnipeProtection(uint256 startBps, uint256 duration) external onlyOwner {
        hook.setSnipeDefaults(startBps, duration);
        emit SnipeProtectionUpdated(startBps, duration);
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
