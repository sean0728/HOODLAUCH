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

/// @dev ETH intake on the platform distributors that the hook pays into.
interface IV4CreatorDeposit {
    function depositFor(address token) external payable;
}

interface IV4FeeDeposit {
    function depositFee() external payable;
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
/// WHERE EACH FEE IS TAKEN. The platform tax, the anti-snipe surcharge and a
/// custom token's marketing share are taken in ETH, from the ETH leg of the
/// swap, so collecting them never puts a sell on the chart. A custom token's
/// reflection / liquidity / burn shares are inherently tokens and are taken from
/// the token leg. Which hook callback has to carry a leg's fee depends on
/// whether that leg is the "specified" side of the swap (the side the trader
/// fixed) or the "unspecified" side (the side the pool computed):
///
///   specified leg   -> beforeSwap return delta
///   unspecified leg -> afterSwap  return delta
///
/// A fee on the specified leg is fixed before the pool has run, so it is
/// charged on the amount the trader REQUESTED. If a price limit then stops the
/// swap early, that fee would be far larger than its rate on what was filled;
/// the hook therefore refuses such a swap (PartialFillNotAllowed) instead of
/// overcharging it. The platform's own routers and factories always swap with
/// the widest limits, so they never meet this.
///
/// Fees are exactly the configured share of the gross amount moved (so a 1% tax
/// means a buyer pays 1% of the total). The platform tax is booked per pool and
/// paid by flush(): rewardBps to rewardsDistributor, creatorRewardBps to
/// creatorRewardsDistributor, and the remainder to feeWalletDistributor if set,
/// otherwise straight to feeWallet. Each destination is paid on its own, so one
/// that cannot take ETH only holds back its own share.
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
    /// minute later pays little or nothing. It is taken in ETH, from the ETH
    /// leg, exactly like the platform tax, and goes to the platform fee wallet
    /// (or the fee-wallet distributor) of the pool. Sells are never charged.
    ///
    /// The launcher's own seeding buy and every swapper marked taxExempt (the
    /// platform's distributor contracts) are exempt from the surcharge. (A
    /// launcher's seeding buy still pays the platform tax; only the exempt
    /// swappers skip that too.)
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
    error PartialFillNotAllowed();

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
    /// LaunchedToken.updatePriceFeed: only the launcher that configured the pool
    /// (which gates it behind its own owner) and ONLY while the current feed
    /// cannot report a fresh price, so it can never be used to nudge a healthy
    /// token's graduation. It does not need the launcher to still be on the
    /// allowed list: revoking a launcher leaves its existing pools manageable.
    function updatePriceFeed(PoolId id, address newPriceFeed_, uint256 newMaxOracleStaleness_) external {
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

    // ---------------------------------------------------------------
    // Swap callbacks: where each fee is taken
    // ---------------------------------------------------------------
    //
    // The platform's trading tax, the anti-snipe surcharge and a custom token's
    // MARKETING share are all taken in ETH, from the ETH leg of the swap. That
    // means nothing ever has to be sold afterwards, so collecting fees puts no
    // sell on the chart. A custom token's reflection / liquidity / burn shares
    // are inherently in the token (holders get tokens, LP needs tokens, burn
    // destroys tokens) and are still taken from the token leg.
    //
    // Exactly one of the two currencies is the "specified" one in any swap
    // (the side the trader fixed), the other is "unspecified" (computed by the
    // pool). beforeSwap can only carry a fee on the specified currency and
    // afterSwap only on the unspecified one, so each leg is handled by
    // whichever callback matches it:
    //
    //            ETH leg                          token leg
    //   buy  exact-in   beforeSwap (specified)    afterSwap (unspecified)
    //   buy  exact-out  afterSwap  (unspecified)  beforeSwap (specified)
    //   sell exact-in   afterSwap  (unspecified)  beforeSwap (specified)
    //   sell exact-out  beforeSwap (specified)    afterSwap  (unspecified)

    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (!taxExempt[sender]) {
            PoolId id = key.toId();
            PoolTax storage p = poolTax[id];
            bool exactIn = params.amountSpecified < 0;
            // token is currency1, ETH is currency0
            bool tokenSpecified = exactIn != params.zeroForOne;
            uint256 amt = exactIn ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
            uint256 fee = tokenSpecified
                ? _tokenLegFee(id, p, params.zeroForOne, exactIn, amt)
                : _ethLegFee(id, p, sender, params.zeroForOne, exactIn, amt);
            if (fee > 0) return (IHooks.beforeSwap.selector, toBeforeSwapDelta(fee.toInt128(), 0), 0);
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDelta.wrap(0), 0);
    }

    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        PoolTax storage p = poolTax[id];
        uint256 fee;
        if (!taxExempt[sender]) {
            bool exactIn = params.amountSpecified < 0;
            // exact-in buy / exact-out sell leave the token unspecified, the others leave ETH unspecified
            bool tokenUnspecified = (exactIn == params.zeroForOne);
            // A fee on the SPECIFIED leg was fixed in beforeSwap, on the amount requested. If a price limit stopped the swap
            // short, that fee is out of proportion to what was filled, so such a swap is refused instead of overcharged.
            if (_specifiedLegHasFee(id, p, sender, params.zeroForOne, tokenUnspecified)) {
                (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
                if (sqrtPriceX96 == params.sqrtPriceLimitX96) revert PartialFillNotAllowed();
            }
            int128 d = tokenUnspecified ? delta.amount1() : delta.amount0();
            // unspecified amount the pool computed: received by the swapper when positive, paid when negative
            uint256 amt;
            if (exactIn) {
                if (d > 0) amt = uint256(uint128(d));
            } else {
                if (d < 0) amt = uint256(uint128(-d));
            }
            if (amt > 0) {
                fee = tokenUnspecified
                    ? _tokenLegFee(id, p, params.zeroForOne, exactIn, amt)
                    : _ethLegFee(id, p, sender, params.zeroForOne, exactIn, amt);
            }
        }
        if (p.taxActive) _maybeDisableTax(id, p);
        return (IHooks.afterSwap.selector, fee.toInt128());
    }

    /// @dev fee = bps of the gross amount moved: for an exact-in leg that is
    /// amt * bps / 1e4 (carved off what comes in / goes out); for an exact-out
    /// leg the fee is added on top, amt * bps / (1e4 - bps), so it is bps of the
    /// total the trader ends up paying or giving up.
    function _feeOn(uint256 amt, uint256 bps, bool exactIn) private pure returns (uint256) {
        return exactIn ? (amt * bps) / 10_000 : (amt * bps) / (10_000 - bps);
    }

    /// @dev ETH leg: platform tax (while active) + snipe surcharge (buys) +
    /// the custom token's marketing share. Taken from the pool manager as ETH
    /// into this hook and booked per pool until flush().
    function _ethLegFee(PoolId id, PoolTax storage p, address sender, bool isBuy, bool exactIn, uint256 amt)
        private
        returns (uint256 fee)
    {
        (uint256 platformBps, uint256 snipeBps, uint256 marketingBps) = _ethLegBps(id, p, sender, isBuy);
        uint256 bps = platformBps + snipeBps + marketingBps;
        if (bps == 0) return 0;
        fee = _feeOn(amt, bps, exactIn);
        // the fee is paid from the pool manager's own ETH; cap it at what it holds instead of reverting
        uint256 bal = address(poolManager).balance;
        if (fee > bal) fee = bal;
        if (fee == 0) return 0;

        // Split the fee in proportion to its parts; rounding dust goes to the first part that is active.
        uint256 marketingFee = (fee * marketingBps) / bps;
        uint256 snipeFee = (fee * snipeBps) / bps;
        uint256 platformFee = (fee * platformBps) / bps;
        uint256 dust = fee - marketingFee - snipeFee - platformFee;
        if (platformBps > 0) platformFee += dust;
        else if (marketingBps > 0) marketingFee += dust;
        else snipeFee += dust;

        poolManager.take(Currency.wrap(address(0)), address(this), fee);
        Accrued storage a = accrued[id];
        a.platform = _sat80(uint256(a.platform) + platformFee);
        a.snipe = _sat80(uint256(a.snipe) + snipeFee);
        a.marketing = _sat80(uint256(a.marketing) + marketingFee);
        emit EthFeeAccrued(id, platformFee, snipeFee, marketingFee);
        if (snipeFee > 0) emit SnipeFeeCollected(id, snipeFee, snipeBps);
    }

    /// @dev The three ETH-leg rates that apply to this swap right now.
    function _ethLegBps(PoolId id, PoolTax storage p, address sender, bool isBuy)
        private
        view
        returns (uint256 platformBps, uint256 snipeBps, uint256 marketingBps)
    {
        platformBps = p.taxActive ? p.feeBps : 0;
        snipeBps = _snipeFor(id, sender, isBuy);
        if (hasCustomFees[id]) {
            CustomFees storage f = customFees[id];
            marketingBps = isBuy ? f.buyMarketingBps : f.sellMarketingBps;
        }
    }

    /// @dev The token-leg rate (reflection + liquidity + burn) that applies to this swap.
    function _tokenLegBps(PoolId id, bool isBuy) private view returns (uint256 bps) {
        if (!hasCustomFees[id]) return 0;
        CustomFees storage f = customFees[id];
        bps = isBuy
            ? uint256(f.buyReflectionBps) + f.buyLiquidityBps + f.buyBurnBps
            : uint256(f.sellReflectionBps) + f.sellLiquidityBps + f.sellBurnBps;
    }

    /// @dev Whether beforeSwap charges anything on the specified leg of this swap: the ETH leg when the token is the
    /// unspecified one, the token leg otherwise.
    function _specifiedLegHasFee(PoolId id, PoolTax storage p, address sender, bool isBuy, bool tokenUnspecified)
        private
        view
        returns (bool)
    {
        if (tokenUnspecified) {
            (uint256 a, uint256 b, uint256 c) = _ethLegBps(id, p, sender, isBuy);
            return a + b + c > 0;
        }
        return _tokenLegBps(id, isBuy) > 0;
    }

    function _sat80(uint256 v) private pure returns (uint80) {
        return v > type(uint80).max ? type(uint80).max : uint80(v);
    }

    /// @dev Token leg: a custom token's reflection / liquidity / burn shares.
    /// Plain (non-custom) pools have none, so they return zero here.
    function _tokenLegFee(PoolId id, PoolTax storage p, bool isBuy, bool exactIn, uint256 amt)
        private
        returns (uint256 fee)
    {
        uint256 bps = _tokenLegBps(id, isBuy);
        if (bps == 0) return 0;
        fee = _feeOn(amt, bps, exactIn);
        // paid from the pool manager's own token balance: cap rather than revert (absurd edge only)
        uint256 bal = IERC20(p.token).balanceOf(address(poolManager));
        if (fee > bal) fee = bal;
        if (fee > 0) _distributeCustomToken(id, p, fee, isBuy);
    }

    /// @dev Reflection -> the token itself (shared out to holders by the token),
    /// liquidity -> the compounder, burn -> destroyed on the spot. Rounding dust
    /// goes to the first active component so the whole fee is always spent.
    function _distributeCustomToken(PoolId id, PoolTax storage p, uint256 fee, bool isBuy) private {
        CustomFees storage f = customFees[id];
        uint256[3] memory bpsParts = isBuy
            ? [uint256(f.buyReflectionBps), f.buyLiquidityBps, f.buyBurnBps]
            : [uint256(f.sellReflectionBps), f.sellLiquidityBps, f.sellBurnBps];
        uint256 totalBps = bpsParts[0] + bpsParts[1] + bpsParts[2];
        uint256[3] memory amt;
        uint256 spent;
        uint256 firstActive = 3;
        for (uint256 i = 0; i < 3; i++) {
            if (bpsParts[i] == 0) continue;
            if (firstActive == 3) firstActive = i;
            amt[i] = (fee * bpsParts[i]) / totalBps;
            spent += amt[i];
        }
        amt[firstActive] += fee - spent;

        address token = p.token;
        Currency cur = Currency.wrap(token);
        if (amt[0] > 0) {
            poolManager.take(cur, token, amt[0]);
            IV4CustomTokenHooked(token).notifyReflection(amt[0]);
        }
        if (amt[1] > 0) poolManager.take(cur, liquidityCompounder, amt[1]);
        if (amt[2] > 0) {
            poolManager.take(cur, address(this), amt[2]);
            IV4CustomTokenHooked(token).burn(amt[2]);
        }
        // marketing is taken in ETH now (see EthFeeAccrued), so the token-side marketing figure is always zero
        emit CustomTaxCollected(id, amt[0], 0, amt[1], amt[2]);
    }

    // ---------------------------------------------------------------
    // Paying out the accrued ETH
    // ---------------------------------------------------------------

    /// @notice ETH taken from swaps and not yet paid out, per pool. 80 bits each
    /// (over a million ETH), packed into one storage slot so a swap pays for a
    /// single storage write.
    struct Accrued {
        uint80 platform;  // the platform tax: split at payout into rewards / creator / fee wallet
        uint80 snipe;     // anti-snipe surcharge: all to the fee wallet side
        uint80 marketing; // a custom token's marketing share: to its marketing wallet
    }
    mapping(PoolId => Accrued) public accrued;

    /// @dev Gas given to the marketing wallet (an arbitrary address the creator
    /// chose) and to the platform's own destinations on payout.
    uint256 public constant FLUSH_CALL_GAS = 150_000;
    bool private _flushing;

    event EthFeeAccrued(PoolId indexed poolId, uint256 platform, uint256 snipe, uint256 marketing);
    event MarketingPaid(PoolId indexed poolId, address indexed wallet, uint256 amount);
    event FlushFailed(PoolId indexed poolId, bool platformPart, bool marketingPart);

    /// @notice Parts of earlier payouts that a destination refused, kept per
    /// destination so each is retried on its own. `rewards` / `creator` are owed to
    /// the pool's rewards / creator-rewards distributor, `feeSide` to its fee
    /// wallet side (fee-wallet distributor or fee wallet). Almost always zero.
    struct Owed {
        uint80 rewards;
        uint80 creator;
        uint80 feeSide;
    }
    mapping(PoolId => Owed) public owed;

    /// @notice The ETH `flush` would pay out for this pool right now.
    function pendingEth(PoolId id) external view returns (uint256) {
        Accrued storage a = accrued[id];
        Owed storage o = owed[id];
        return uint256(a.platform) + a.snipe + a.marketing + o.rewards + o.creator + o.feeSide;
    }

    /// @notice Pays this pool's accrued ETH to its destinations. Anyone may call
    /// it (the destinations are fixed by the pool's configuration, nothing a
    /// caller chooses), and nothing here touches a price, so there is nothing to
    /// manipulate. The relayer does this on a timer.
    ///
    /// Every destination is paid on its own. A part that cannot be delivered (a
    /// marketing wallet that refuses ETH, a distributor that reverts) is put back
    /// under its own heading and retried on the next call; it never reverts the
    /// call, never holds back the other destinations, and never affects trading,
    /// which does not call this at all.
    function flush(PoolId id) public {
        require(!_flushing, "V4TaxHook: flush in progress");
        _flushing = true;
        Accrued memory a = accrued[id];
        Owed memory o = owed[id];
        if (a.platform == 0 && a.snipe == 0 && a.marketing == 0 && o.rewards == 0 && o.creator == 0 && o.feeSide == 0) {
            _flushing = false;
            return;
        }
        delete accrued[id];
        delete owed[id];
        PoolTax storage p = poolTax[id];

        // Marketing: to the token's CURRENT marketing wallet. If the creator renounced it (zero address) there is nobody
        // to pay, so it goes to the platform side like the snipe surcharge does.
        uint256 toFeeSide = uint256(a.snipe) + o.feeSide;
        uint256 marketingOwed = a.marketing;
        bool marketingFailed;
        if (marketingOwed > 0) {
            address wallet = _marketingWalletOf(p.token);
            if (wallet == address(0)) {
                toFeeSide += marketingOwed;
                marketingOwed = 0;
            } else if (_pay(wallet, marketingOwed, "")) {
                emit MarketingPaid(id, wallet, marketingOwed);
            } else {
                marketingFailed = true;
            }
        }

        uint256 failedRewards;
        uint256 failedCreator;
        uint256 failedFeeSide;
        bool platformCallFailed;
        if (a.platform > 0 || toFeeSide > 0 || o.rewards > 0 || o.creator > 0) {
            try this.payPlatform(id, a.platform, toFeeSide, o.rewards, o.creator) returns (uint256 fr, uint256 fc, uint256 ff) {
                failedRewards = fr;
                failedCreator = fc;
                failedFeeSide = ff;
            } catch {
                platformCallFailed = true;
            }
        }

        // re-book anything that could not be delivered
        if (platformCallFailed || failedRewards > 0 || failedCreator > 0 || failedFeeSide > 0 || marketingFailed) {
            Accrued storage s = accrued[id];
            Owed storage so = owed[id];
            if (platformCallFailed) {
                // the payout itself aborted (out of gas, say): nothing was delivered, put every bucket back as it was
                s.platform = _sat80(uint256(s.platform) + a.platform);
                s.snipe = _sat80(uint256(s.snipe) + a.snipe);
                if (toFeeSide > uint256(a.snipe) + o.feeSide) {
                    s.marketing = _sat80(uint256(s.marketing) + (toFeeSide - a.snipe - o.feeSide)); // renounced marketing amount
                }
                so.rewards = _sat80(uint256(so.rewards) + o.rewards);
                so.creator = _sat80(uint256(so.creator) + o.creator);
                so.feeSide = _sat80(uint256(so.feeSide) + o.feeSide);
            } else {
                so.rewards = _sat80(uint256(so.rewards) + failedRewards);
                so.creator = _sat80(uint256(so.creator) + failedCreator);
                so.feeSide = _sat80(uint256(so.feeSide) + failedFeeSide);
            }
            if (marketingFailed) s.marketing = _sat80(uint256(s.marketing) + marketingOwed);
            emit FlushFailed(id, platformCallFailed || failedRewards > 0 || failedCreator > 0 || failedFeeSide > 0, marketingFailed);
        }
        _flushing = false;
    }

    function flushMany(PoolId[] calldata ids) external {
        for (uint256 i = 0; i < ids.length; i++) flush(ids[i]);
    }

    /// @dev The platform's part of a payout. External only so flush can try/catch it; callable only by this contract.
    /// `platformFee` is split with the pool's snapshotted reward / creator ratios; `extra` (snipe surcharge, a renounced
    /// marketing share, and anything the fee side refused before) all goes to the fee wallet side; `retryRewards` /
    /// `retryCreator` are what those two destinations refused before. Each destination is paid separately and a refusal
    /// is reported in the return values (amounts NOT delivered) instead of reverting, so one broken destination never
    /// holds back the others.
    function payPlatform(PoolId id, uint256 platformFee, uint256 extra, uint256 retryRewards, uint256 retryCreator)
        external
        returns (uint256 failedRewards, uint256 failedCreator, uint256 failedFeeSide)
    {
        require(msg.sender == address(this), "V4TaxHook: internal only");
        PoolTax storage p = poolTax[id];
        uint256 rewardCut;
        uint256 creatorCut;
        if (platformFee > 0 && p.feeBps > 0) {
            if (p.rewardsDistributor != address(0) && p.rewardBps > 0) rewardCut = (platformFee * p.rewardBps) / p.feeBps;
            if (p.creatorRewardsDistributor != address(0) && p.creatorRewardBps > 0) {
                creatorCut = (platformFee * p.creatorRewardBps) / p.feeBps;
            }
        }
        uint256 rest = platformFee - rewardCut - creatorCut + extra;
        rewardCut += retryRewards;
        creatorCut += retryCreator;

        uint256 paidRewards;
        uint256 paidCreator;
        uint256 paidRest;
        if (rewardCut > 0) {
            if (_pay(p.rewardsDistributor, rewardCut, "")) paidRewards = rewardCut;
            else failedRewards = rewardCut;
        }
        if (creatorCut > 0) {
            if (_pay(p.creatorRewardsDistributor, creatorCut, abi.encodeCall(IV4CreatorDeposit.depositFor, (p.token)))) {
                paidCreator = creatorCut;
            } else {
                failedCreator = creatorCut;
            }
        }
        if (rest > 0) {
            bool ok = p.feeWalletDistributor != address(0)
                ? _pay(p.feeWalletDistributor, rest, abi.encodeCall(IV4FeeDeposit.depositFee, ()))
                : _pay(p.feeWallet, rest, "");
            if (ok) paidRest = rest;
            else failedFeeSide = rest;
        }
        if (paidRewards + paidCreator + paidRest > 0) emit TaxCollected(id, paidRewards + paidCreator + paidRest, paidRewards, paidCreator, paidRest);
    }

    /// @dev Sends ETH (and optionally calldata) to `to` with at most FLUSH_CALL_GAS and reports success. The reply is never
    /// copied, so a destination answering with megabytes costs nothing extra; a zero address (which would just burn the
    /// ETH) or, when calldata is given, an address with no code counts as a failure.
    function _pay(address to, uint256 value, bytes memory data) private returns (bool ok) {
        if (to == address(0)) return false;
        if (data.length > 0 && to.code.length == 0) return false;
        uint256 callGas = FLUSH_CALL_GAS;
        assembly ("memory-safe") {
            ok := call(callGas, to, value, add(data, 32), mload(data), 0, 0)
        }
    }

    /// @dev The token's current marketing wallet, read with a gas-capped staticcall that copies only the first word.
    function _marketingWalletOf(address token) private view returns (address w) {
        bytes4 sel = IV4CustomTokenHooked.marketingWallet.selector;
        bool ok;
        uint256 raw;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, sel)
            ok := staticcall(50000, token, m, 4, m, 32)
            if lt(returndatasize(), 32) { ok := 0 }
            if ok { raw := mload(m) }
        }
        if (ok && raw <= type(uint160).max) w = address(uint160(raw));
    }

    /// @dev ETH only ever arrives here from the pool manager (taking a swap fee).
    receive() external payable {
        require(msg.sender == address(poolManager), "V4TaxHook: ETH only from the pool manager");
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
        // ETH value of the WHOLE supply in wei = supply / (tokens per wei) = supply * 2^128 / priceX128, computed in one
        // step so nothing is rounded to zero before the supply is multiplied in; then converted to USD in one more step.
        uint256 valueWei = FullMath.mulDiv(IERC20(poolTax[id].token).totalSupply(), 1 << 128, priceX128);
        marketCap = FullMath.mulDiv(valueWei, ethUsd, 1e18);
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
