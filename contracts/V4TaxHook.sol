// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./interfaces/V4IAggregatorV3.sol";

/// @dev The slice of V4CustomToken the hook talks to.
interface IV4CustomTokenHooked {
    function marketingWallet() external view returns (address);
    function notifyReflection(uint256 amount) external;
    function burn(uint256 amount) external;
}

/// @title V4TaxHook
/// @notice The Uniswap V4 hook that collects HoodLaunch's trading tax at the
/// pool, as part of each swap. It replaces the V2 design where the token's own
/// _update() skimmed a fee on every transfer touching the pair.
///
/// POOL SHAPE. Every HoodLaunch V4 pool is (native ETH, token): currency0 is
/// ETH (address(0), which always sorts first) and currency1 is the launched
/// token. So a "buy" is zeroForOne = true (ETH in, token out) and a "sell" is
/// zeroForOne = false (token in, ETH out).
///
/// THE TAX IS ALWAYS TAKEN IN THE TOKEN. Whichever way a trade runs, the fee
/// is `feeBps` of the token leg, so it can be paid straight out of the
/// PoolManager to the destinations with take() and no swapping is needed.
/// Which hook callback has to carry it depends on whether the token is the
/// "specified" side of the swap (the side the trader fixed) or the
/// "unspecified" side (the side the pool computed):
///
///   token specified   -> beforeSwap return delta  (exact-in SELL, exact-out BUY)
///   token unspecified -> afterSwap  return delta  (exact-in BUY,  exact-out SELL)
///
/// In every case the fee is exactly feeBps of the GROSS token amount moved
/// (so a 1% tax means a buyer receives 99% of what the pool paid out, and a
/// seller is charged 101.0101..% of what the pool takes -- i.e. the fee is 1%
/// of the total). The fee is then split exactly like the V2 token did:
/// rewardBps to rewardsDistributor, creatorRewardBps to
/// creatorRewardsDistributor, and the remainder to feeWalletDistributor if
/// set, otherwise straight to feeWallet.
///
/// WHAT THIS HOOK ALSO FIXES versus V2. Only the factory may initialize a pool
/// that uses this hook (beforeInitialize), so there is no equivalent of the V2
/// "someone pre-creates the pair before the launch" attack. Anyone CAN still
/// create an unrelated (ETH, token) pool with a different hook (or none) --
/// that pool is simply not taxed, exactly as a second V2 pair was not taxed in
/// V2. The tax follows this one registered pool.
///
/// GRADUATION. After every taxed swap the hook reads the pool's live price
/// (slot0) and, using the same Chainlink-style ETH/USD feed, same fail-open
/// try/catch pattern and same two-observation 30 minute confirmation window as
/// V2, permanently turns the tax off once market cap reaches the target.
///
/// ADDRESS. A V4 hook's permissions are encoded in the low 14 bits of its
/// address, so this contract must be deployed with CREATE2 to a mined address
/// whose low 14 bits equal REQUIRED_FLAGS (0x20CC). The constructor reverts
/// otherwise. See scripts/V4mineHookAddress.js and V4Create2Deployer.
contract V4TaxHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeCast for uint256;

    // BEFORE_INITIALIZE | BEFORE_SWAP | AFTER_SWAP | BEFORE_SWAP_RETURNS_DELTA | AFTER_SWAP_RETURNS_DELTA
    uint160 public constant REQUIRED_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
        | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    uint256 public constant GRADUATION_CONFIRMATION_WINDOW = 30 minutes;
    uint256 public constant MAX_FEE_BPS = 2_000; // 20% ceiling, same as V2
    /// @dev Gas forwarded to each price-feed call. A real Chainlink-style
    /// aggregator proxy needs well under 50k; the cap stops a broken or hostile
    /// feed from making every swap on the pool burn the whole block gas limit.
    uint256 private constant FEED_CALL_GAS = 200_000;
    /// @dev Largest feed `decimals()` accepted. Anything above is treated as a
    /// dead feed (10**decimals would overflow long before 77).
    uint256 private constant MAX_FEED_DECIMALS = 36;

    IPoolManager public immutable poolManager;
    /// @notice Deployer; may call setFactory exactly once.
    address public immutable deployer;
    /// @notice The V4TokenFactory: the only address allowed to initialize a
    /// pool on this hook or to configure one. Set once.
    address public factory;

    /// @notice Extra pool launchers (V4CustomTokenFactory, V4CurveFactory)
    /// allowed to initialize + configure pools on this hook, in addition to
    /// `factory`. Managed by the deployer. Each pool remembers who configured
    /// it (poolLauncher) and only that launcher may touch it afterwards.
    mapping(address => bool) public launchers;
    mapping(PoolId => address) public poolLauncher;

    /// @notice Per-side creator fee split for a "custom tax" pool, in bps of
    /// the token leg of each swap. Fixed for the pool's life. All four parts
    /// of one side together are capped at MAX_CUSTOM_SIDE_BPS.
    struct CustomFees {
        uint16 buyReflectionBps;
        uint16 buyMarketingBps;
        uint16 buyLiquidityBps;
        uint16 buyBurnBps;
        uint16 sellReflectionBps;
        uint16 sellMarketingBps;
        uint16 sellLiquidityBps;
        uint16 sellBurnBps;
    }
    uint256 public constant MAX_CUSTOM_SIDE_BPS = 500; // 5.00% per side, same cap as V2's CustomToken
    mapping(PoolId => CustomFees) public customFees;
    mapping(PoolId => bool) public hasCustomFees;

    /// @notice Where the "liquidity" share of a custom fee is delivered: the
    /// V4LiquidityCompounder, which turns it into permanent pool liquidity.
    /// Set once by the deployer.
    address public liquidityCompounder;

    struct PoolTax {
        bool configured;
        bool taxActive;
        address token; // currency1 of the pool
        address feeWallet;
        uint16 feeBps;
        uint16 rewardBps;
        uint16 creatorRewardBps;
        address rewardsDistributor;
        address creatorRewardsDistributor;
        address feeWalletDistributor;
        V4IAggregatorV3 priceFeed;
        uint32 maxOracleStaleness;
        uint64 graduationCandidateAt;
        uint256 graduationTargetUsd;
    }

    mapping(PoolId => PoolTax) public poolTax;

    /// @notice Swappers (the platform's own distributor contracts) whose swaps
    /// on any pool of this hook pay no tax. Exists so a distributor selling
    /// the in-kind tax it collected isn't taxed a second time. The swapper is
    /// the address that calls PoolManager.swap, i.e. the distributor itself.
    /// Set by the factory on its owner's instruction; never touches the
    /// graduation check, which still runs on every swap.
    mapping(address => bool) public taxExempt;

    // ---------------------------------------------------------------
    // Snipe protection
    // ---------------------------------------------------------------

    /// @notice Anti-snipe surcharge on BUYS of a freshly launched pool. It
    /// starts at `startBps` the moment the pool is configured and falls in a
    /// straight line to zero over `duration` seconds, so a bot that buys in the
    /// first blocks pays most of its position away while a human buying a
    /// minute later pays little or nothing. It is taken in kind, in the token,
    /// exactly like the normal tax, and goes to the platform fee wallet (or the
    /// fee-wallet distributor) of the pool. Sells are never charged.
    ///
    /// The launcher's own seeding buy and every swapper marked taxExempt (the
    /// platform's distributor contracts) are exempt, the same as for the tax.
    ///
    /// Each launcher (V4TokenFactory, V4CustomTokenFactory, V4CurveFactory) has
    /// its OWN default below, set by that launcher's owner, so plain, custom-tax
    /// and curve launches can use different values. The launcher's default is
    /// SNAPSHOTTED into each pool when it is configured: changing it later
    /// affects only pools launched afterwards, so nobody can raise the
    /// surcharge on a pool that already trades.
    struct SnipeCfg {
        uint16 startBps;
        uint32 duration;
        uint64 start;
    }
    uint256 public constant MAX_SNIPE_START_BPS = 7000; // 70%
    uint256 public constant MAX_SNIPE_DURATION = 3600; // 1 hour
    struct SnipeDefault {
        uint16 startBps;
        uint32 duration;
    }
    mapping(address => SnipeDefault) public snipeDefaults; // launcher => the setting its next pools copy
    mapping(PoolId => SnipeCfg) public snipe;

    event FactorySet(address indexed factory);
    event TaxExemptSet(address indexed swapper, bool exempt);
    event SnipeDefaultsSet(address indexed launcher, uint256 startBps, uint256 duration);
    event SnipeConfigured(PoolId indexed poolId, uint256 startBps, uint256 duration, uint256 startsAt);
    event SnipeFeeCollected(PoolId indexed poolId, uint256 fee, uint256 snipeBps);
    event PoolConfigured(PoolId indexed poolId, address indexed token, address feeWallet, uint256 feeBps, uint256 graduationTargetUsd);
    event TaxCollected(PoolId indexed poolId, uint256 fee, uint256 toRewards, uint256 toCreator, uint256 toFeeWallet);
    event CustomTaxCollected(PoolId indexed poolId, uint256 reflection, uint256 marketing, uint256 liquidity, uint256 burned);
    event CustomFeesConfigured(PoolId indexed poolId, address indexed launcher);
    event LauncherSet(address indexed launcher, bool allowed);
    event LiquidityCompounderSet(address indexed compounder);
    event TaxDisabled(PoolId indexed poolId, uint256 marketCapInFeedDecimals);
    event GraduationCandidateObserved(PoolId indexed poolId, uint256 marketCapInFeedDecimals, uint256 confirmEligibleAt);
    event GraduationCandidateReset(PoolId indexed poolId);
    event PriceFeedUpdated(PoolId indexed poolId, address newPriceFeed, uint256 newMaxOracleStaleness);

    error NotPoolManager();
    error NotFactory();
    error InvalidHookAddress();
    error PoolInitNotByFactory();
    error InvalidPool();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    function isLauncher(address a) public view returns (bool) {
        return a != address(0) && (a == factory || launchers[a]);
    }

    modifier onlyLauncher() {
        if (!isLauncher(msg.sender)) revert NotFactory();
        _;
    }

    constructor(IPoolManager poolManager_, address deployer_) {
        // The address itself IS the permission set. Refuse to exist anywhere the
        // PoolManager would read a different one.
        if (uint160(address(this)) & Hooks.ALL_HOOK_MASK != REQUIRED_FLAGS) revert InvalidHookAddress();
        poolManager = poolManager_;
        deployer = deployer_;
    }

    /// @notice One-time wiring: the factory needs this hook's address in its
    /// constructor and this hook needs the factory's, so the hook is deployed
    /// first and told who the factory is afterwards. Callable once, by the
    /// deployer.
    function setFactory(address factory_) external {
        require(msg.sender == deployer, "V4TaxHook: not deployer");
        require(factory == address(0), "V4TaxHook: factory already set");
        require(factory_ != address(0), "V4TaxHook: invalid factory");
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Factory-only (the factory forwards its owner's decision).
    function setTaxExempt(address swapper, bool exempt) external onlyFactory {
        taxExempt[swapper] = exempt;
        emit TaxExemptSet(swapper, exempt);
    }

    /// @notice Launcher-only (each launcher forwards its owner's decision): the
    /// snipe surcharge every pool THIS launcher configures from now on will start
    /// with. Both values zero switches it off for the launcher's new pools. Pools
    /// already configured keep the values they were created with.
    function setSnipeDefaults(uint256 startBps, uint256 duration) external onlyLauncher {
        require(startBps <= MAX_SNIPE_START_BPS, "V4TaxHook: snipe start above 70%");
        require(duration <= MAX_SNIPE_DURATION, "V4TaxHook: snipe duration above 1 hour");
        require((startBps == 0) == (duration == 0), "V4TaxHook: snipe start and duration must both be set");
        snipeDefaults[msg.sender] = SnipeDefault(uint16(startBps), uint32(duration));
        emit SnipeDefaultsSet(msg.sender, startBps, duration);
    }

    /// @notice Deployer-only: allow (or stop allowing) an additional pool
    /// launcher. Revoking one does not touch pools it already configured.
    function setLauncher(address launcher, bool allowed) external {
        require(msg.sender == deployer, "V4TaxHook: not deployer");
        require(launcher != address(0), "V4TaxHook: invalid launcher");
        launchers[launcher] = allowed;
        emit LauncherSet(launcher, allowed);
    }

    /// @notice Deployer-only, once: the contract that receives the "liquidity"
    /// share of custom fees.
    function setLiquidityCompounder(address compounder) external {
        require(msg.sender == deployer, "V4TaxHook: not deployer");
        require(liquidityCompounder == address(0), "V4TaxHook: compounder already set");
        require(compounder != address(0), "V4TaxHook: invalid compounder");
        liquidityCompounder = compounder;
        emit LiquidityCompounderSet(compounder);
    }

    // ---------------------------------------------------------------
    // Pool configuration (launchers only)
    // ---------------------------------------------------------------

    /// @notice Snapshots a pool's tax settings. Called by the factory right
    /// after it initializes the pool; settings are fixed for that pool's life
    /// (apart from the price-feed escape hatch below), same "applies going
    /// forward only" convention as V2's configureTax.
    function configurePool(
        PoolKey calldata key,
        address feeWallet_,
        uint256 feeBps_,
        address priceFeed_,
        uint256 graduationTargetUsd_,
        uint256 maxOracleStaleness_,
        address rewardsDistributor_,
        uint256 rewardBps_,
        address creatorRewardsDistributor_,
        uint256 creatorRewardBps_,
        address feeWalletDistributor_
    ) external onlyLauncher {
        if (address(key.hooks) != address(this)) revert InvalidPool();
        if (!(Currency.unwrap(key.currency0) == address(0))) revert InvalidPool();
        PoolId id = key.toId();
        PoolTax storage p = poolTax[id];
        require(!p.configured, "V4TaxHook: pool already configured");

        require(feeBps_ <= MAX_FEE_BPS, "V4TaxHook: feeBps exceeds 20% ceiling");
        require(graduationTargetUsd_ > 0, "V4TaxHook: graduation target must be > 0");
        require(maxOracleStaleness_ > 0 && maxOracleStaleness_ <= type(uint32).max, "V4TaxHook: bad oracle staleness");
        require(priceFeed_.code.length > 0, "V4TaxHook: price feed is not a contract");
        require(rewardBps_ + creatorRewardBps_ <= feeBps_, "V4TaxHook: reward bps exceed feeBps");
        require(rewardsDistributor_ != address(0) || rewardBps_ == 0, "V4TaxHook: rewardBps requires a distributor");
        require(
            creatorRewardsDistributor_ != address(0) || creatorRewardBps_ == 0,
            "V4TaxHook: creatorRewardBps requires a distributor"
        );

        p.configured = true;
        poolLauncher[id] = msg.sender;
        p.token = Currency.unwrap(key.currency1);
        p.feeWallet = feeWallet_;
        p.feeBps = uint16(feeBps_);
        p.rewardBps = uint16(rewardBps_);
        p.creatorRewardBps = uint16(creatorRewardBps_);
        p.rewardsDistributor = rewardsDistributor_;
        p.creatorRewardsDistributor = creatorRewardsDistributor_;
        p.feeWalletDistributor = feeWalletDistributor_;
        p.priceFeed = V4IAggregatorV3(priceFeed_);
        p.maxOracleStaleness = uint32(maxOracleStaleness_);
        p.graduationTargetUsd = graduationTargetUsd_;
        p.taxActive = feeBps_ > 0 && feeWallet_ != address(0);

        emit PoolConfigured(id, p.token, feeWallet_, feeBps_, graduationTargetUsd_);

        // Snipe protection needs somewhere to send the fee, so a pool with no
        // fee wallet simply does not get it.
        SnipeDefault memory d = snipeDefaults[msg.sender];
        if (d.startBps > 0 && feeWallet_ != address(0)) {
            snipe[id] = SnipeCfg(d.startBps, d.duration, uint64(block.timestamp));
            emit SnipeConfigured(id, d.startBps, d.duration, block.timestamp);
        }
    }

    /// @notice Attaches a creator fee split to a pool this launcher just
    /// configured. Same call frame as pool creation, so no swap can happen
    /// before it. One-shot; the split is final.
    function configureCustomPool(PoolKey calldata key, CustomFees calldata f) external onlyLauncher {
        PoolId id = key.toId();
        require(poolTax[id].configured, "V4TaxHook: pool not configured");
        require(poolLauncher[id] == msg.sender, "V4TaxHook: not this pool's launcher");
        require(!hasCustomFees[id], "V4TaxHook: custom fees already set");
        uint256 buyTotal = uint256(f.buyReflectionBps) + f.buyMarketingBps + f.buyLiquidityBps + f.buyBurnBps;
        uint256 sellTotal = uint256(f.sellReflectionBps) + f.sellMarketingBps + f.sellLiquidityBps + f.sellBurnBps;
        require(buyTotal <= MAX_CUSTOM_SIDE_BPS, "V4TaxHook: buy fees exceed 5%");
        require(sellTotal <= MAX_CUSTOM_SIDE_BPS, "V4TaxHook: sell fees exceed 5%");
        if (f.buyLiquidityBps > 0 || f.sellLiquidityBps > 0) {
            require(liquidityCompounder != address(0), "V4TaxHook: liquidity compounder not set");
        }
        customFees[id] = f;
        hasCustomFees[id] = true;
        emit CustomFeesConfigured(id, msg.sender);
    }

    /// @notice Escape hatch for a dead price feed -- same rules as V2's
    /// LaunchedToken.updatePriceFeed: factory-only (which gates it behind its
    /// own owner) and ONLY allowed while the current feed cannot report a fresh
    /// price, so it can never be used to nudge a healthy token's graduation.
    function updatePriceFeed(PoolId id, address newPriceFeed_, uint256 newMaxOracleStaleness_) external onlyLauncher {
        PoolTax storage p = poolTax[id];
        require(p.configured, "V4TaxHook: pool not configured");
        require(poolLauncher[id] == msg.sender, "V4TaxHook: not this pool's launcher");
        require(newPriceFeed_ != address(0), "V4TaxHook: invalid price feed");
        require(newPriceFeed_.code.length > 0, "V4TaxHook: price feed is not a contract");
        require(newMaxOracleStaleness_ > 0 && newMaxOracleStaleness_ <= type(uint32).max, "V4TaxHook: bad oracle staleness");
        (, bool feedIsFresh) = currentMarketCapInFeedDecimals(id);
        require(!feedIsFresh, "V4TaxHook: current price feed is still fresh, cannot be repointed");
        p.priceFeed = V4IAggregatorV3(newPriceFeed_);
        p.maxOracleStaleness = uint32(newMaxOracleStaleness_);
        // A candidacy observed through the old feed says nothing about the new
        // one (different decimals / source): graduation must be re-observed.
        if (p.graduationCandidateAt != 0) {
            p.graduationCandidateAt = 0;
            emit GraduationCandidateReset(id);
        }
        emit PriceFeedUpdated(id, newPriceFeed_, newMaxOracleStaleness_);
    }

    // ---------------------------------------------------------------
    // Hook callbacks
    // ---------------------------------------------------------------

    /// @dev Only the factory may create a pool on this hook. The factory also
    /// asserts the (ETH, token) shape, so there is no way to attach this hook
    /// to a differently-shaped pool.
    function beforeInitialize(address sender, PoolKey calldata key, uint160) external view onlyPoolManager returns (bytes4) {
        if (!isLauncher(sender)) revert PoolInitNotByFactory();
        if (Currency.unwrap(key.currency0) != address(0)) revert InvalidPool();
        return IHooks.beforeInitialize.selector;
    }

    /// @notice The snipe surcharge, in bps, a non-exempt BUY of this pool would
    /// pay right now. Zero for unknown pools, pools launched without it, and
    /// once the window has passed. Front ends add it to the normal buy tax.
    function currentSnipeBps(PoolId id) public view returns (uint256) {
        SnipeCfg storage s = snipe[id];
        if (s.startBps == 0) return 0;
        uint256 elapsed = block.timestamp - s.start;
        if (elapsed >= s.duration) return 0;
        return (uint256(s.startBps) * (s.duration - elapsed)) / s.duration;
    }

    /// @dev The surcharge that applies to THIS swap: buys only, and not for
    /// launchers or tax-exempt swappers.
    function _snipeFor(PoolId id, address sender, bool isBuy) private view returns (uint256) {
        if (!isBuy || taxExempt[sender] || isLauncher(sender)) return 0;
        return currentSnipeBps(id);
    }

    /// @dev Total tax for one direction of one pool, split into the platform's
    /// part (switched off at graduation) and the creator's custom part (never
    /// switched off). A buy is zeroForOne (ETH in, token out).
    function _bps(PoolId id, PoolTax storage p, bool isBuy) private view returns (uint256 platformBps, uint256 customBps) {
        platformBps = p.taxActive ? p.feeBps : 0;
        if (hasCustomFees[id]) {
            CustomFees storage f = customFees[id];
            customBps = isBuy
                ? uint256(f.buyReflectionBps) + f.buyMarketingBps + f.buyLiquidityBps + f.buyBurnBps
                : uint256(f.sellReflectionBps) + f.sellMarketingBps + f.sellLiquidityBps + f.sellBurnBps;
        }
    }

    /// @dev Handles the two cases where the TOKEN is the specified currency:
    ///  - exact-in SELL  (token in,  amountSpecified < 0): fee = amt * bps / 1e4,
    ///    carved off the input so the pool swaps (amt - fee).
    ///  - exact-out BUY  (token out, amountSpecified > 0): fee = net * bps / (1e4 - bps),
    ///    added to the output the pool pays so the buyer still nets `net`.
    /// Both return +fee as the hook's specified-currency delta (a credit the
    /// hook then take()s). Every other case returns zero here and is handled
    /// in afterSwap, where the pool's computed token amount is known.
    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        PoolTax storage p = poolTax[id];
        bool exactIn = params.amountSpecified < 0;
        // token is currency1: specified iff !(specifiedIsCurrency0)
        bool tokenSpecified = exactIn != params.zeroForOne;
        if (tokenSpecified && !taxExempt[sender]) {
            (uint256 platformBps, uint256 customBps) = _bps(id, p, params.zeroForOne);
            uint256 snipeBps = _snipeFor(id, sender, params.zeroForOne);
            uint256 bps = platformBps + customBps + snipeBps;
            if (bps > 0) {
                uint256 fee;
                if (exactIn) {
                    // SELL exact-in
                    fee = (uint256(-params.amountSpecified) * bps) / 10_000;
                } else {
                    // BUY exact-out
                    fee = (uint256(params.amountSpecified) * bps) / (10_000 - bps);
                }
                fee = _affordable(p.token, fee);
                if (fee > 0) {
                    _distribute(id, p, fee, platformBps, customBps, snipeBps, params.zeroForOne);
                    return (IHooks.beforeSwap.selector, toBeforeSwapDelta(fee.toInt128(), 0), 0);
                }
            }
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDelta.wrap(0), 0);
    }

    /// @dev Handles the two cases where the token is the UNSPECIFIED currency:
    ///  - exact-in BUY   (ETH in, token out): fee = out * bps / 1e4
    ///  - exact-out SELL (ETH out, token in):  fee = in  * bps / (1e4 - bps)
    /// Returns +fee as the unspecified delta. Then runs the graduation check.
    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        PoolTax storage p = poolTax[id];
        bool exactIn = params.amountSpecified < 0;
        bool tokenUnspecified = (exactIn == params.zeroForOne);
        // The snipe surcharge applies even to a pool whose normal tax is off.
        uint256 snipeBps = tokenUnspecified ? _snipeFor(id, sender, params.zeroForOne) : 0;
        if (!p.taxActive && !hasCustomFees[id] && snipeBps == 0) return (IHooks.afterSwap.selector, 0);

        uint256 fee;
        if (tokenUnspecified && !taxExempt[sender]) {
            fee = _afterSwapFee(id, p, params.zeroForOne, exactIn, delta.amount1(), snipeBps);
        }

        if (p.taxActive) _maybeDisableTax(id, p);
        return (IHooks.afterSwap.selector, fee.toInt128());
    }

    function _afterSwapFee(PoolId id, PoolTax storage p, bool isBuy, bool exactIn, int128 tokenDelta, uint256 snipeBps)
        private
        returns (uint256 fee)
    {
        (uint256 platformBps, uint256 customBps) = _bps(id, p, isBuy);
        uint256 bps = platformBps + customBps + snipeBps;
        if (bps == 0) return 0;
        if (exactIn) {
            // BUY exact-in: the swapper receives tokenDelta > 0
            if (tokenDelta > 0) fee = (uint256(uint128(tokenDelta)) * bps) / 10_000;
        } else {
            // SELL exact-out: the swapper pays -tokenDelta
            if (tokenDelta < 0) fee = (uint256(uint128(-tokenDelta)) * bps) / (10_000 - bps);
        }
        fee = _affordable(p.token, fee);
        if (fee > 0) _distribute(id, p, fee, platformBps, customBps, snipeBps, isBuy);
    }

    // ---------------------------------------------------------------
    // Fee payout
    // ---------------------------------------------------------------

    /// @dev The fee is paid from the PoolManager's own token balance, so no more
    /// than that balance can be taken. On any realistic pool the balance is far
    /// larger than the fee. In the absurd edge (a sell many times larger than
    /// what is left in a nearly bought-out pool) the fee is CAPPED at what the
    /// manager holds instead of being skipped, so the swap neither reverts nor
    /// escapes the tax entirely.
    function _affordable(address token, uint256 fee) private view returns (uint256) {
        if (fee == 0) return 0;
        uint256 bal = IERC20(token).balanceOf(address(poolManager));
        return fee <= bal ? fee : bal;
    }

    /// @dev Splits `fee` (a token amount) between the platform's part and the
    /// creator's custom part in proportion to their bps, then pays each out of
    /// the PoolManager. take() books a debt against this hook which the swap's
    /// returned delta credits back at the end of the swap, netting to zero.
    function _distribute(
        PoolId id,
        PoolTax storage p,
        uint256 fee,
        uint256 platformBps,
        uint256 customBps,
        uint256 snipeBps,
        bool isBuy
    ) private {
        // The snipe surcharge is carved off first, in proportion to its bps;
        // what is left is split exactly as before. With no surcharge running
        // (snipeBps == 0) the arithmetic below is the original, unchanged.
        if (snipeBps > 0) {
            uint256 snipeFee = (platformBps + customBps == 0)
                ? fee
                : (fee * snipeBps) / (platformBps + customBps + snipeBps);
            fee -= snipeFee;
            if (snipeFee > 0) {
                poolManager.take(
                    Currency.wrap(p.token), p.feeWalletDistributor != address(0) ? p.feeWalletDistributor : p.feeWallet, snipeFee
                );
                emit SnipeFeeCollected(id, snipeFee, snipeBps);
            }
            if (fee == 0) return;
        }
        uint256 totalBps = platformBps + customBps;
        uint256 platformFee = customBps == 0 ? fee : (platformBps == 0 ? 0 : (fee * platformBps) / totalBps);
        uint256 customFee = fee - platformFee;
        // Creator part first: its reflection share must be booked before any
        // other token delivery changes who is eligible for it.
        if (customFee > 0) _distributeCustom(id, p, customFee, customBps, isBuy);
        if (platformFee > 0) _distributePlatform(id, p, platformFee, platformBps);
    }

    function _distributePlatform(PoolId id, PoolTax storage p, uint256 fee, uint256 platformBps) private {
        // Same split rule as V2: cuts are carved OUT OF the fee, derived from
        // the fee itself (not from a gross amount), so they can never add up to
        // more than the fee.
        uint256 rewardCut =
            (p.rewardsDistributor != address(0) && p.rewardBps > 0) ? (fee * p.rewardBps) / platformBps : 0;
        uint256 creatorCut = (p.creatorRewardsDistributor != address(0) && p.creatorRewardBps > 0)
            ? (fee * p.creatorRewardBps) / platformBps
            : 0;
        uint256 rest = fee - rewardCut - creatorCut;

        Currency token = Currency.wrap(p.token);
        if (rewardCut > 0) poolManager.take(token, p.rewardsDistributor, rewardCut);
        if (creatorCut > 0) poolManager.take(token, p.creatorRewardsDistributor, creatorCut);
        if (rest > 0) {
            poolManager.take(token, p.feeWalletDistributor != address(0) ? p.feeWalletDistributor : p.feeWallet, rest);
        }
        emit TaxCollected(id, fee, rewardCut, creatorCut, rest);
    }

    /// @dev The creator's part. Reflection -> the token itself (shared out to
    /// holders by the token), marketing -> the token's marketing wallet (burned
    /// if the creator has renounced it to nobody), liquidity -> the compounder,
    /// burn -> destroyed on the spot. Rounding dust goes to the first active
    /// component so the whole customFee is always spent.
    function _distributeCustom(PoolId id, PoolTax storage p, uint256 fee, uint256 customBps, bool isBuy) private {
        CustomFees storage f = customFees[id];
        uint256[4] memory bpsParts = isBuy
            ? [uint256(f.buyReflectionBps), f.buyMarketingBps, f.buyLiquidityBps, f.buyBurnBps]
            : [uint256(f.sellReflectionBps), f.sellMarketingBps, f.sellLiquidityBps, f.sellBurnBps];
        uint256[4] memory amt;
        uint256 spent;
        uint256 firstActive = 4;
        for (uint256 i = 0; i < 4; i++) {
            if (bpsParts[i] == 0) continue;
            if (firstActive == 4) firstActive = i;
            amt[i] = (fee * bpsParts[i]) / customBps;
            spent += amt[i];
        }
        amt[firstActive] += fee - spent;

        address token = p.token;
        Currency cur = Currency.wrap(token);
        if (amt[0] > 0) {
            poolManager.take(cur, token, amt[0]);
            IV4CustomTokenHooked(token).notifyReflection(amt[0]);
        }
        uint256 burnAmt = amt[3];
        if (amt[1] > 0) {
            address wallet = IV4CustomTokenHooked(token).marketingWallet();
            if (wallet == address(0)) burnAmt += amt[1];
            else poolManager.take(cur, wallet, amt[1]);
        }
        if (amt[2] > 0) poolManager.take(cur, liquidityCompounder, amt[2]);
        if (burnAmt > 0) {
            poolManager.take(cur, address(this), burnAmt);
            IV4CustomTokenHooked(token).burn(burnAmt);
        }
        emit CustomTaxCollected(id, amt[0], amt[1], amt[2], burnAmt);
    }

    // ---------------------------------------------------------------
    // Graduation (ported from V2 LaunchedToken, reading V4 pool price)
    // ---------------------------------------------------------------

    /// @notice Current market cap in the feed's own decimals, or (0, false) if
    /// the pool/feed can't be read or the feed is stale. Never reverts, whatever
    /// the feed address is or returns (no code, empty / short / malformed data,
    /// gas burning): the feed is read with bounded-gas raw staticcalls and the
    /// reply is length-checked, because a Solidity try/catch does NOT catch a
    /// failure to decode a malformed reply or a call to an address without code.
    function currentMarketCapInFeedDecimals(PoolId id) public view returns (uint256 marketCap, bool feedIsFresh) {
        PoolTax storage p = poolTax[id];
        if (!p.configured) return (0, false);
        (bool ok, int256 answer, uint256 updatedAt) = _readLatestRound(address(p.priceFeed));
        if (!ok || answer <= 0) return (0, false);
        // Future-dated rounds are treated as stale: an underflow below would
        // revert and brick trading.
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > p.maxOracleStaleness) return (0, false);
        try this._computeMarketCap(id, uint256(answer)) returns (uint256 mc, bool computed) {
            if (!computed) return (0, false);
            return (mc, true);
        } catch {
            return (0, false);
        }
    }

    /// @dev latestRoundData() via a raw staticcall: gas-capped, and only the
    /// first 160 bytes of the reply are ever copied. ok=false on no code,
    /// revert, or a reply shorter than five words.
    function _readLatestRound(address feed) private view returns (bool ok, int256 answer, uint256 updatedAt) {
        if (feed.code.length == 0) return (false, 0, 0);
        bytes4 sel = V4IAggregatorV3.latestRoundData.selector;
        uint256 callGas = FEED_CALL_GAS;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, sel)
            ok := staticcall(callGas, feed, m, 4, m, 160)
            if lt(returndatasize(), 160) { ok := 0 }
            if ok {
                answer := mload(add(m, 32))
                updatedAt := mload(add(m, 96))
            }
        }
    }

    /// @dev decimals() via a raw staticcall, same protections. Anything that is
    /// not a clean small number (<= MAX_FEED_DECIMALS) counts as a dead feed.
    function _readDecimals(address feed) private view returns (bool ok, uint256 decimals_) {
        if (feed.code.length == 0) return (false, 0);
        bytes4 sel = V4IAggregatorV3.decimals.selector;
        uint256 callGas = FEED_CALL_GAS;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, sel)
            ok := staticcall(callGas, feed, m, 4, m, 32)
            if lt(returndatasize(), 32) { ok := 0 }
            if ok { decimals_ := mload(m) }
        }
        if (ok && decimals_ > MAX_FEED_DECIMALS) ok = false;
    }

    /// @dev External only so the caller can try/catch it (it is trusted code: pool manager and token reads). Reads the pool's live
    /// sqrt price and converts it to a USD market cap.
    function _computeMarketCap(PoolId id, uint256 ethUsd) external view returns (uint256 marketCap, bool ok) {
        require(msg.sender == address(this), "V4TaxHook: internal only");
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
        if (sqrtPriceX96 == 0) return (0, false);
        // price (token per wei of ETH) in Q128 = sqrtP^2 / 2^64
        uint256 priceX128 = FullMath.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), 1 << 64);
        if (priceX128 == 0) return (0, false);
        // wei of ETH per whole (1e18) token
        uint256 pricePerTokenWei = FullMath.mulDiv(1e18, 1 << 128, priceX128);
        uint256 usdPerToken = (pricePerTokenWei * ethUsd) / 1e18;
        marketCap = (usdPerToken * IERC20(poolTax[id].token).totalSupply()) / 1e18;
        ok = true;
    }

    function _maybeDisableTax(PoolId id, PoolTax storage p) private {
        (uint256 marketCap, bool feedIsFresh) = currentMarketCapInFeedDecimals(id);
        if (!feedIsFresh) return; // oracle hiccup: leave any in-progress candidacy as it was

        (bool decimalsOk, uint256 feedDecimals) = _readDecimals(address(p.priceFeed));
        if (!decimalsOk) return;

        // feedDecimals <= 36 and graduationTargetUsd is bounded by what a
        // launcher configured; use checked math but in a form that cannot
        // overflow for any sane target, and skip (never revert) if it would.
        (bool mulOk, uint256 target) = _tryMul(p.graduationTargetUsd, 10 ** feedDecimals);
        if (!mulOk) return;
        if (marketCap < target) {
            if (p.graduationCandidateAt != 0) {
                p.graduationCandidateAt = 0;
                emit GraduationCandidateReset(id);
            }
            return;
        }
        if (p.graduationCandidateAt == 0) {
            p.graduationCandidateAt = uint64(block.timestamp);
            emit GraduationCandidateObserved(id, marketCap, block.timestamp + GRADUATION_CONFIRMATION_WINDOW);
            return;
        }
        if (block.timestamp < uint256(p.graduationCandidateAt) + GRADUATION_CONFIRMATION_WINDOW) return;
        p.taxActive = false;
        emit TaxDisabled(id, marketCap);
    }

    function _tryMul(uint256 a, uint256 b) private pure returns (bool, uint256) {
        unchecked {
            if (a == 0) return (true, 0);
            uint256 c = a * b;
            if (c / a != b) return (false, 0);
            return (true, c);
        }
    }
}
