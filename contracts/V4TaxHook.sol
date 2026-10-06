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

    IPoolManager public immutable poolManager;
    /// @notice Deployer; may call setFactory exactly once.
    address public immutable deployer;
    /// @notice The V4TokenFactory: the only address allowed to initialize a
    /// pool on this hook or to configure one. Set once.
    address public factory;

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

    event FactorySet(address indexed factory);
    event TaxExemptSet(address indexed swapper, bool exempt);
    event PoolConfigured(PoolId indexed poolId, address indexed token, address feeWallet, uint256 feeBps, uint256 graduationTargetUsd);
    event TaxCollected(PoolId indexed poolId, uint256 fee, uint256 toRewards, uint256 toCreator, uint256 toFeeWallet);
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

    // ---------------------------------------------------------------
    // Pool configuration (factory only)
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
    ) external onlyFactory {
        if (address(key.hooks) != address(this)) revert InvalidPool();
        if (!(Currency.unwrap(key.currency0) == address(0))) revert InvalidPool();
        PoolId id = key.toId();
        PoolTax storage p = poolTax[id];
        require(!p.configured, "V4TaxHook: pool already configured");

        require(feeBps_ <= MAX_FEE_BPS, "V4TaxHook: feeBps exceeds 20% ceiling");
        require(graduationTargetUsd_ > 0, "V4TaxHook: graduation target must be > 0");
        require(maxOracleStaleness_ > 0 && maxOracleStaleness_ <= type(uint32).max, "V4TaxHook: bad oracle staleness");
        require(rewardBps_ + creatorRewardBps_ <= feeBps_, "V4TaxHook: reward bps exceed feeBps");
        require(rewardsDistributor_ != address(0) || rewardBps_ == 0, "V4TaxHook: rewardBps requires a distributor");
        require(
            creatorRewardsDistributor_ != address(0) || creatorRewardBps_ == 0,
            "V4TaxHook: creatorRewardBps requires a distributor"
        );

        p.configured = true;
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
    }

    /// @notice Escape hatch for a dead price feed -- same rules as V2's
    /// LaunchedToken.updatePriceFeed: factory-only (which gates it behind its
    /// own owner) and ONLY allowed while the current feed cannot report a fresh
    /// price, so it can never be used to nudge a healthy token's graduation.
    function updatePriceFeed(PoolId id, address newPriceFeed_, uint256 newMaxOracleStaleness_) external onlyFactory {
        PoolTax storage p = poolTax[id];
        require(p.configured, "V4TaxHook: pool not configured");
        require(newPriceFeed_ != address(0), "V4TaxHook: invalid price feed");
        require(newMaxOracleStaleness_ > 0 && newMaxOracleStaleness_ <= type(uint32).max, "V4TaxHook: bad oracle staleness");
        (, bool feedIsFresh) = currentMarketCapInFeedDecimals(id);
        require(!feedIsFresh, "V4TaxHook: current price feed is still fresh, cannot be repointed");
        p.priceFeed = V4IAggregatorV3(newPriceFeed_);
        p.maxOracleStaleness = uint32(newMaxOracleStaleness_);
        emit PriceFeedUpdated(id, newPriceFeed_, newMaxOracleStaleness_);
    }

    // ---------------------------------------------------------------
    // Hook callbacks
    // ---------------------------------------------------------------

    /// @dev Only the factory may create a pool on this hook. The factory also
    /// asserts the (ETH, token) shape, so there is no way to attach this hook
    /// to a differently-shaped pool.
    function beforeInitialize(address sender, PoolKey calldata key, uint160) external view onlyPoolManager returns (bytes4) {
        if (sender != factory || factory == address(0)) revert PoolInitNotByFactory();
        if (Currency.unwrap(key.currency0) != address(0)) revert InvalidPool();
        return IHooks.beforeInitialize.selector;
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
        PoolTax storage p = poolTax[key.toId()];
        if (p.taxActive && !taxExempt[sender]) {
            bool exactIn = params.amountSpecified < 0;
            // token is currency1: specified iff !(specifiedIsCurrency0)
            bool tokenSpecified = (exactIn == params.zeroForOne) ? false : true;
            if (tokenSpecified) {
                uint256 fee;
                if (exactIn) {
                    // SELL exact-in
                    fee = (uint256(-params.amountSpecified) * p.feeBps) / 10_000;
                } else {
                    // BUY exact-out
                    fee = (uint256(params.amountSpecified) * p.feeBps) / (10_000 - p.feeBps);
                }
                fee = _affordable(p.token, fee);
                if (fee > 0) {
                    _distribute(key.toId(), p, fee);
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
        if (!p.taxActive) return (IHooks.afterSwap.selector, 0);

        bool exactIn = params.amountSpecified < 0;
        bool tokenUnspecified = (exactIn == params.zeroForOne);
        uint256 fee;
        if (tokenUnspecified && !taxExempt[sender]) {
            int128 tokenDelta = delta.amount1();
            if (exactIn) {
                // BUY exact-in: the swapper receives tokenDelta > 0
                if (tokenDelta > 0) fee = (uint256(uint128(tokenDelta)) * p.feeBps) / 10_000;
            } else {
                // SELL exact-out: the swapper pays -tokenDelta
                if (tokenDelta < 0) fee = (uint256(uint128(-tokenDelta)) * p.feeBps) / (10_000 - p.feeBps);
            }
            fee = _affordable(p.token, fee);
            if (fee > 0) _distribute(id, p, fee);
        }

        _maybeDisableTax(id, p);
        return (IHooks.afterSwap.selector, fee.toInt128());
    }

    // ---------------------------------------------------------------
    // Fee payout
    // ---------------------------------------------------------------

    /// @dev The fee is paid from the PoolManager's own token balance, so it can
    /// only be taken if the manager actually holds that much right now. On any
    /// realistic pool it always does; this guards the absurd edge (a sell larger
    /// than what is left in a nearly bought-out pool) by simply not taxing that
    /// one swap rather than reverting it.
    function _affordable(address token, uint256 fee) private view returns (uint256) {
        if (fee == 0) return 0;
        return IERC20(token).balanceOf(address(poolManager)) >= fee ? fee : 0;
    }

    /// @dev Pays `fee` (a token amount) out of the PoolManager. take() books a
    /// debt against this hook which the swap's returned delta credits back at
    /// the end of the swap, netting to zero.
    function _distribute(PoolId id, PoolTax storage p, uint256 fee) private {
        // Same split rule as V2: cuts are carved OUT OF the fee, derived from
        // the fee itself (not from a gross amount), so they can never add up to
        // more than the fee.
        uint256 feeBps_ = p.feeBps;
        uint256 rewardCut = (p.rewardsDistributor != address(0) && p.rewardBps > 0) ? (fee * p.rewardBps) / feeBps_ : 0;
        uint256 creatorCut =
            (p.creatorRewardsDistributor != address(0) && p.creatorRewardBps > 0) ? (fee * p.creatorRewardBps) / feeBps_ : 0;
        uint256 rest = fee - rewardCut - creatorCut;

        Currency token = Currency.wrap(p.token);
        if (rewardCut > 0) poolManager.take(token, p.rewardsDistributor, rewardCut);
        if (creatorCut > 0) poolManager.take(token, p.creatorRewardsDistributor, creatorCut);
        if (rest > 0) {
            poolManager.take(token, p.feeWalletDistributor != address(0) ? p.feeWalletDistributor : p.feeWallet, rest);
        }
        emit TaxCollected(id, fee, rewardCut, creatorCut, rest);
    }

    // ---------------------------------------------------------------
    // Graduation (ported from V2 LaunchedToken, reading V4 pool price)
    // ---------------------------------------------------------------

    /// @notice Current market cap in the feed's own decimals, or (0, false) if
    /// the pool/feed can't be read or the feed is stale. Never reverts.
    function currentMarketCapInFeedDecimals(PoolId id) public view returns (uint256 marketCap, bool feedIsFresh) {
        PoolTax storage p = poolTax[id];
        if (!p.configured) return (0, false);
        try p.priceFeed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0) return (0, false);
            // Future-dated rounds are treated as stale (see V2 LaunchedToken
            // for why the explicit check matters: an underflow here would not
            // be caught by the try/catch and would brick trading).
            if (updatedAt > block.timestamp || block.timestamp - updatedAt > p.maxOracleStaleness) return (0, false);
            try this._computeMarketCap(id, uint256(answer)) returns (uint256 mc, bool ok) {
                if (!ok) return (0, false);
                return (mc, true);
            } catch {
                return (0, false);
            }
        } catch {
            return (0, false);
        }
    }

    /// @dev External only so the caller can try/catch it. Reads the pool's live
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

        try p.priceFeed.decimals() returns (uint8 feedDecimals) {
            uint256 target = p.graduationTargetUsd * (10 ** feedDecimals);
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
        } catch {
            return;
        }
    }
}
