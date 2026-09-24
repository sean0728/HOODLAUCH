// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "./CustomToken.sol";
import "./LiquidityLocker.sol";
import "./interfaces/IUniswapV2Router02.sol";

/// @title CustomBondingCurveFactory
/// @notice The "advanced" sibling of BondingCurveFactory: identical bonding-
/// curve mechanics (no upfront ETH, constant-product pricing with virtual
/// reserves, auto-graduation into a real pool once real ETH raised crosses
/// poolSeedTargetWei), but clones CustomToken instead of LaunchedToken, so a
/// creator can configure the same reflections/marketing/auto-liquidity/burn
/// tax CustomTokenFactory already offers -- 0% is simply the all-zero case of
/// the same contract, exactly as it is over there.
///
/// This is deliberately a separate contract from BondingCurveFactory, for
/// exactly the same reason CustomTokenFactory is separate from TokenFactory
/// (see that contract's own header comment): CustomToken is a meaningfully
/// larger, more complex contract than LaunchedToken (reflections,
/// auto-liquidity, auto-burn, its own swap-and-process pipeline), and keeping
/// it fully separate means none of this touches the already-audited-by-tests
/// BondingCurveFactory/LaunchedToken path at all. Every curve-phase mechanic
/// below -- the constant-product math, the fee-then-price / price-then-fee
/// ordering, checks-effects-interactions, the buy-only pause circuit breaker,
/// the balanceOf() invariant checks, per-curve snapshotting of every economic
/// parameter -- is copied byte-for-byte from BondingCurveFactory (see that
/// contract's own header for the full reasoning behind each one); only the
/// token being cloned, and how the curve wires it into a pool at graduation,
/// differ.
///
/// Reuses CustomToken.sol, LiquidityLocker.sol, and the router interfaces
/// completely unmodified -- CustomToken.initialize() already accepts an
/// arbitrary mintTo_/factory_ pair (see CustomTokenFactory's own two
/// initialize() call sites for precedent: deploy-only mints to the creator
/// with factory_ == the factory; "deploy and add liquidity" mints to the
/// factory itself with factory_ == the factory too). A curve-phase token
/// here always uses the second shape -- mintTo_ == factory_ == address(this)
/// -- for the entire curve phase, which is exactly what makes CustomToken's
/// own from == factory guard in _update() skip its independent-pool-detection
/// attempt on every curve-phase transfer this factory itself originates (buys
/// paying out from the factory, and the liquidity-seeding transfer inside
/// _doGraduate's addLiquidityETH call) -- see CustomToken._update's own
/// comment on that guard, which this factory relies on exactly the way
/// CustomTokenFactory's atomic "addLiquidity=true" path already does.
///
/// This factory uses its OWN, freshly-deployed LiquidityLocker instance --
/// never BondingCurveFactory's or CustomTokenFactory's -- because a
/// LiquidityLocker permanently binds itself to exactly one factory address
/// the first time setFactory() is called (see LiquidityLocker.setFactory).
/// Deploy order is therefore: (1) deploy a new LiquidityLocker, (2) deploy
/// this factory passing that locker's address, (3) call
/// locker.setFactory(address(this)) once. Steps (1)-(3) mirror exactly how
/// CustomTokenFactory's own deploy script wires its separate locker instance.
///
/// Post-graduation tax wiring differs from BondingCurveFactory in exactly the
/// way CustomTokenFactory's differs from TokenFactory's: LaunchedToken wires
/// its pair and its platform tax in ONE call (configureTax), while CustomToken
/// splits this into TWO calls -- setPair(pair) followed by
/// configurePlatformTax(...) -- because CustomToken already has its own
/// creator-configured buyFees/sellFees sitting alongside the platform's tax,
/// and configurePlatformTax() needs `pair` to already be set so it can check
/// its own PairNotSet()/PairAlreadySet() invariants (see CustomToken.sol).
/// _doGraduate below makes both calls, in that order, exactly as
/// CustomTokenFactory._seedLiquidityAndBuyIn already does for its own atomic
/// launch path.
///
/// Unlike BondingCurveFactory (which requires platformFeeWallet and priceFeed
/// to already be configured before a curve can even be created -- mirroring
/// TokenFactory's own mandatory launch-time check), createCurveToken here
/// does NOT require either to be set. This mirrors CustomTokenFactory exactly
/// (see that contract's own createCustomToken doc comment): leaving
/// platformFeeWallet/priceFeed unset simply leaves the eventual
/// configurePlatformTax() call recording a permanently-inactive platform tax
/// (feeBps_ == 0 or feeWallet_ == address(0) -- see
/// CustomToken.configurePlatformTax) rather than blocking every curve launch
/// the way BondingCurveFactory's mandatory checks do. The creator's own
/// buyFees_/sellFees_ tax is entirely independent of this and is never
/// affected by it either way.
///
/// Ships without gasless relay support, same as BondingCurveFactory v1 --
/// see that contract's own note; the EIP-712 voucher pattern
/// CustomTokenFactory/TokenFactory use is a deliberate fast-follow.
contract CustomBondingCurveFactory is Ownable2Step, ReentrancyGuard, Pausable {
    address public immutable tokenImplementation;
    IUniswapV2Router02 public immutable router;
    LiquidityLocker public immutable locker;

    /// @notice See TokenFactory.MAX_FEE_BPS -- identical hard ceiling, same
    /// reasoning, applied here to curveFeeBps and the post-graduation feeBps.
    /// Entirely separate from, and never checked against, CustomToken's own
    /// MAX_TOTAL_BPS (5.00% per side) on the creator's buyFees_/sellFees_ --
    /// that cap is enforced by CustomToken.initialize() itself, not here.
    uint256 public constant MAX_FEE_BPS = 2_000; // 20.00%

    // ---- curve-phase parameters, snapshotted into each curve at creation
    // time (see createCurveToken) -- an owner change here only ever affects
    // curves created after the change, never one already live. Identical
    // defaults and identical reasoning to BondingCurveFactory's own copies. ----

    uint256 public curveLaunchFee; // flat fee to create a curve token -- no pool exists yet
    uint256 public curveFeeBps = 100; // 1.00%, skimmed from the ETH leg of every buy and sell during the curve phase
    uint256 public curveSupplyBps = 8_000; // 80.00% of totalSupply_ tradable on the curve
    uint256 public virtualEthReserveDefault = 3 ether;
    uint256 public virtualTokenReserveBps = 8_000; // 80.00% of totalSupply_
    /// @notice Real ETH (net of curveFeeBps) a curve must accumulate before it
    /// can graduate -- see BondingCurveFactory.poolSeedTargetWei's own doc
    /// comment for the full reasoning; identical default (1.5 ETH) per the
    /// user's requirement that both variants share the same bonding
    /// threshold.
    uint256 public poolSeedTargetWei = 1.5 ether;

    /// @notice See TokenFactory.maxCreatorBuyBps -- identical anti-rug
    /// safeguard, applied to the optional same-transaction creator buy-in at
    /// curve creation, checked against the actual net tokens received.
    uint256 public maxCreatorBuyBps = 500; // 5.00% of totalSupply_ by default

    address public feeTreasury;
    uint256 public lpLockDuration;

    // ---- post-graduation CustomToken platform-tax defaults, PLUS the two
    // reward-diversion addresses/bps below -- identical fields, identical
    // meaning, identical setTaxDefaults() bounds to
    // BondingCurveFactory/CustomTokenFactory's own copies. Entirely separate
    // from, and layered on top of, whatever buyFees_/sellFees_ the creator
    // configured on their own CustomToken at creation -- see
    // CustomToken.configurePlatformTax's own contract-level note on why the
    // two never overlap. Snapshotted into the Curve struct at
    // createCurveToken() time (see the Curve.tax* fields), applied verbatim
    // whenever that curve eventually graduates.
    //
    // --- Post-audit hardening (see AUDIT-CustomBondingCurveFactory.md
    // Finding 1) ---
    // These ten fields used to be individual `public` state variables. That
    // was a genuine vulnerability: their auto-generated getters happened to
    // match ITokenFactoryTaxDefaults's exact eleven-function shape (see
    // ITokenFactoryTaxDefaults.sol), the interface CustomToken._update's own
    // independent-pool auto-detection (`_activatePoolIfFound`,
    // `activateIndependentPair`) calls into via `ITokenFactoryTaxDefaults(
    // factory)` -- and `factory` on every token this contract clones really
    // is this contract's own address. That meant anyone could permanently
    // hijack a curve-phase token's `pair` -- and thus permanently brick its
    // graduation, with no recovery path -- just by getting a real Uniswap
    // pair to exist for (token, WETH) before this factory's own explicit
    // setPair() call runs (as cheap and permissionless as calling the DEX
    // factory's own createPair(), even before the curve is created, since
    // predictTokenAddress() is public). CustomToken's auto-detection is safe
    // against a genuine deploy-only CustomToken (CustomTokenFactory's own
    // use case, where `factory` really is the right source of tax
    // defaults) -- it was never safe against a curve-phase token whose
    // `factory` field happens to satisfy the same interface for an
    // unrelated reason.
    //
    // Making these ten fields private (no individual getters at all) closes
    // this: ITokenFactoryTaxDefaults(factory).feeBps() now hits no matching
    // function on this contract and reverts immediately -- the very first
    // call _activatePoolIfFound() makes after tentatively writing
    // `pair = detectedPair`, so that write rolls back in the same revert.
    // Every value is still fully readable off-chain, just through the one
    // combined taxDefaults() view below instead of ten separate getters --
    // the same shape curveTaxConfig() already uses for the per-curve
    // snapshot. This has zero effect on legitimate post-graduation
    // behavior: once this factory's own setPair() call succeeds, `pair` is
    // permanently non-zero, which already permanently disables
    // _activatePoolIfFound from running again on that token regardless.
    address private platformFeeWallet;
    uint256 private feeBps = 100; // 1.00%
    address private priceFeed;
    uint256 private graduationTargetUsd = 50_000; // whole dollars
    uint256 private maxOracleStaleness = 1 hours;

    /// @notice PlatformRewardsDistributor's address -- see
    /// BondingCurveFactory.rewardsDistributor for the identical dual role
    /// (curve-phase fee revenue split, and the post-graduation tax carve-out
    /// below). address(0) disables both. Private for the same Finding 1
    /// reason as the tax-default fields above -- see taxDefaults() below.
    address private rewardsDistributor;
    uint256 private rewardBps = 45; // 0.45% -- POST-graduation tax carve-out only -- snapshotted into Curve.taxRewardBps at creation

    /// @notice CreatorRewardsDistributor's address -- POST-graduation tax
    /// carve-out only, identical to BondingCurveFactory's own copy.
    address private creatorRewardsDistributor;
    uint256 private creatorRewardBps = 10; // 0.10% -- snapshotted into Curve.taxCreatorRewardBps at creation

    /// @notice FeeWalletDistributor's address -- POST-graduation tax
    /// remainder only, identical to BondingCurveFactory's own copy.
    address private feeWalletDistributor;

    /// @notice The combined replacement for what used to be ten separate
    /// public getters (see the Finding 1 hardening note above) -- the
    /// CURRENT live defaults applied to curves created from this point
    /// forward. For any already-created curve's own locked-in terms, use
    /// curveTaxConfig(token) instead, which is unaffected by this change.
    function taxDefaults()
        external
        view
        returns (
            address platformFeeWallet_,
            uint256 feeBps_,
            address priceFeed_,
            uint256 graduationTargetUsd_,
            uint256 maxOracleStaleness_,
            address rewardsDistributor_,
            uint256 rewardBps_,
            address creatorRewardsDistributor_,
            uint256 creatorRewardBps_,
            address feeWalletDistributor_
        )
    {
        return (
            platformFeeWallet, feeBps, priceFeed, graduationTargetUsd, maxOracleStaleness,
            rewardsDistributor, rewardBps, creatorRewardsDistributor, creatorRewardBps, feeWalletDistributor
        );
    }

    /// @notice Cheap monitoring helper for the exact failure mode Finding 1
    /// describes: true iff this token's own `pair` has been set (by
    /// CustomToken's independent-pool auto-detection, triggered by anyone
    /// once a real Uniswap pair exists for it) while this factory's own
    /// curve still thinks it hasn't graduated. If this is ever true, that
    /// curve's graduate()/buy()-triggered-graduation calls will keep
    /// failing -- surfaced here explicitly rather than left to be
    /// discovered only when graduate() reverts with a generic reason. The
    /// restructuring above prevents this from ever becoming true again for
    /// curves created from this point forward, but this stays in place as a
    /// permanent, cheap tripwire rather than being removed once the root
    /// cause is fixed.
    function isGraduationBlocked(address token) external view returns (bool) {
        Curve storage curve = curves[token];
        if (curve.totalSupply == 0 || curve.graduated) return false;
        return CustomToken(payable(token)).pair() != address(0);
    }

    /// @notice See TokenFactory.liquiditySlippageBps -- identical protection,
    /// applied to _doGraduate's own addLiquidityETH call.
    uint256 public liquiditySlippageBps = 600; // 6.00% default
    uint256 public constant MIN_LIQUIDITY_SLIPPAGE_BPS = 500; // 5.00%
    uint256 public constant MAX_LIQUIDITY_SLIPPAGE_BPS = 800; // 8.00%

    function _minWithSlippage(uint256 amount) private view returns (uint256) {
        return amount - (amount * liquiditySlippageBps) / 10_000;
    }

    struct Curve {
        address creator;
        uint256 totalSupply; // the token's full totalSupply_, snapshotted at creation
        uint256 curveSupply; // portion of totalSupply allocated to the curve at creation
        uint256 tokensRemaining; // curve-held tokens still available to sell
        uint256 virtualEthReserve;
        uint256 virtualTokenReserve;
        uint256 realEthReserve; // real ETH accumulated net of curveFeeBps -- zeroed in _doGraduate once moved to the pool
        uint256 poolSeedTargetWei; // snapshotted at creation
        uint256 curveFeeBps; // snapshotted at creation -- fixed for this curve's lifetime
        bool graduated;
        uint256 createdAt;
        // ---- post-graduation platform-tax terms, snapshotted at creation ----
        address taxPlatformFeeWallet;
        uint256 taxFeeBps;
        address taxPriceFeed;
        uint256 taxGraduationTargetUsd;
        uint256 taxMaxOracleStaleness;
        uint256 taxRewardBps;
        uint256 taxCreatorRewardBps;
    }

    mapping(address => Curve) private curves;
    mapping(address => address) public creatorOf;
    mapping(address => address) public pairOf; // token => its DEX pair once graduated, address(0) before then
    address[] private _tokenList;
    mapping(address => address[]) private _tokensByCreator;

    /// @notice ETH that _distributeEthFee tried to forward to feeTreasury or
    /// rewardsDistributor but couldn't, because the recipient's receive/
    /// fallback reverted. Stays on this contract's own balance, tracked here
    /// rather than lost, until an owner sweeps it via rescueStrandedFees().
    /// Same design as BondingCurveFactory's own post-audit fix (see
    /// AUDIT-BondingCurveFactory.md Finding 1) -- built in from the start
    /// here rather than retrofitted.
    uint256 public strandedFees;

    event CurveTokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint256 totalSupply,
        uint256 curveSupply,
        uint256 virtualEthReserve,
        uint256 virtualTokenReserve,
        uint256 poolSeedTargetWei,
        address reflectionAsset,
        address marketingWallet
    );
    event CreatorBought(address indexed token, address indexed creator, uint256 ethIn, uint256 tokensOut);
    event CurveBought(address indexed token, address indexed buyer, uint256 ethIn, uint256 feeAmount, uint256 tokensOut, uint256 realEthReserveAfter);
    event CurveSold(address indexed token, address indexed seller, uint256 tokensIn, uint256 feeAmount, uint256 ethOut, uint256 realEthReserveAfter);
    event CurveGraduated(
        address indexed token,
        address indexed pair,
        uint256 ethAdded,
        uint256 tokensAdded,
        uint256 lpAmount,
        uint256 unlockTime,
        uint256 indexed lockId
    );

    event FeeTransferFailed(address indexed recipient, uint256 amount);
    event StrandedFeesRescued(address indexed to, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    event CurveFeeBpsUpdated(uint256 newBps);
    event CurveSupplyBpsUpdated(uint256 newBps);
    event VirtualEthReserveDefaultUpdated(uint256 newDefault);
    event VirtualTokenReserveBpsUpdated(uint256 newBps);
    event PoolSeedTargetUpdated(uint256 newTarget);
    event CurveLaunchFeeUpdated(uint256 newFee);
    event LpLockDurationUpdated(uint256 newDuration);
    event MaxCreatorBuyBpsUpdated(uint256 newBps);
    event LiquiditySlippageBpsUpdated(uint256 newBps);
    event FeeTreasuryUpdated(address newTreasury);
    event TaxDefaultsUpdated();
    event RewardsDistributorUpdated(address newDistributor);
    event CreatorRewardsDistributorUpdated(address newDistributor);
    event FeeWalletDistributorUpdated(address newDistributor);
    event TokenPriceFeedUpdated(address indexed token, address newPriceFeed, uint256 newMaxOracleStaleness);

    constructor(
        address tokenImplementation_,
        address router_,
        address locker_,
        uint256 curveLaunchFee_,
        address feeTreasury_,
        uint256 lpLockDuration_,
        address platformFeeWallet_,
        address priceFeed_
    ) Ownable(msg.sender) {
        require(tokenImplementation_ != address(0), "CustomBondingCurveFactory: invalid token implementation");
        require(router_ != address(0), "CustomBondingCurveFactory: invalid router");
        require(locker_ != address(0), "CustomBondingCurveFactory: invalid locker");
        require(feeTreasury_ != address(0), "CustomBondingCurveFactory: invalid treasury");

        tokenImplementation = tokenImplementation_;
        router = IUniswapV2Router02(router_);
        locker = LiquidityLocker(locker_);
        curveLaunchFee = curveLaunchFee_;
        feeTreasury = feeTreasury_;
        lpLockDuration = lpLockDuration_;
        platformFeeWallet = platformFeeWallet_;
        priceFeed = priceFeed_;
    }

    /// @notice Absorbs any ETH the router refunds mid-addLiquidityETH, and any
    /// stray direct transfer -- see rescueStrandedFees()/rescueToken() for how
    /// the latter gets recovered. Identical reasoning to
    /// BondingCurveFactory.receive().
    receive() external payable {}

    /// @dev See TokenFactory._deriveTokenSalt -- binds the actual CREATE2
    /// salt to the creator so a mempool-visible salt can't be front-run.
    function _deriveTokenSalt(address creator_, uint256 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator_, salt));
    }

    /// @dev Identical constant-product quote to BondingCurveFactory._quoteBuy
    /// -- fee-first: this curve's own snapshotted curveFeeBps is skimmed off
    /// the incoming ETH before it touches the constant-product formula.
    function _quoteBuy(Curve storage curve, uint256 ethIn) private view returns (uint256 tokensOut, uint256 feeAmount, uint256 netEthIn) {
        feeAmount = (ethIn * curve.curveFeeBps) / 10_000;
        netEthIn = ethIn - feeAmount;
        uint256 effEth = curve.virtualEthReserve + curve.realEthReserve;
        uint256 effToken = curve.virtualTokenReserve + curve.tokensRemaining;
        tokensOut = (netEthIn * effToken) / (effEth + netEthIn);
    }

    /// @dev Identical constant-product quote to BondingCurveFactory._quoteSell
    /// -- fee-last: the gross ETH the constant-product formula implies is
    /// computed first, then curveFeeBps is skimmed off that gross amount.
    function _quoteSell(Curve storage curve, uint256 tokenAmountIn) private view returns (uint256 ethOutGross, uint256 feeAmount, uint256 netEthOut) {
        uint256 effEth = curve.virtualEthReserve + curve.realEthReserve;
        uint256 effToken = curve.virtualTokenReserve + curve.tokensRemaining;
        ethOutGross = (tokenAmountIn * effEth) / (effToken + tokenAmountIn);
        feeAmount = (ethOutGross * curve.curveFeeBps) / 10_000;
        netEthOut = ethOutGross - feeAmount;
    }

    /// @dev Identical 50/50 feeTreasury/rewardsDistributor split, and
    /// identical non-reverting-on-failure behavior, to
    /// BondingCurveFactory._distributeEthFee (see that function's own comment
    /// for the full "holders must always be able to exit" reasoning) --
    /// built in from the start here rather than retrofitted.
    function _distributeEthFee(uint256 amount) private {
        if (amount == 0) return;
        if (rewardsDistributor != address(0)) {
            uint256 toRewards = amount / 2;
            uint256 toTreasury = amount - toRewards;
            if (toRewards > 0) {
                (bool sentRewards, ) = rewardsDistributor.call{value: toRewards}("");
                if (!sentRewards) {
                    strandedFees += toRewards;
                    emit FeeTransferFailed(rewardsDistributor, toRewards);
                }
            }
            (bool sent, ) = feeTreasury.call{value: toTreasury}("");
            if (!sent) {
                strandedFees += toTreasury;
                emit FeeTransferFailed(feeTreasury, toTreasury);
            }
        } else {
            (bool sent, ) = feeTreasury.call{value: amount}("");
            if (!sent) {
                strandedFees += amount;
                emit FeeTransferFailed(feeTreasury, amount);
            }
        }
    }

    /// @dev Shared core of a buy -- identical checks-effects-interactions
    /// discipline and identical balanceOf() invariant check to
    /// BondingCurveFactory._executeBuy.
    function _executeBuy(
        address token,
        Curve storage curve,
        address recipient,
        uint256 ethIn,
        uint256 minTokensOut
    ) private returns (uint256 tokensOut, uint256 feeAmount) {
        uint256 netEthIn;
        (tokensOut, feeAmount, netEthIn) = _quoteBuy(curve, ethIn);
        require(tokensOut > 0, "CustomBondingCurveFactory: zero tokens out");
        require(tokensOut <= curve.tokensRemaining, "CustomBondingCurveFactory: exceeds curve supply");
        require(tokensOut >= minTokensOut, "CustomBondingCurveFactory: slippage");

        curve.realEthReserve += netEthIn;
        curve.tokensRemaining -= tokensOut;

        _distributeEthFee(feeAmount);

        bool sent = IERC20(token).transfer(recipient, tokensOut);
        require(sent, "CustomBondingCurveFactory: token transfer failed");

        require(
            IERC20(token).balanceOf(address(this)) >= curve.tokensRemaining + (curve.totalSupply - curve.curveSupply),
            "CustomBondingCurveFactory: token balance invariant violated"
        );
    }

    /// @notice Deploy a new curve token whose eventual pool will carry a
    /// creator-configured tax (reflections/marketing/auto-liquidity/burn),
    /// exactly like CustomTokenFactory's own CustomToken -- 0% is simply the
    /// all-zero case of buyFees_/sellFees_, same as over there. No ETH from
    /// the creator ever pairs into a pool here; msg.value must equal
    /// curveLaunchFee + creatorBuyEthAmount exactly.
    ///
    /// buyFees_/sellFees_ are each validated against CustomToken's own 5%-
    /// per-side MAX_TOTAL_BPS cap by CustomToken.initialize() itself (this
    /// factory does not duplicate that check, exactly like CustomTokenFactory
    /// doesn't) -- an invalid combination simply reverts the whole
    /// transaction, including the clone deployment. reflectionAsset_ ==
    /// address(0) means reflections pay out in native ETH; marketingWallet_
    /// is required only if either side's marketingBps is nonzero (same rules
    /// as CustomTokenFactory.createCustomToken).
    ///
    /// creatorBuyEthAmount is optional (0 skips it): an ordinary buy against
    /// the freshly-created curve, in this same transaction, capped at
    /// maxCreatorBuyBps of totalSupply_ checked against the actual net tokens
    /// received -- identical anti-rug convention to BondingCurveFactory's own
    /// creator buy-in.
    ///
    /// Snapshots curveFeeBps and the seven post-graduation platform-tax
    /// parameters into this curve at the moment it's created -- an owner
    /// changing any of those afterward only ever affects curves created from
    /// that point forward, never this one. Identical discipline to
    /// BondingCurveFactory.createCurveToken.
    /// @param salt Caller-chosen CREATE2 salt input -- see
    /// TokenFactory.createToken's matching parameter doc; applies identically
    /// here.
    function createCurveToken(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        CustomToken.FeeSet calldata buyFees_,
        CustomToken.FeeSet calldata sellFees_,
        address reflectionAsset_,
        address marketingWallet_,
        uint256 creatorBuyEthAmount,
        uint256 minCreatorTokensOut,
        uint256 salt
    ) external payable nonReentrant returns (address token, uint256 creatorTokensBought) {
        require(bytes(name_).length > 0, "CustomBondingCurveFactory: name required");
        require(bytes(symbol_).length > 0, "CustomBondingCurveFactory: symbol required");
        require(totalSupply_ > 0, "CustomBondingCurveFactory: supply must be > 0");
        require(msg.value == curveLaunchFee + creatorBuyEthAmount, "CustomBondingCurveFactory: incorrect ETH sent");

        token = Clones.cloneDeterministic(tokenImplementation, _deriveTokenSalt(msg.sender, salt));
        // mintTo_ == factory_ == address(this) for the entire curve phase --
        // required so CustomToken._update's `from == factory` guard skips
        // independent-pool-detection on every transfer this factory
        // originates during the curve phase and during graduation's own
        // liquidity-seeding transfer. See this contract's header comment.
        CustomToken(payable(token)).initialize(
            name_,
            symbol_,
            totalSupply_,
            msg.sender, // creator_
            address(this), // mintTo_
            address(this), // factory_
            address(router), // router_
            buyFees_,
            sellFees_,
            reflectionAsset_,
            marketingWallet_
        );

        uint256 curveSupply = (totalSupply_ * curveSupplyBps) / 10_000;
        require(curveSupply > 0, "CustomBondingCurveFactory: curve supply rounds to zero");

        Curve storage curve = curves[token];
        curve.creator = msg.sender;
        curve.totalSupply = totalSupply_;
        curve.curveSupply = curveSupply;
        curve.tokensRemaining = curveSupply;
        curve.virtualEthReserve = virtualEthReserveDefault;
        curve.virtualTokenReserve = (totalSupply_ * virtualTokenReserveBps) / 10_000;
        curve.poolSeedTargetWei = poolSeedTargetWei;
        curve.curveFeeBps = curveFeeBps;
        curve.createdAt = block.timestamp;
        curve.taxPlatformFeeWallet = platformFeeWallet;
        curve.taxFeeBps = feeBps;
        curve.taxPriceFeed = priceFeed;
        curve.taxGraduationTargetUsd = graduationTargetUsd;
        curve.taxMaxOracleStaleness = maxOracleStaleness;
        curve.taxRewardBps = rewardBps;
        curve.taxCreatorRewardBps = creatorRewardBps;

        creatorOf[token] = msg.sender;
        _tokensByCreator[msg.sender].push(token);
        _tokenList.push(token);

        emit CurveTokenCreated(
            token, msg.sender, name_, symbol_, totalSupply_, curveSupply,
            curve.virtualEthReserve, curve.virtualTokenReserve, curve.poolSeedTargetWei,
            reflectionAsset_, marketingWallet_
        );

        if (creatorBuyEthAmount > 0) {
            (uint256 tokensOut, ) = _executeBuy(token, curve, msg.sender, creatorBuyEthAmount, minCreatorTokensOut);
            require(
                tokensOut <= (totalSupply_ * maxCreatorBuyBps) / 10_000,
                "CustomBondingCurveFactory: creator buy-in exceeds max allowed share of supply"
            );
            creatorTokensBought = tokensOut;
            emit CreatorBought(token, msg.sender, creatorBuyEthAmount, tokensOut);

            // Same auto-graduation attempt as buy() -- a creator buy-in large
            // enough to cross poolSeedTargetWei on its own must not leave the
            // curve stuck "crossed but ungraduated".
            if (curve.realEthReserve >= curve.poolSeedTargetWei) {
                try this._attemptGraduate(token) returns (address, uint256, uint256) {} catch {}
            }
        }

        _distributeEthFee(curveLaunchFee);
    }

    /// @notice Buy curve tokens with ETH. Identical semantics to
    /// BondingCurveFactory.buy -- reverts if already graduated, auto-attempts
    /// graduation once poolSeedTargetWei is crossed, paused independently of
    /// sell().
    function buy(address token, uint256 minTokensOut) external payable nonReentrant whenNotPaused returns (uint256 tokensOut) {
        Curve storage curve = curves[token];
        require(curve.totalSupply > 0, "CustomBondingCurveFactory: unknown curve");
        require(!curve.graduated, "CustomBondingCurveFactory: already graduated");
        require(msg.value > 0, "CustomBondingCurveFactory: no ETH sent");

        uint256 feeAmount;
        (tokensOut, feeAmount) = _executeBuy(token, curve, msg.sender, msg.value, minTokensOut);

        emit CurveBought(token, msg.sender, msg.value, feeAmount, tokensOut, curve.realEthReserve);

        if (curve.realEthReserve >= curve.poolSeedTargetWei) {
            try this._attemptGraduate(token) returns (address, uint256, uint256) {} catch {}
        }
    }

    /// @notice Sell curve tokens back for ETH. Never pausable -- holders must
    /// always be able to exit a live curve. Identical checks-effects-
    /// interactions discipline to BondingCurveFactory.sell.
    function sell(address token, uint256 tokenAmountIn, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        Curve storage curve = curves[token];
        require(curve.totalSupply > 0, "CustomBondingCurveFactory: unknown curve");
        require(!curve.graduated, "CustomBondingCurveFactory: already graduated");
        require(tokenAmountIn > 0, "CustomBondingCurveFactory: zero amount");

        (uint256 ethOutGross, uint256 feeAmount, uint256 netEthOut) = _quoteSell(curve, tokenAmountIn);
        require(ethOutGross <= curve.realEthReserve, "CustomBondingCurveFactory: exceeds real ETH reserve");
        require(netEthOut >= minEthOut, "CustomBondingCurveFactory: slippage");

        curve.tokensRemaining += tokenAmountIn;
        curve.realEthReserve -= ethOutGross;

        bool pulled = IERC20(token).transferFrom(msg.sender, address(this), tokenAmountIn);
        require(pulled, "CustomBondingCurveFactory: token transferFrom failed");
        require(
            IERC20(token).balanceOf(address(this)) >= curve.tokensRemaining + (curve.totalSupply - curve.curveSupply),
            "CustomBondingCurveFactory: token balance invariant violated"
        );

        _distributeEthFee(feeAmount);

        ethOut = netEthOut;
        (bool sentEth, ) = payable(msg.sender).call{value: ethOut}("");
        require(sentEth, "CustomBondingCurveFactory: ETH payout failed");

        emit CurveSold(token, msg.sender, tokenAmountIn, feeAmount, ethOut, curve.realEthReserve);
    }

    /// @notice Permissionless graduation once a curve's realEthReserve has
    /// crossed its own poolSeedTargetWei -- the guaranteed fallback to buy()'s
    /// own best-effort inline attempt.
    function graduate(address token) external nonReentrant returns (address pair, uint256 lpAmount, uint256 lockId) {
        Curve storage curve = curves[token];
        require(curve.totalSupply > 0, "CustomBondingCurveFactory: unknown curve");
        require(!curve.graduated, "CustomBondingCurveFactory: already graduated");
        require(curve.realEthReserve >= curve.poolSeedTargetWei, "CustomBondingCurveFactory: graduation target not met");
        return _doGraduate(token, curve);
    }

    /// @dev External purely so buy() can wrap it in try/catch -- identical
    /// pattern to BondingCurveFactory._attemptGraduate.
    function _attemptGraduate(address token) external returns (address pair, uint256 lpAmount, uint256 lockId) {
        require(msg.sender == address(this), "CustomBondingCurveFactory: internal only");
        Curve storage curve = curves[token];
        if (curve.totalSupply == 0 || curve.graduated || curve.realEthReserve < curve.poolSeedTargetWei) {
            return (address(0), 0, 0);
        }
        return _doGraduate(token, curve);
    }

    /// @dev The actual graduation. Flips `graduated` before any external call
    /// below, zeroes curve.realEthReserve before the pool-seeding call
    /// (identical discipline to BondingCurveFactory._doGraduate, including
    /// its post-audit Finding 2 fix -- built in from the start here). Seeds
    /// the pool with the factory's entire remaining balance of `token` and
    /// this curve's full realEthReserve, locks the resulting LP to the
    /// ORIGINAL creator recorded at curve creation via this factory's OWN
    /// LiquidityLocker instance.
    ///
    /// Wires the token's tax in the two-call shape CustomToken requires --
    /// setPair(pair) first, then configurePlatformTax(...) -- rather than
    /// LaunchedToken's single configureTax() call. See this contract's
    /// header comment for why CustomToken needs both calls. Applies the SAME
    /// post-graduation platform-tax terms that were in effect when this curve
    /// was CREATED (curve.tax* fields, not the live globals) -- identical
    /// snapshotting discipline to BondingCurveFactory. This tax is entirely
    /// independent of, and layered on top of, whatever buyFees_/sellFees_ the
    /// creator configured back at createCurveToken() time.
    function _doGraduate(address token, Curve storage curve) private returns (address pair, uint256 lpAmount, uint256 lockId) {
        curve.graduated = true;

        uint256 tokensForPool = IERC20(token).balanceOf(address(this));
        uint256 ethForPool = curve.realEthReserve;
        curve.realEthReserve = 0;
        require(tokensForPool > 0 && ethForPool > 0, "CustomBondingCurveFactory: nothing to graduate");

        IERC20(token).approve(address(router), tokensForPool);
        (, , uint256 lpAmountAdded) = router.addLiquidityETH{value: ethForPool}(
            token,
            tokensForPool,
            _minWithSlippage(tokensForPool),
            _minWithSlippage(ethForPool),
            address(locker), // LP tokens mint straight to this factory's own locker
            block.timestamp + 15 minutes
        );
        lpAmount = lpAmountAdded;

        pair = IUniswapV2FactoryMinimal(router.factory()).getPair(token, router.WETH());
        require(pair != address(0), "CustomBondingCurveFactory: pair not found after addLiquidityETH");
        pairOf[token] = pair;

        CustomToken(payable(token)).setPair(pair);

        uint256 effectiveRewardBps = rewardsDistributor != address(0) ? curve.taxRewardBps : 0;
        uint256 effectiveCreatorRewardBps = creatorRewardsDistributor != address(0) ? curve.taxCreatorRewardBps : 0;
        CustomToken(payable(token)).configurePlatformTax(
            curve.taxPlatformFeeWallet, curve.taxFeeBps, curve.taxPriceFeed, curve.taxGraduationTargetUsd, curve.taxMaxOracleStaleness,
            rewardsDistributor, effectiveRewardBps, creatorRewardsDistributor, effectiveCreatorRewardBps,
            feeWalletDistributor
        );

        uint256 unlockTime = block.timestamp + lpLockDuration;
        lockId = locker.lock(pair, curve.creator, lpAmount, unlockTime);

        emit CurveGraduated(token, pair, ethForPool, tokensForPool, lpAmount, unlockTime, lockId);
    }

    // ---- views ----

    function quoteBuy(address token, uint256 ethIn) external view returns (uint256 tokensOut, uint256 feeAmount) {
        Curve storage curve = curves[token];
        require(curve.totalSupply > 0, "CustomBondingCurveFactory: unknown curve");
        (tokensOut, feeAmount, ) = _quoteBuy(curve, ethIn);
    }

    function quoteSell(address token, uint256 tokenAmountIn) external view returns (uint256 ethOut, uint256 feeAmount) {
        Curve storage curve = curves[token];
        require(curve.totalSupply > 0, "CustomBondingCurveFactory: unknown curve");
        (, feeAmount, ethOut) = _quoteSell(curve, tokenAmountIn);
    }

    function curveState(address token)
        external
        view
        returns (
            address creator,
            uint256 totalSupply_,
            uint256 curveSupply,
            uint256 tokensRemaining,
            uint256 virtualEthReserve,
            uint256 virtualTokenReserve,
            uint256 realEthReserve,
            uint256 poolSeedTargetWei_,
            uint256 curveFeeBps_,
            bool graduated,
            uint256 createdAt
        )
    {
        Curve storage curve = curves[token];
        require(curve.totalSupply > 0, "CustomBondingCurveFactory: unknown curve");
        return (
            curve.creator,
            curve.totalSupply,
            curve.curveSupply,
            curve.tokensRemaining,
            curve.virtualEthReserve,
            curve.virtualTokenReserve,
            curve.realEthReserve,
            curve.poolSeedTargetWei,
            curve.curveFeeBps,
            curve.graduated,
            curve.createdAt
        );
    }

    /// @notice The seven post-graduation tax terms this specific curve is
    /// locked into -- snapshotted once, at createCurveToken() time, and
    /// applied verbatim in _doGraduate whenever this curve eventually
    /// graduates, regardless of what setTaxDefaults() has done to the live
    /// globals in the meantime. Identical to
    /// BondingCurveFactory.curveTaxConfig.
    function curveTaxConfig(address token)
        external
        view
        returns (
            address taxPlatformFeeWallet,
            uint256 taxFeeBps,
            address taxPriceFeed,
            uint256 taxGraduationTargetUsd,
            uint256 taxMaxOracleStaleness,
            uint256 taxRewardBps,
            uint256 taxCreatorRewardBps
        )
    {
        Curve storage curve = curves[token];
        require(curve.totalSupply > 0, "CustomBondingCurveFactory: unknown curve");
        return (
            curve.taxPlatformFeeWallet,
            curve.taxFeeBps,
            curve.taxPriceFeed,
            curve.taxGraduationTargetUsd,
            curve.taxMaxOracleStaleness,
            curve.taxRewardBps,
            curve.taxCreatorRewardBps
        );
    }

    function tokensOf(address creator_) external view returns (address[] memory) {
        return _tokensByCreator[creator_];
    }

    function allTokens() external view returns (address[] memory) {
        return _tokenList;
    }

    /// @notice Previews the address createCurveToken() will deploy to for a
    /// given (creator, salt) pair.
    function predictTokenAddress(address creator_, uint256 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(tokenImplementation, _deriveTokenSalt(creator_, salt), address(this));
    }

    // ---- admin ----

    function setCurveFeeBps(uint256 newBps) external onlyOwner {
        require(newBps <= MAX_FEE_BPS, "CustomBondingCurveFactory: feeBps exceeds MAX_FEE_BPS ceiling");
        curveFeeBps = newBps;
        emit CurveFeeBpsUpdated(newBps);
    }

    function setCurveSupplyBps(uint256 newBps) external onlyOwner {
        require(newBps > 0 && newBps <= 10_000, "CustomBondingCurveFactory: curveSupplyBps must be in (0, 10000]");
        curveSupplyBps = newBps;
        emit CurveSupplyBpsUpdated(newBps);
    }

    function setVirtualEthReserveDefault(uint256 newDefault) external onlyOwner {
        virtualEthReserveDefault = newDefault;
        emit VirtualEthReserveDefaultUpdated(newDefault);
    }

    function setVirtualTokenReserveBps(uint256 newBps) external onlyOwner {
        require(newBps > 0, "CustomBondingCurveFactory: virtualTokenReserveBps must be > 0");
        virtualTokenReserveBps = newBps;
        emit VirtualTokenReserveBpsUpdated(newBps);
    }

    /// @notice Updates the default real-ETH-raised threshold (in wei) new
    /// curves must cross before they graduate into a pool -- only ever
    /// affects curves created after this call.
    function setPoolSeedTargetWei(uint256 newTarget) external onlyOwner {
        require(newTarget > 0, "CustomBondingCurveFactory: graduation target must be > 0");
        poolSeedTargetWei = newTarget;
        emit PoolSeedTargetUpdated(newTarget);
    }

    function setCurveLaunchFee(uint256 newFee) external onlyOwner {
        curveLaunchFee = newFee;
        emit CurveLaunchFeeUpdated(newFee);
    }

    function setLpLockDuration(uint256 newDuration) external onlyOwner {
        lpLockDuration = newDuration;
        emit LpLockDurationUpdated(newDuration);
    }

    function setMaxCreatorBuyBps(uint256 newBps) external onlyOwner {
        require(newBps <= 10_000, "CustomBondingCurveFactory: bps cannot exceed 100%");
        maxCreatorBuyBps = newBps;
        emit MaxCreatorBuyBpsUpdated(newBps);
    }

    /// @notice See TokenFactory.setLiquiditySlippageBps -- identical fixed
    /// 5.00%-8.00% band, applied to _doGraduate's own addLiquidityETH call.
    function setLiquiditySlippageBps(uint256 newBps) external onlyOwner {
        require(newBps >= MIN_LIQUIDITY_SLIPPAGE_BPS, "CustomBondingCurveFactory: slippage below 5% floor");
        require(newBps <= MAX_LIQUIDITY_SLIPPAGE_BPS, "CustomBondingCurveFactory: slippage above 8% ceiling");
        liquiditySlippageBps = newBps;
        emit LiquiditySlippageBpsUpdated(newBps);
    }

    function setFeeTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "CustomBondingCurveFactory: invalid treasury");
        feeTreasury = newTreasury;
        emit FeeTreasuryUpdated(newTreasury);
    }

    function setRewardsDistributor(address newDistributor) external onlyOwner {
        rewardsDistributor = newDistributor;
        emit RewardsDistributorUpdated(newDistributor);
    }

    function setCreatorRewardsDistributor(address newDistributor) external onlyOwner {
        creatorRewardsDistributor = newDistributor;
        emit CreatorRewardsDistributorUpdated(newDistributor);
    }

    function setFeeWalletDistributor(address newDistributor) external onlyOwner {
        feeWalletDistributor = newDistributor;
        emit FeeWalletDistributorUpdated(newDistributor);
    }

    /// @notice Update the POST-graduation platform-tax defaults applied to
    /// curves CREATED from this point forward -- snapshotted per curve at
    /// createCurveToken() time, so this never touches an already-existing
    /// curve's own locked-in terms. Identical bounds to
    /// BondingCurveFactory/CustomTokenFactory's own setTaxDefaults.
    function setTaxDefaults(
        address platformFeeWallet_,
        uint256 feeBps_,
        address priceFeed_,
        uint256 graduationTargetUsd_,
        uint256 maxOracleStaleness_,
        uint256 rewardBps_,
        uint256 creatorRewardBps_
    ) external onlyOwner {
        require(feeBps_ <= MAX_FEE_BPS, "CustomBondingCurveFactory: feeBps exceeds MAX_FEE_BPS ceiling");
        require(graduationTargetUsd_ > 0, "CustomBondingCurveFactory: graduation target must be > 0");
        require(maxOracleStaleness_ > 0, "CustomBondingCurveFactory: oracle staleness must be > 0");
        require(rewardBps_ + creatorRewardBps_ <= feeBps_, "CustomBondingCurveFactory: rewardBps+creatorRewardBps cannot exceed feeBps");
        platformFeeWallet = platformFeeWallet_;
        feeBps = feeBps_;
        priceFeed = priceFeed_;
        graduationTargetUsd = graduationTargetUsd_;
        maxOracleStaleness = maxOracleStaleness_;
        rewardBps = rewardBps_;
        creatorRewardBps = creatorRewardBps_;
        emit TaxDefaultsUpdated();
    }

    /// @notice Escape hatch for an already-graduated curve's token whose
    /// price feed has gone permanently stale -- calls into the token
    /// directly, same as BondingCurveFactory.updateTokenPriceFeed.
    function updateTokenPriceFeed(address token, address newPriceFeed_, uint256 newMaxOracleStaleness_) external onlyOwner {
        CustomToken(payable(token)).updatePriceFeed(newPriceFeed_, newMaxOracleStaleness_);
        emit TokenPriceFeedUpdated(token, newPriceFeed_, newMaxOracleStaleness_);
    }

    /// @notice Sweeps ETH that _distributeEthFee couldn't deliver to `to`.
    /// Scoped to ONLY the tracked strandedFees counter, never
    /// address(this).balance directly -- identical safeguard to
    /// BondingCurveFactory.rescueStrandedFees.
    function rescueStrandedFees(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "CustomBondingCurveFactory: invalid recipient");
        require(amount <= strandedFees, "CustomBondingCurveFactory: exceeds stranded fees");
        strandedFees -= amount;
        (bool sent, ) = payable(to).call{value: amount}("");
        require(sent, "CustomBondingCurveFactory: rescue transfer failed");
        emit StrandedFeesRescued(to, amount);
    }

    /// @notice Rescues an ERC20 mistakenly sent directly to this contract.
    /// Cannot be used on any token this factory itself ever created as a
    /// curve -- live or already graduated -- identical safeguard to
    /// BondingCurveFactory.rescueToken.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "CustomBondingCurveFactory: invalid recipient");
        require(creatorOf[token] == address(0), "CustomBondingCurveFactory: cannot rescue a curve's own token");
        bool sent = IERC20(token).transfer(to, amount);
        require(sent, "CustomBondingCurveFactory: token rescue failed");
        emit TokenRescued(token, to, amount);
    }

    /// @notice Circuit breaker on new buy() calls only -- sell() is never
    /// pausable. Identical reasoning to BondingCurveFactory.pause.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
