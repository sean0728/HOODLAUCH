// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import "./LaunchedToken.sol";
import "./LiquidityLocker.sol";
import "./interfaces/IUniswapV2Router02.sol";

/// @title BondingCurveFactory
/// @notice A 5th launch mode alongside TokenFactory's/CustomTokenFactory's
/// four: a creator deploys a token with NO upfront ETH at all. The full
/// supply mints straight to this factory; curveSupplyBps of it (80% by
/// default) trades directly against a pump.fun-style constant-product
/// bonding curve, priced with virtual reserves layered on top of the real,
/// growing ones so the curve never divides by zero and starts at a sane
/// price. Once accumulated real ETH crosses poolSeedTargetWei, the curve
/// "graduates": its remaining tokens (curveSupplyBps's unsold leftover plus
/// the untouched (100% - curveSupplyBps) reserve) and its accumulated real
/// ETH seed a genuine Uniswap-V2-style pool, whose LP locks to the ORIGINAL
/// creator (never to whoever happened to call graduate()) for
/// lpLockDuration, exactly like TokenFactory's own liquidity lock. The
/// graduated pool then opts into the SAME ongoing platform tax every other
/// "launch with liquidity" mode already carries (see _doGraduate) -- this
/// mode adds a new curve-phase revenue stream, it doesn't give up the
/// existing one.
///
/// NOTE: this repo also has an older, unrelated contracts/BondingCurve.sol
/// (per-token clone, LP burned at graduation, USD-market-cap graduation via
/// oracle) that predates this file and is not wired into TokenFactory/
/// CustomTokenFactory/deploy.js anywhere -- confirmed by grepping both for
/// any reference to it. This is a clean-room design built independently for
/// the single-shared-factory architecture; it does not reuse or extend that
/// file.
///
/// Reuses LaunchedToken.sol, LiquidityLocker.sol, and the router interfaces
/// completely unmodified. This works because LaunchedToken.initialize()
/// already accepts an arbitrary mintTo_/factory_ pair, and its onlyFactory
/// modifier just checks msg.sender == factory -- a plain address, never
/// hardcoded to TokenFactory (see LaunchedToken.sol:134-137). A curve-phase
/// token has factory_ == address(this), so its tax never auto-activates
/// pre-graduation (there's no real pair for _maybeAutoActivateTax to find
/// yet), and _doGraduate below calls the exact same configureTax() every
/// other factory calls once its own pool exists.
///
/// Single shared factory, not one contract per curve: cheaper per launch,
/// same architecture TokenFactory/CustomTokenFactory already use, at the
/// cost of this being the FIRST HoodLaunch contract that sits on pooled,
/// indefinite-duration ETH rather than routing it straight through a router
/// in the same atomic transaction. See the security notes on buy/sell/
/// graduate below for the mitigations that follow from that: nonReentrant
/// everywhere ETH moves, checks-effects-interactions on sell()'s payout,
/// graduated flipped before any external call in _doGraduate, a buy-only
/// pause circuit breaker (sell() never pauses -- holders must always be
/// able to exit), and a running balanceOf() invariant check after every
/// trade.
///
/// Curve-phase trading fees (curveFeeBps, skimmed from ETH on both buy and
/// sell) and the flat curveLaunchFee are both native-ETH revenue, so they
/// reuse the exact 50/50 feeTreasury/rewardsDistributor split TokenFactory.
/// _finalizeLaunch already uses for deployFee/launchFee (see
/// _distributeEthFee) -- no new revenue-routing concept. This deliberately
/// does NOT reuse creatorRewardsDistributor/feeWalletDistributor for
/// curve-phase fees: both of those are built around an in-kind, per-
/// launched-token ERC20 balance that gets swapped for ETH later (see
/// CreatorRewardsDistributor.triggerCreatorSwap), which doesn't fit an
/// already-ETH-denominated fee collected before any pool even exists.
/// creatorRewardsDistributor/feeWalletDistributor are still configured on
/// this factory and used, exactly like every other factory, for the
/// POST-graduation LaunchedToken transfer tax (_doGraduate's configureTax
/// call) -- just never for the curve-phase fee itself.
///
/// Ships without gasless relay support (creators/traders pay their own gas
/// for createCurveToken/buy/sell in v1); the EIP-712 voucher pattern the
/// other factories use is a deliberate fast-follow once this contract has
/// live testnet mileage.
///
/// --- Post-audit hardening (see AUDIT-BondingCurveFactory.md) ---
/// This revision fixes every finding from that audit:
///   - Finding 1 (High): _distributeEthFee no longer reverts the triggering
///     buy()/sell()/createCurveToken() call when a fee recipient rejects the
///     transfer -- see _distributeEthFee and strandedFees below. sell()'s
///     "holders must always be able to exit" guarantee no longer depends on
///     feeTreasury/rewardsDistributor's health.
///   - Finding 2 (Medium): curve.realEthReserve is now zeroed in
///     _doGraduate, so curveState() reports 0 for every graduated curve
///     instead of a stale, pre-graduation balance forever.
///   - Finding 3 (Medium): curveFeeBps is now snapshotted per curve (see
///     Curve.curveFeeBps), exactly like every sibling economic parameter --
///     setCurveFeeBps() only ever affects curves created after the change.
///   - Finding 4 (Low): the seven post-graduation tax parameters are now
///     snapshotted per curve at creation (see the Curve.tax* fields) rather
///     than read live at graduation time, so a long-lived curve graduates
///     under the terms that existed when it was created, not whatever
///     setTaxDefaults() happens to say later. The three distributor
///     addresses (rewardsDistributor/creatorRewardsDistributor/
///     feeWalletDistributor) are deliberately NOT snapshotted -- they're
///     "is this platform feature live yet" toggles, not terms a buyer
///     bought into.
///   - Finding 5 (Low): rescueStrandedFees()/rescueToken() add a recovery
///     path for stray ETH/tokens, structured so neither can ever touch a
///     live curve's own tracked balance.
///   - Finding 6 (Informational): ethGraduationTarget is renamed
///     poolSeedTargetWei throughout, to stop it being confused with the
///     unrelated, USD-denominated, post-pool graduationTargetUsd.
contract BondingCurveFactory is Ownable2Step, ReentrancyGuard, Pausable {
    address public immutable tokenImplementation;
    IUniswapV2Router02 public immutable router;
    LiquidityLocker public immutable locker;

    /// @notice See TokenFactory.MAX_FEE_BPS -- identical hard ceiling, same
    /// reasoning, applied here to curveFeeBps and the post-graduation feeBps.
    uint256 public constant MAX_FEE_BPS = 2_000; // 20.00%

    // ---- curve-phase parameters, snapshotted into each curve at creation
    // time (see createCurveToken) -- an owner change here only ever affects
    // curves created after the change, never one already live. ----

    uint256 public curveLaunchFee; // flat fee to create a curve token -- no pool exists yet, so this is priced like TokenFactory.deployFee, not launchFee
    uint256 public curveFeeBps = 100; // 1.00%, skimmed from the ETH leg of every buy and sell during the curve phase -- snapshotted into Curve.curveFeeBps at creation (see Finding 3)
    uint256 public curveSupplyBps = 8_000; // 80.00% of totalSupply_ tradable on the curve; the untouched remainder plus any unsold leftover is added to the pool at graduation -- nothing is ever burned
    uint256 public virtualEthReserveDefault = 3 ether; // absolute wei baseline added to every new curve's real ETH reserve, purely for pricing -- shapes how steeply price rises as real ETH comes in
    /// @notice Bps OF totalSupply_ (not an absolute token count) used as the
    /// virtual token reserve baseline, snapshotted per curve at creation as
    /// (totalSupply_ * virtualTokenReserveBps) / 10_000. Bps-of-supply rather
    /// than a fixed absolute number specifically because totalSupply_ is
    /// creator-chosen and varies launch to launch (unlike a platform with a
    /// single fixed supply for every token) -- an absolute virtual token
    /// reserve would give wildly different starting prices to tokens with
    /// different supplies for no reason connected to their actual scarcity.
    uint256 public virtualTokenReserveBps = 8_000; // 80.00% of totalSupply_
    /// @notice Real ETH (net of curveFeeBps) a curve must accumulate before
    /// it can graduate -- i.e. how much ETH ends up seeding the resulting
    /// DEX pool. Deliberately kept well below the constant-product
    /// exhaustion point implied by virtualEthReserveDefault/
    /// virtualTokenReserveBps/curveSupplyBps (at these defaults, a single
    /// buy demanding the curve's ENTIRE remaining supply would require
    /// slightly more than 3 ETH of real reserve) -- graduating with real,
    /// unsold curve supply still in reserve is the intended, pump.fun-like
    /// behavior (see the contract-level note on leftover supply), not an
    /// edge case to graze against.
    ///
    /// Named poolSeedTargetWei (not ethGraduationTarget) specifically to
    /// keep it visually and semantically distinct from graduationTargetUsd
    /// below -- the two are unrelated thresholds, in different units,
    /// gating two completely different transitions (this one gates
    /// curve-to-pool; that one gates the pool's own tax permanently
    /// disabling), and the near-identical old names invited exactly the
    /// kind of mix-up flagged in AUDIT-BondingCurveFactory.md Finding 6.
    uint256 public poolSeedTargetWei = 1.5 ether;

    /// @notice See TokenFactory.maxCreatorBuyBps -- identical anti-rug
    /// safeguard, applied to the optional same-transaction creator buy-in at
    /// curve creation, checked against the actual net tokens received.
    uint256 public maxCreatorBuyBps = 500; // 5.00% of totalSupply_ by default

    address public feeTreasury;
    uint256 public lpLockDuration;

    /// @notice PlatformRewardsDistributor's address. Used for TWO unrelated
    /// things here: (1) 50% of curveLaunchFee/curveFeeBps revenue, in native
    /// ETH, exactly like TokenFactory._finalizeLaunch (see _distributeEthFee)
    /// while this is set, and (2) the ongoing POST-graduation LaunchedToken
    /// transfer-tax carve-out via rewardBps below, exactly like every other
    /// factory. address(0) (the default) disables both: curveLaunchFee/
    /// curveFeeBps revenue stays 100% feeTreasury, and every curve that
    /// graduates from here on configures its token with no reward diversion.
    /// Deliberately read LIVE at every trade and at graduation time, never
    /// snapshotted -- this is "is the feature live yet," not a term any
    /// buyer bought into (see the contract-level note on Finding 4).
    address public rewardsDistributor;
    uint256 public rewardBps = 45; // 0.45% -- POST-graduation tax carve-out only, see LaunchedToken.configureTax -- snapshotted into Curve.taxRewardBps at creation (see Finding 4)

    /// @notice CreatorRewardsDistributor's address -- POST-graduation
    /// LaunchedToken transfer-tax carve-out only (see the contract-level
    /// note on why curve-phase fees never use this). address(0) disables it
    /// entirely for curves graduating from here on. Live, not snapshotted --
    /// see the note on rewardsDistributor above.
    address public creatorRewardsDistributor;
    uint256 public creatorRewardBps = 10; // 0.10% -- POST-graduation tax carve-out only -- snapshotted into Curve.taxCreatorRewardBps at creation

    /// @notice FeeWalletDistributor's address -- POST-graduation
    /// LaunchedToken transfer-tax remainder only, same convention as every
    /// other factory. address(0) disables it entirely. Live, not
    /// snapshotted -- see the note on rewardsDistributor above.
    address public feeWalletDistributor;

    // ---- post-graduation LaunchedToken tax defaults -- identical fields,
    // identical meaning, and identical setTaxDefaults() bounds to
    // TokenFactory/CustomTokenFactory's own copies. Unlike TokenFactory
    // (where "at launch" and "at configuration" are the same instant), a
    // curve can sit unsold for an arbitrary time before graduating, so these
    // seven values are snapshotted into the Curve struct at createCurveToken()
    // time and applied from there -- see the Curve.tax* fields and Finding 4.
    // The globals below remain the CURRENT defaults applied to curves
    // created from this point forward; changing them never touches a curve
    // that already exists. ----
    address public platformFeeWallet;
    uint256 public feeBps = 100; // 1.00%
    address public priceFeed;
    uint256 public graduationTargetUsd = 50_000; // whole dollars; the POST-graduation tax permanently disables once the pool's live market cap crosses this -- unrelated to poolSeedTargetWei above, see its own doc comment
    uint256 public maxOracleStaleness = 1 hours;

    /// @notice See TokenFactory.liquiditySlippageBps -- identical
    /// protection, applied to _doGraduate's own addLiquidityETH call (the
    /// pair does not exist before graduation, so this only ever guards
    /// against a router that doesn't use the full amounts offered, not
    /// front-running an existing pool).
    uint256 public liquiditySlippageBps = 600; // 6.00% default, i.e. the midpoint of the allowed band
    uint256 public constant MIN_LIQUIDITY_SLIPPAGE_BPS = 500; // 5.00%
    uint256 public constant MAX_LIQUIDITY_SLIPPAGE_BPS = 800; // 8.00%

    function _minWithSlippage(uint256 amount) private view returns (uint256) {
        return amount - (amount * liquiditySlippageBps) / 10_000;
    }

    struct Curve {
        address creator;
        uint256 totalSupply; // the token's full totalSupply_, snapshotted at creation
        uint256 curveSupply; // portion of totalSupply allocated to the curve at creation -- the untouched (totalSupply - curveSupply) always sits on this factory's own balance of `token` until graduation
        uint256 tokensRemaining; // curve-held tokens still available to sell; starts at curveSupply, falls on buys, rises on sells
        uint256 virtualEthReserve;
        uint256 virtualTokenReserve;
        uint256 realEthReserve; // real ETH accumulated net of curveFeeBps -- this, and only this, is what actually seeds the pool at graduation. Zeroed in _doGraduate (Finding 2) once that ETH has actually left for the pool.
        uint256 poolSeedTargetWei; // snapshotted at creation -- see the state variable's own doc comment
        uint256 curveFeeBps; // snapshotted at creation (Finding 3) -- this curve's trading fee is fixed for its lifetime regardless of later setCurveFeeBps() calls
        bool graduated;
        uint256 createdAt;
        // ---- post-graduation tax terms, snapshotted at creation (Finding 4) ----
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
    /// fallback reverted (see Finding 1). Stays on this contract's own
    /// balance, tracked here rather than lost, until an owner sweeps it via
    /// rescueStrandedFees() -- typically after fixing whichever address was
    /// rejecting the transfer.
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
        uint256 poolSeedTargetWei
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

    /// @notice Emitted whenever _distributeEthFee couldn't deliver a fee
    /// share to `recipient` -- see Finding 1 and strandedFees above. Never
    /// reverts the trade that generated it; purely informational so this
    /// can be monitored and acted on (fix the recipient, or sweep via
    /// rescueStrandedFees()).
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
        require(tokenImplementation_ != address(0), "BondingCurveFactory: invalid token implementation");
        require(router_ != address(0), "BondingCurveFactory: invalid router");
        require(locker_ != address(0), "BondingCurveFactory: invalid locker");
        require(feeTreasury_ != address(0), "BondingCurveFactory: invalid treasury");

        tokenImplementation = tokenImplementation_;
        router = IUniswapV2Router02(router_);
        locker = LiquidityLocker(locker_);
        curveLaunchFee = curveLaunchFee_;
        feeTreasury = feeTreasury_;
        lpLockDuration = lpLockDuration_;
        platformFeeWallet = platformFeeWallet_;
        priceFeed = priceFeed_;
    }

    /// @notice Absorbs any ETH the router refunds mid-addLiquidityETH (real
    /// Uniswap V2 routers refund unused ETH straight to msg.sender when the
    /// actual optimal amounts used are less than what was sent). Without
    /// this, such a refund would revert the entire graduation -- a much
    /// worse outcome here than on TokenFactory's atomic one-shot launch,
    /// since it would permanently strand a curve's accumulated ETH and
    /// tokens instead of just failing one deploy transaction that can be
    /// resubmitted. Also, unavoidably, accepts a stray direct ETH transfer
    /// from anyone else -- see rescueStrandedFees()/rescueToken() (Finding 5)
    /// for how that gets recovered rather than permanently stuck.
    receive() external payable {}

    /// @dev See TokenFactory._deriveTokenSalt for the full reasoning --
    /// binds the actual CREATE2 salt to the creator so a mempool-visible
    /// salt can't be copied and front-run by a third party.
    function _deriveTokenSalt(address creator_, uint256 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator_, salt));
    }

    /// @dev Constant-product quote against this curve's CURRENT effective
    /// reserves (virtual + real), fee-first: this curve's own snapshotted
    /// curveFeeBps (Finding 3) is skimmed off the incoming ETH before it
    /// ever touches the constant-product formula, so the fee is never
    /// itself priced as if it were a trade.
    function _quoteBuy(Curve storage curve, uint256 ethIn) private view returns (uint256 tokensOut, uint256 feeAmount, uint256 netEthIn) {
        feeAmount = (ethIn * curve.curveFeeBps) / 10_000;
        netEthIn = ethIn - feeAmount;
        uint256 effEth = curve.virtualEthReserve + curve.realEthReserve;
        uint256 effToken = curve.virtualTokenReserve + curve.tokensRemaining;
        tokensOut = (netEthIn * effToken) / (effEth + netEthIn);
    }

    /// @dev Constant-product quote for a sell, fee-last: the gross ETH the
    /// constant-product formula implies is computed first, then this
    /// curve's own snapshotted curveFeeBps is skimmed off that gross amount
    /// -- symmetric with _quoteBuy applying its fee before pricing, since
    /// here the ETH being priced is the OUTPUT leg, not the input.
    function _quoteSell(Curve storage curve, uint256 tokenAmountIn) private view returns (uint256 ethOutGross, uint256 feeAmount, uint256 netEthOut) {
        uint256 effEth = curve.virtualEthReserve + curve.realEthReserve;
        uint256 effToken = curve.virtualTokenReserve + curve.tokensRemaining;
        ethOutGross = (tokenAmountIn * effEth) / (effToken + tokenAmountIn);
        feeAmount = (ethOutGross * curve.curveFeeBps) / 10_000;
        netEthOut = ethOutGross - feeAmount;
    }

    /// @dev Same 50/50 feeTreasury/rewardsDistributor split as
    /// TokenFactory._finalizeLaunch -- see the contract-level note on why
    /// curve-phase ETH revenue reuses this instead of
    /// creatorRewardsDistributor/feeWalletDistributor.
    ///
    /// Post-audit (Finding 1): neither transfer's failure reverts the
    /// caller anymore. `.call{value}("")` already returns a bool rather
    /// than throwing -- the ONLY reason a failure used to revert the whole
    /// buy()/sell()/createCurveToken() was this function's own `require`
    /// right after it. Removing that `require` and instead tracking the
    /// undelivered amount in strandedFees (recoverable later via
    /// rescueStrandedFees) means a misbehaving fee recipient can no longer
    /// block trading, and in particular can no longer block sell() --
    /// closing the gap between what pause()'s own doc comment promises
    /// ("holders must always be able to exit") and what actually held true
    /// before this fix.
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

    /// @dev Shared core of a buy, used both by buy() itself and by
    /// createCurveToken()'s optional same-transaction creator buy-in.
    /// Checks-effects-interactions: curve storage is updated before the fee
    /// distribution and token transfer below run. Ends with a defense-in-
    /// depth invariant check mirroring LiquidityLocker.totalLocked's own
    /// balance-vs-bookkeeping check -- this factory's real balance of
    /// `token` must always be at least what its own bookkeeping claims is
    /// still backed (curve.tokensRemaining, plus the untouched
    /// totalSupply-curveSupply reserve).
    function _executeBuy(
        address token,
        Curve storage curve,
        address recipient,
        uint256 ethIn,
        uint256 minTokensOut
    ) private returns (uint256 tokensOut, uint256 feeAmount) {
        uint256 netEthIn;
        (tokensOut, feeAmount, netEthIn) = _quoteBuy(curve, ethIn);
        require(tokensOut > 0, "BondingCurveFactory: zero tokens out");
        require(tokensOut <= curve.tokensRemaining, "BondingCurveFactory: exceeds curve supply");
        require(tokensOut >= minTokensOut, "BondingCurveFactory: slippage");

        curve.realEthReserve += netEthIn;
        curve.tokensRemaining -= tokensOut;

        _distributeEthFee(feeAmount);

        bool sent = IERC20(token).transfer(recipient, tokensOut);
        require(sent, "BondingCurveFactory: token transfer failed");

        require(
            IERC20(token).balanceOf(address(this)) >= curve.tokensRemaining + (curve.totalSupply - curve.curveSupply),
            "BondingCurveFactory: token balance invariant violated"
        );
    }

    /// @notice Deploy a new curve token. No ETH from the creator ever pairs
    /// into a pool here -- that's the entire point of this mode. msg.value
    /// must equal curveLaunchFee + creatorBuyEthAmount exactly.
    /// creatorBuyEthAmount is optional (0 skips it): an ordinary buy against
    /// the freshly-created curve, in this same transaction, guaranteed to be
    /// its first trade, capped at maxCreatorBuyBps of totalSupply_ checked
    /// against the actual net tokens received -- same anti-rug convention as
    /// every other factory's creator buy-in.
    ///
    /// Snapshots curveFeeBps and the seven post-graduation tax parameters
    /// into this curve at the moment it's created (Findings 3 and 4) -- an
    /// owner changing any of those afterward only ever affects curves
    /// created from that point forward, never this one.
    /// @param salt Caller-chosen CREATE2 salt input -- see
    /// TokenFactory.createToken's matching parameter doc for the full
    /// explanation; applies identically here (predictTokenAddress previews
    /// the resulting address; the real salt used is derived from
    /// (msg.sender, salt) so it's bound to the caller and can't be
    /// front-run).
    function createCurveToken(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        uint256 creatorBuyEthAmount,
        uint256 minCreatorTokensOut,
        uint256 salt
    ) external payable nonReentrant returns (address token, uint256 creatorTokensBought) {
        require(bytes(name_).length > 0, "BondingCurveFactory: name required");
        require(bytes(symbol_).length > 0, "BondingCurveFactory: symbol required");
        require(totalSupply_ > 0, "BondingCurveFactory: supply must be > 0");
        require(msg.value == curveLaunchFee + creatorBuyEthAmount, "BondingCurveFactory: incorrect ETH sent");
        require(platformFeeWallet != address(0), "BondingCurveFactory: platform fee wallet not configured");
        require(priceFeed != address(0), "BondingCurveFactory: price feed not configured");

        token = Clones.cloneDeterministic(tokenImplementation, _deriveTokenSalt(msg.sender, salt));
        LaunchedToken(token).initialize(name_, symbol_, totalSupply_, msg.sender, address(this), address(this));

        uint256 curveSupply = (totalSupply_ * curveSupplyBps) / 10_000;
        require(curveSupply > 0, "BondingCurveFactory: curve supply rounds to zero");

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
            curve.virtualEthReserve, curve.virtualTokenReserve, curve.poolSeedTargetWei
        );

        if (creatorBuyEthAmount > 0) {
            (uint256 tokensOut, ) = _executeBuy(token, curve, msg.sender, creatorBuyEthAmount, minCreatorTokensOut);
            require(
                tokensOut <= (totalSupply_ * maxCreatorBuyBps) / 10_000,
                "BondingCurveFactory: creator buy-in exceeds max allowed share of supply"
            );
            creatorTokensBought = tokensOut;
            emit CreatorBought(token, msg.sender, creatorBuyEthAmount, tokensOut);

            // Same auto-graduation attempt as buy() -- a creator buy-in
            // large enough to cross poolSeedTargetWei on its own must not
            // leave the curve stuck "crossed but ungraduated" just because
            // it arrived via this code path instead of a plain buy().
            if (curve.realEthReserve >= curve.poolSeedTargetWei) {
                try this._attemptGraduate(token) returns (address, uint256, uint256) {} catch {}
            }
        }

        _distributeEthFee(curveLaunchFee);
    }

    /// @notice Buy curve tokens with ETH. Reverts if this curve has already
    /// graduated (trade against the real pool instead, same as any other
    /// launched token). Auto-attempts graduation at the end, once
    /// realEthReserve crosses this curve's own poolSeedTargetWei -- wrapped
    /// so a failure there (e.g. a misbehaving router) degrades to "not
    /// graduated yet" rather than reverting this buy; see graduate() for the
    /// guaranteed fallback. Paused independently of sell() -- see
    /// pause()/unpause().
    function buy(address token, uint256 minTokensOut) external payable nonReentrant whenNotPaused returns (uint256 tokensOut) {
        Curve storage curve = curves[token];
        require(curve.totalSupply > 0, "BondingCurveFactory: unknown curve");
        require(!curve.graduated, "BondingCurveFactory: already graduated");
        require(msg.value > 0, "BondingCurveFactory: no ETH sent");

        uint256 feeAmount;
        (tokensOut, feeAmount) = _executeBuy(token, curve, msg.sender, msg.value, minTokensOut);

        emit CurveBought(token, msg.sender, msg.value, feeAmount, tokensOut, curve.realEthReserve);

        if (curve.realEthReserve >= curve.poolSeedTargetWei) {
            try this._attemptGraduate(token) returns (address, uint256, uint256) {} catch {}
        }
    }

    /// @notice Sell curve tokens back for ETH. Never pausable -- holders
    /// must always be able to exit a live curve, and (post-audit, Finding 1)
    /// that guarantee no longer depends on feeTreasury/rewardsDistributor
    /// accepting their cut either -- see _distributeEthFee. Checks-effects-
    /// interactions: curve storage is updated before the token pull and
    /// before the ETH payout, the first place in this codebase that pushes
    /// ETH out purely off stored state rather than forwarding it straight
    /// through a router in the same call.
    function sell(address token, uint256 tokenAmountIn, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        Curve storage curve = curves[token];
        require(curve.totalSupply > 0, "BondingCurveFactory: unknown curve");
        require(!curve.graduated, "BondingCurveFactory: already graduated");
        require(tokenAmountIn > 0, "BondingCurveFactory: zero amount");

        (uint256 ethOutGross, uint256 feeAmount, uint256 netEthOut) = _quoteSell(curve, tokenAmountIn);
        require(ethOutGross <= curve.realEthReserve, "BondingCurveFactory: exceeds real ETH reserve");
        require(netEthOut >= minEthOut, "BondingCurveFactory: slippage");

        curve.tokensRemaining += tokenAmountIn;
        curve.realEthReserve -= ethOutGross;

        bool pulled = IERC20(token).transferFrom(msg.sender, address(this), tokenAmountIn);
        require(pulled, "BondingCurveFactory: token transferFrom failed");
        require(
            IERC20(token).balanceOf(address(this)) >= curve.tokensRemaining + (curve.totalSupply - curve.curveSupply),
            "BondingCurveFactory: token balance invariant violated"
        );

        _distributeEthFee(feeAmount);

        ethOut = netEthOut;
        (bool sentEth, ) = payable(msg.sender).call{value: ethOut}("");
        require(sentEth, "BondingCurveFactory: ETH payout failed");

        emit CurveSold(token, msg.sender, tokenAmountIn, feeAmount, ethOut, curve.realEthReserve);
    }

    /// @notice Permissionless graduation once a curve's realEthReserve has
    /// crossed its own poolSeedTargetWei -- the guaranteed fallback to
    /// buy()'s own best-effort inline attempt (see buy() above). A genuine
    /// failure here (e.g. the router reverting) reverts visibly to the
    /// caller, rather than being swallowed.
    function graduate(address token) external nonReentrant returns (address pair, uint256 lpAmount, uint256 lockId) {
        Curve storage curve = curves[token];
        require(curve.totalSupply > 0, "BondingCurveFactory: unknown curve");
        require(!curve.graduated, "BondingCurveFactory: already graduated");
        require(curve.realEthReserve >= curve.poolSeedTargetWei, "BondingCurveFactory: graduation target not met");
        return _doGraduate(token, curve);
    }

    /// @dev External purely so buy() can wrap it in try/catch (Solidity's
    /// try/catch only guards external calls) without colliding with
    /// graduate()'s own nonReentrant guard -- this function deliberately
    /// carries NO nonReentrant modifier of its own (it relies entirely on
    /// buy()'s already-active guard), so calling it via `this._attemptGraduate`
    /// from inside buy() is an ordinary external self-call, not a blocked
    /// reentrant one. Not meant to be called by anything but this contract
    /// itself, hence the msg.sender check -- same pattern as
    /// LaunchedToken._maybeAutoActivateTax. Re-checks every condition
    /// itself (rather than trusting buy()'s own check) and quietly returns
    /// zeroes if they no longer hold, instead of reverting -- the same
    /// degrade-gracefully convention as LaunchedToken._maybeDisableTax.
    function _attemptGraduate(address token) external returns (address pair, uint256 lpAmount, uint256 lockId) {
        require(msg.sender == address(this), "BondingCurveFactory: internal only");
        Curve storage curve = curves[token];
        if (curve.totalSupply == 0 || curve.graduated || curve.realEthReserve < curve.poolSeedTargetWei) {
            return (address(0), 0, 0);
        }
        return _doGraduate(token, curve);
    }

    /// @dev The actual graduation. Flips `graduated` before any external
    /// call below -- a reentrant buy()/sell() triggered from inside the
    /// router/locker/configureTax calls can never observe a half-graduated
    /// curve. Seeds the pool with the factory's ENTIRE remaining balance of
    /// `token` (curve.tokensRemaining plus the untouched
    /// totalSupply-curveSupply reserve -- nothing is ever burned) and this
    /// curve's full realEthReserve, locks the resulting LP to the ORIGINAL
    /// creator recorded at curve creation (never to whoever happened to call
    /// graduate()), and opts the token into the SAME post-graduation tax
    /// terms that were in effect when this curve was CREATED (Finding 4) --
    /// curve.tax* fields, not the live platformFeeWallet/feeBps/etc.
    /// globals.
    ///
    /// Post-audit (Finding 2): curve.realEthReserve is now zeroed here,
    /// right after being read into ethForPool and before any external call
    /// -- previously this field was left stale forever after graduation,
    /// so curveState() kept reporting a nonzero "real ETH reserve" for a
    /// curve whose ETH had already moved into the pool.
    function _doGraduate(address token, Curve storage curve) private returns (address pair, uint256 lpAmount, uint256 lockId) {
        curve.graduated = true;

        uint256 tokensForPool = IERC20(token).balanceOf(address(this));
        uint256 ethForPool = curve.realEthReserve;
        curve.realEthReserve = 0; // Finding 2 fix -- effects before interactions, same discipline as the rest of this function
        require(tokensForPool > 0 && ethForPool > 0, "BondingCurveFactory: nothing to graduate");

        IERC20(token).approve(address(router), tokensForPool);
        (, , uint256 lpAmountAdded) = router.addLiquidityETH{value: ethForPool}(
            token,
            tokensForPool,
            _minWithSlippage(tokensForPool),
            _minWithSlippage(ethForPool),
            address(locker), // LP tokens mint straight to the locker -- never pass through this factory
            block.timestamp + 15 minutes
        );
        lpAmount = lpAmountAdded;

        pair = IUniswapV2FactoryMinimal(router.factory()).getPair(token, router.WETH());
        require(pair != address(0), "BondingCurveFactory: pair not found after addLiquidityETH");
        pairOf[token] = pair;

        uint256 effectiveRewardBps = rewardsDistributor != address(0) ? curve.taxRewardBps : 0;
        uint256 effectiveCreatorRewardBps = creatorRewardsDistributor != address(0) ? curve.taxCreatorRewardBps : 0;
        LaunchedToken(token).configureTax(
            pair, curve.taxPlatformFeeWallet, curve.taxFeeBps, curve.taxPriceFeed, curve.taxGraduationTargetUsd, curve.taxMaxOracleStaleness,
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
        require(curve.totalSupply > 0, "BondingCurveFactory: unknown curve");
        (tokensOut, feeAmount, ) = _quoteBuy(curve, ethIn);
    }

    function quoteSell(address token, uint256 tokenAmountIn) external view returns (uint256 ethOut, uint256 feeAmount) {
        Curve storage curve = curves[token];
        require(curve.totalSupply > 0, "BondingCurveFactory: unknown curve");
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
        require(curve.totalSupply > 0, "BondingCurveFactory: unknown curve");
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
    /// locked into (Finding 4) -- snapshotted once, at createCurveToken()
    /// time, and applied verbatim in _doGraduate whenever this curve
    /// eventually graduates, regardless of what setTaxDefaults() has done
    /// to the live globals in the meantime.
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
        require(curve.totalSupply > 0, "BondingCurveFactory: unknown curve");
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
    /// given (creator, salt) pair -- see TokenFactory.predictTokenAddress
    /// for the full explanation; applies identically here.
    function predictTokenAddress(address creator_, uint256 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(tokenImplementation, _deriveTokenSalt(creator_, salt), address(this));
    }

    // ---- admin ----

    function setCurveFeeBps(uint256 newBps) external onlyOwner {
        require(newBps <= MAX_FEE_BPS, "BondingCurveFactory: feeBps exceeds MAX_FEE_BPS ceiling");
        curveFeeBps = newBps;
        emit CurveFeeBpsUpdated(newBps);
    }

    function setCurveSupplyBps(uint256 newBps) external onlyOwner {
        require(newBps > 0 && newBps <= 10_000, "BondingCurveFactory: curveSupplyBps must be in (0, 10000]");
        curveSupplyBps = newBps;
        emit CurveSupplyBpsUpdated(newBps);
    }

    function setVirtualEthReserveDefault(uint256 newDefault) external onlyOwner {
        virtualEthReserveDefault = newDefault;
        emit VirtualEthReserveDefaultUpdated(newDefault);
    }

    function setVirtualTokenReserveBps(uint256 newBps) external onlyOwner {
        require(newBps > 0, "BondingCurveFactory: virtualTokenReserveBps must be > 0");
        virtualTokenReserveBps = newBps;
        emit VirtualTokenReserveBpsUpdated(newBps);
    }

    /// @notice Updates the default real-ETH-raised threshold (in wei) new
    /// curves must cross before they graduate into a pool. Renamed from
    /// setEthGraduationTarget (Finding 6) to match the state variable's own
    /// rename -- only ever affects curves created after this call; a live
    /// curve keeps whatever value it snapshotted at its own creation.
    function setPoolSeedTargetWei(uint256 newTarget) external onlyOwner {
        require(newTarget > 0, "BondingCurveFactory: graduation target must be > 0");
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
        require(newBps <= 10_000, "BondingCurveFactory: bps cannot exceed 100%");
        maxCreatorBuyBps = newBps;
        emit MaxCreatorBuyBpsUpdated(newBps);
    }

    /// @notice See TokenFactory.setLiquiditySlippageBps -- identical fixed
    /// 5.00%-8.00% band, applied to _doGraduate's own addLiquidityETH call.
    function setLiquiditySlippageBps(uint256 newBps) external onlyOwner {
        require(newBps >= MIN_LIQUIDITY_SLIPPAGE_BPS, "BondingCurveFactory: slippage below 5% floor");
        require(newBps <= MAX_LIQUIDITY_SLIPPAGE_BPS, "BondingCurveFactory: slippage above 8% ceiling");
        liquiditySlippageBps = newBps;
        emit LiquiditySlippageBpsUpdated(newBps);
    }

    function setFeeTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "BondingCurveFactory: invalid treasury");
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

    /// @notice Update the POST-graduation LaunchedToken tax defaults applied
    /// to curves CREATED from this point forward (Finding 4 -- these are
    /// snapshotted per curve at createCurveToken() time, not read live at
    /// graduation, so this never touches an already-existing curve's own
    /// locked-in terms, however long it's been trading). See
    /// TokenFactory.setTaxDefaults for the full explanation of every bound
    /// enforced below -- identical reasoning, identical ceiling.
    function setTaxDefaults(
        address platformFeeWallet_,
        uint256 feeBps_,
        address priceFeed_,
        uint256 graduationTargetUsd_,
        uint256 maxOracleStaleness_,
        uint256 rewardBps_,
        uint256 creatorRewardBps_
    ) external onlyOwner {
        require(feeBps_ <= MAX_FEE_BPS, "BondingCurveFactory: feeBps exceeds MAX_FEE_BPS ceiling");
        require(graduationTargetUsd_ > 0, "BondingCurveFactory: graduation target must be > 0");
        require(maxOracleStaleness_ > 0, "BondingCurveFactory: oracle staleness must be > 0");
        require(rewardBps_ + creatorRewardBps_ <= feeBps_, "BondingCurveFactory: rewardBps+creatorRewardBps cannot exceed feeBps");
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
    /// price feed has gone permanently stale -- see
    /// TokenFactory.updateTokenPriceFeed / LaunchedToken.updatePriceFeed for
    /// the full explanation; applies identically here. Deliberately calls
    /// into the token directly rather than touching curve.taxPriceFeed
    /// (which stops mattering the moment a curve graduates -- configureTax
    /// already ran, once, with whatever value was snapshotted at that time).
    function updateTokenPriceFeed(address token, address newPriceFeed_, uint256 newMaxOracleStaleness_) external onlyOwner {
        LaunchedToken(token).updatePriceFeed(newPriceFeed_, newMaxOracleStaleness_);
        emit TokenPriceFeedUpdated(token, newPriceFeed_, newMaxOracleStaleness_);
    }

    /// @notice Sweeps ETH that _distributeEthFee couldn't deliver (Finding 1
    /// / strandedFees) to `to`. Deliberately scoped to ONLY the tracked
    /// strandedFees counter -- never address(this).balance directly -- so
    /// this can never touch a live curve's own realEthReserve or a router
    /// refund still earmarked for a specific curve's graduation.
    function rescueStrandedFees(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "BondingCurveFactory: invalid recipient");
        require(amount <= strandedFees, "BondingCurveFactory: exceeds stranded fees");
        strandedFees -= amount;
        (bool sent, ) = payable(to).call{value: amount}("");
        require(sent, "BondingCurveFactory: rescue transfer failed");
        emit StrandedFeesRescued(to, amount);
    }

    /// @notice Rescues an ERC20 mistakenly sent directly to this contract
    /// (Finding 5). Cannot be used on any token this factory itself ever
    /// created as a curve -- live or already graduated -- so this can never
    /// be used to pull a curve's own tracked token balance; it only reaches
    /// a token that has nothing to do with any curve at all.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "BondingCurveFactory: invalid recipient");
        require(creatorOf[token] == address(0), "BondingCurveFactory: cannot rescue a curve's own token");
        bool sent = IERC20(token).transfer(to, amount);
        require(sent, "BondingCurveFactory: token rescue failed");
        emit TokenRescued(token, to, amount);
    }

    /// @notice Circuit breaker on new buy() calls only -- sell() is never
    /// pausable, so a holder can always exit a live curve regardless of
    /// this. See the contract-level note on why this factory (uniquely
    /// among HoodLaunch's contracts so far) needs one at all: it sits on
    /// every live curve's pooled ETH simultaneously, for as long as each one
    /// trades.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
