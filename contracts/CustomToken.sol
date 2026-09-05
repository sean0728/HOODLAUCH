// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./interfaces/IAggregatorV3.sol";

/// @title CustomToken
/// @notice A configurable ERC20 that CustomTokenFactory clones (EIP-1167,
/// same pattern as LaunchedToken) for the "advanced" launch path — a
/// creator picks a tax rate (0% is a valid choice, same contract either
/// way) split across up to four fee types, each independently on or off:
///
///  - reflections: a share of every buy/sell is swapped and distributed to
///    every holder, proportional to their balance, in either the chain's
///    native ETH or a specific ERC20 the creator names at launch. Every
///    holder's claimable balance grows on its own, proportional to their
///    holdings, the moment a distribution happens — no action needed from
///    them at all. Payout itself has two paths, both drawing from the exact
///    same accounting so nobody can ever be paid twice for one
///    distribution: anyone can call pushReflections() to sweep a batch of
///    holders and pay each one directly (this is what makes payout
///    "automatic" — it doesn't require this specific holder to lift a
///    finger, only *someone* to call it, e.g. an off-chain keeper on a
///    schedule — see scripts/pushReflections.js), and a holder who'd rather
///    not wait for the sweep to reach them can still call
///    claimReflections() themselves at any time. Deliberately NOT done by
///    looping over holders inside the transfer itself — that's exactly how
///    fee tokens end up with a transfer that can be gas-griefed into
///    failing, so pushReflections() is a separate, gas-bounded,
///    caller-chosen batch instead (same anti-griefing shape as
///    PlatformRewardsDistributor.processAirdropBatch).
///  - marketing: a share is swapped for ETH and sent to marketingWallet,
///    which the creator (and only the creator) can repoint later via
///    setMarketingWallet().
///  - liquidity: a share is split in half, one half swapped for ETH, and
///    both halves added back into this token's own pool as new liquidity —
///    the resulting LP tokens are sent straight to a burn address, so this
///    stream of liquidity can never be pulled back out by anyone.
///  - burn: a share is destroyed outright via a real burn (totalSupply
///    actually decreases — see _update below), not just moved to a "dead"
///    wallet that still counts toward supply.
///
/// Buy tax and sell tax are set independently, each capped at 5% (see
/// MAX_TOTAL_BPS) — enforced once, at initialize(), and immutable for the
/// life of the token from that point on. Nothing in this contract can
/// ever raise, lower, or otherwise touch buyFees/sellFees or the
/// platform's own platformFeeBps after that point — there is no setter
/// for any of them anywhere below. What CAN change after launch is
/// operational, never the rate itself: the marketing wallet address, the
/// swap-threshold batching knob, the processing-slippage tolerance, the
/// rewards-blocked list, and a tax-exemption whitelist (isTaxExempt /
/// setTaxExempt — bypasses tax entirely for a specific address, but never
/// changes what rate anyone else pays). All of those, plus the creator
/// role itself, go permanently dark the moment the creator calls
/// renounceCreator() — see that function and transferCreator/
/// acceptCreator below. This is deliberate: the classic "creator jacks up
/// the sell tax after launch" rug is closed off at the rate level, not
/// just gated behind a role that could be renounced later.
contract CustomToken is ERC20, ReentrancyGuard {
    bool private _initialized;

    address public creator;
    /// @notice Set by transferCreator(); becomes `creator` once the
    /// proposed address calls acceptCreator() itself. Mirrors the
    /// Ownable2Step pattern already used for every other privileged role
    /// in this codebase (TokenFactory/CustomTokenFactory/LiquidityLocker
    /// owners) so a single mistyped address can never permanently strand
    /// the creator role — see setMarketingWallet, setSwapThreshold,
    /// setRewardsBlocked, activateIndependentPair, and rescueToken/
    /// rescueEth below, all of which become permanently uncallable
    /// without a working creator address.
    address public pendingCreator;
    address public factory;
    address public router;
    address public pair; // set once, by the factory, right after it seeds this token's pool
    uint256 public launchedAt;
    string private _tokenName;
    string private _tokenSymbol;

    address private constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice One side's fee split, all in bps of the transferred amount.
    /// A component at 0 is simply off. reflectionBps+marketingBps+
    /// liquidityBps+burnBps together must be <= MAX_TOTAL_BPS.
    struct FeeSet {
        uint16 reflectionBps;
        uint16 marketingBps;
        uint16 liquidityBps;
        uint16 burnBps;
    }
    uint16 public constant MAX_TOTAL_BPS = 500; // 5.00% per side, hard cap

    /// @dev Scratch struct used only inside _update() to hold one transfer's
    /// computed fee amounts. Purely a stack-pressure fix: with viaIR
    /// enabled, the Yul optimizer still has its own (separate from the EVM's
    /// classic 16-slot limit) ceiling on how many locals can be live at once
    /// in one function, and _update() calling the private _afterBalanceChange
    /// six times across several branches — each with a different subset of
    /// these amounts still live — was landing right at that ceiling ("too
    /// deep in the stack by 1 slots"). A memory struct collapses what used
    /// to be seven separate stack-resident uint256 locals into one memory
    /// pointer, which is what actually fixes it; the arithmetic and control
    /// flow below are otherwise unchanged from before this struct existed.
    struct TransferCuts {
        uint256 reflection;
        uint256 marketing;
        uint256 liquidity;
        uint256 burn;
        uint256 platform;
        uint256 total;
        uint256 toContract;
    }

    FeeSet public buyFees;
    FeeSet public sellFees;

    /// @notice address(0) means reflections pay out in the chain's native
    /// ETH; any other address is the ERC20 reflections pay out in instead
    /// (swapped for via router, routed through WETH). Fixed at launch.
    address public reflectionAsset;

    /// @notice Where the marketing fee's swapped ETH goes. The only
    /// mutable piece of this whole fee configuration — see
    /// setMarketingWallet(). A zero address here simply means the
    /// marketing fee components must be zero too (enforced at
    /// initialize()), since there'd be nowhere for that ETH to go.
    address public marketingWallet;

    // ---- platform-level graduating tax — entirely separate from, and not
    // counted against, the creator's own MAX_TOTAL_BPS cap above. Mirrors
    // LaunchedToken's tax exactly: a flat feeBps skimmed in-kind (no swap,
    // straight token transfer) to platformFeeWallet on every buy and sell,
    // until the pool's live market cap crosses graduationTargetUsd, at
    // which point it permanently disables itself. Wired once by the
    // factory via configurePlatformTax(), immediately after setPair() —
    // passing feeBps_ == 0 or a zero feeWallet_ leaves it permanently
    // inactive. ----
    bool public platformTaxConfigured;
    address public platformFeeWallet;
    uint256 public platformFeeBps; // 25 = 0.25%
    bool public platformTaxActive;
    IAggregatorV3 public priceFeed;
    uint256 public graduationTargetUsd; // whole dollars, e.g. 80000
    uint256 public maxOracleStaleness; // seconds; the tax-disable check is skipped (never reverted) if the feed is older than this

    // ---- reward diversion: carves a slice of the PLATFORM's own
    // platformFeeBps cut off to PlatformRewardsDistributor instead of
    // platformFeeWallet, on every taxed transfer. Never touches
    // reflectionCut/marketingCut/liquidityCut/burnCut above — those are the
    // creator's own separately-capped fee config (buyFees/sellFees) and
    // this feature has nothing to do with them. Snapshotted once, in
    // configurePlatformTax(), same convention as every other platform-tax
    // default here. rewardsDistributor == address(0) (the default) means
    // this is entirely inactive — 100% of platformFeeBps still goes to
    // platformFeeWallet, exactly as before this feature existed. ----
    address public rewardsDistributor;
    uint256 public rewardBps; // absolute bps of transfer value diverted to rewardsDistributor, carved OUT OF platformFeeBps (never on top of it); rewardBps + creatorRewardBps always <= platformFeeBps

    // ---- creator rewards: a second, independent carve-out of the
    // PLATFORM's own platformFeeBps, sent in-kind to
    // CreatorRewardsDistributor on every taxed transfer — never stacked
    // with rewardBps above (rewardBps + creatorRewardBps <= platformFeeBps
    // is enforced once, in configurePlatformTax()), and never touching
    // reflectionCut/marketingCut/liquidityCut/burnCut, which are the
    // creator's own separately-capped fee config and have nothing to do
    // with this feature. CreatorRewardsDistributor later swaps its
    // accumulated balance of this token for ETH and credits this token's
    // own creator, claimable through that contract — see
    // CreatorRewardsDistributor.sol and LaunchedToken's identical mirror of
    // this same feature. Same address(0)-means-inactive convention as
    // rewardsDistributor. ----
    address public creatorRewardsDistributor;
    uint256 public creatorRewardBps; // absolute bps of transfer value diverted to creatorRewardsDistributor, carved OUT OF platformFeeBps (never on top of it, and never overlapping rewardBps)

    /// @notice Hard ceiling on totalSupply_, enforced once at initialize().
    /// See LaunchedToken.MAX_TOTAL_SUPPLY for the full reasoning — purely
    /// defense-in-depth against currentMarketCapInFeedDecimals()'s own
    /// arithmetic overflowing for an extreme, unrealistic supply.
    uint256 public constant MAX_TOTAL_SUPPLY = 1_000_000_000_000_000 * 1e18; // 1 quadrillion tokens, 18 decimals

    /// @notice Mirrors LaunchedToken.graduationCandidateAt exactly — see
    /// that contract's comment for the full reasoning. 0 means "not
    /// currently a graduation candidate".
    uint256 public graduationCandidateAt;

    /// @notice Mirrors LaunchedToken.GRADUATION_CONFIRMATION_WINDOW.
    uint256 public constant GRADUATION_CONFIRMATION_WINDOW = 30 minutes;

    // ---- fees collected in-kind, awaiting a batched swap-and-process ----
    uint256 public pendingLiquidityTokens;
    uint256 public pendingMarketingTokens;
    uint256 public pendingReflectionTokens;

    /// @notice Total pending tokens (all three streams combined) needed
    /// before a sell or plain transfer will trigger the swap-and-process
    /// step. Defaults to 0.1% of supply; the creator can retune it (never
    /// above 5% of supply, so it can't be set so high it silently never
    /// fires) via setSwapThreshold().
    uint256 public swapThreshold;

    /// @notice Slippage tolerance applied as a protective amountOutMin
    /// floor to every internal swap-and-process trade (marketing's
    /// token-for-ETH swap, half of the liquidity fee's token-for-ETH swap,
    /// and the reflection fee's token-for-ETH-or-token swap), plus the
    /// liquidity-add's own token/ETH minimums — see _quoteOut/
    /// _applySlippage and Finding 2 of AUDIT-CustomToken.md. Before this,
    /// every one of these traded with amountOutMin: 0 (or 0,0), making
    /// them a predictable, repeatable MEV sandwich target since the
    /// trigger condition (pending fees crossing swapThreshold) is public
    /// on-chain state. Same 5.00%-8.00% band as TokenFactory/
    /// CustomTokenFactory's liquiditySlippageBps/buyInSlippageBps, but
    /// creator-adjustable here (via setProcessingSlippageBps) rather than
    /// platform-owned, since these trades only ever affect this specific
    /// token's own marketing/liquidity/reflection proceeds. Set to its
    /// 600 (6.00%) default inside initialize() rather than as an inline
    /// field initializer — this is a clone, and an inline initializer
    /// only ever runs in the implementation contract's own constructor,
    /// never on a clone (see swapThreshold above for the same reasoning).
    uint16 public processingSlippageBps;
    uint16 public constant MIN_PROCESSING_SLIPPAGE_BPS = 500; // 5.00%
    uint16 public constant MAX_PROCESSING_SLIPPAGE_BPS = 800; // 8.00%

    bool private _inSwap;
    modifier lockTheSwap() {
        _inSwap = true;
        _;
        _inSwap = false;
    }

    modifier onlyFactory() {
        require(msg.sender == factory, "CustomToken: caller is not the factory");
        _;
    }
    modifier onlyCreator() {
        require(msg.sender == creator, "CustomToken: caller is not the creator");
        _;
    }

    // ---- reflection accounting: the standard "magnified dividend per
    // share" pattern (as used by the widely-referenced DividendPayingToken
    // implementations) — O(1) per transfer, no loop over holders. Every
    // balance change (mint, burn, or transfer) adjusts a per-account
    // correction term so that accumulativeDividendOf() stays correct no
    // matter when someone's balance changed relative to past
    // distributions. See _afterBalanceChange / accumulativeDividendOf. ----
    uint256 private constant MAGNITUDE = 2 ** 128;
    uint256 public magnifiedDividendPerShare;
    mapping(address => int256) private _magnifiedDividendCorrections;
    mapping(address => uint256) public withdrawnDividends;
    uint256 public totalDividendsDistributed;
    uint256 public totalDividendsWithdrawn;

    /// @notice Creator-controlled block list: an address with
    /// isBlockedFromRewards[account] == true never shows or accrues any
    /// reflection entitlement, on either claimReflections() or
    /// pushReflections() — see accumulativeDividendOf() and
    /// setRewardsBlocked() below. Meant for the same kind of address the
    /// pair/address(this) exclusion above already covers automatically:
    /// a bot, a known bad actor, or any wallet the creator decides
    /// shouldn't farm reflections — not a way to touch anyone's token
    /// balance, trading ability, or already-claimed history.
    mapping(address => bool) public isBlockedFromRewards;

    /// @notice Creator-controlled tax-exemption whitelist: an address with
    /// isTaxExempt[account] == true pays (and triggers) no tax at all —
    /// neither the creator's own buy/sell fee (reflection/marketing/
    /// liquidity/burn) nor the platform's graduating tax — on any
    /// transfer where it's either side. See setTaxExempt() below for the
    /// full reasoning on why this is safe: it only ever changes WHO pays
    /// the already-fixed rate, never the rate itself.
    mapping(address => bool) public isTaxExempt;

    /// @notice True iff either side's reflectionBps was nonzero at
    /// initialize() — fixed for the token's life, exactly like every other
    /// rate here. Gates whether the holder registry below is maintained at
    /// all: a token that never uses reflections pays zero extra storage
    /// cost for a registry it will never need.
    bool public reflectionsEnabled;

    /// @notice Holder registry for pushReflections() below — same
    /// hand-rolled swap-and-pop array + 1-based index mapping as
    /// PlatformToken.sol (not OpenZeppelin's EnumerableSet, which pulls in
    /// an mcopy-only Arrays.sol incompatible with this project's paris EVM
    /// target). address(this) and `pair` can both end up recorded here as
    /// ordinary side effects of how tokens move during launch/liquidity
    /// seeding — pushReflections() skips both explicitly rather than
    /// trying to keep them out of the array, since `pair` in particular
    /// isn't even known yet at the moment liquidity is first seeded (see
    /// pushReflections' own comment).
    address[] private _reflectionHolders;
    mapping(address => uint256) private _reflectionHolderIndex; // 1-based; 0 = not currently tracked

    /// @notice Round-robin cursor into _reflectionHolders for
    /// pushReflections() — persists across calls so repeated sweeps keep
    /// covering fresh holders instead of always restarting at index 0.
    uint256 public reflectionPushCursor;

    /// @notice Gas forwarded on each native-ETH push in pushReflections()
    /// below — enough for a plain wallet or a simple forwarding contract to
    /// receive it, but capped so one holder's receive()/fallback can't
    /// consume the batch caller's entire remaining gas.
    uint256 public constant PUSH_GAS_STIPEND = 50_000;

    event TokenInitialized(string name, string symbol, uint256 totalSupply, address indexed creator);
    event PairSet(address indexed pair);
    event MarketingWalletUpdated(address indexed newWallet);
    event SwapThresholdUpdated(uint256 newThreshold);
    event RewardsAccessUpdated(address indexed account, bool blocked);
    event DividendsDistributed(uint256 amount);
    event DividendWithdrawn(address indexed to, uint256 amount);
    event ReflectionsPushed(uint256 holdersPaid, uint256 totalPaid, uint256 nextCursor);
    event LiquidityAutoAdded(uint256 tokenAmount, uint256 ethAmount, uint256 lpAmount);
    event MarketingFeeSent(uint256 ethAmount);
    event TokensBurned(uint256 amount);
    event PlatformTaxConfigured(address indexed feeWallet, uint256 feeBps, uint256 graduationTargetUsd);
    event PlatformTaxDisabled(uint256 marketCapInFeedDecimals);
    event GraduationCandidateObserved(uint256 marketCapInFeedDecimals, uint256 confirmEligibleAt);
    event GraduationCandidateReset();
    event PriceFeedUpdated(address indexed newPriceFeed, uint256 newMaxOracleStaleness);
    event ProcessingSlippageBpsUpdated(uint256 newBps);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event EthRescued(address indexed to, uint256 amount);
    event CreatorTransferStarted(address indexed previousCreator, address indexed newCreator);
    event CreatorTransferred(address indexed previousCreator, address indexed newCreator);
    event CreatorRenounced(address indexed previousCreator);
    event TaxExemptionUpdated(address indexed account, bool exempt);

    // Runs exactly once, on the implementation contract the factory clones
    // from. Never runs again on any clone.
    constructor() ERC20("", "") {
        _initialized = true;
    }

    receive() external payable {}

    function initialize(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address creator_,
        address mintTo_,
        address factory_,
        address router_,
        FeeSet memory buyFees_,
        FeeSet memory sellFees_,
        address reflectionAsset_,
        address marketingWallet_
    ) external {
        require(!_initialized, "CustomToken: already initialized");
        require(totalSupply_ > 0, "CustomToken: supply must be > 0");
        require(totalSupply_ <= MAX_TOTAL_SUPPLY, "CustomToken: supply too large");
        require(creator_ != address(0), "CustomToken: invalid creator");
        require(mintTo_ != address(0), "CustomToken: invalid mint recipient");
        require(factory_ != address(0), "CustomToken: invalid factory");
        require(router_ != address(0), "CustomToken: invalid router");
        require(reflectionAsset_ != address(this), "CustomToken: reflection asset cannot be this token");

        uint256 buyTotal = uint256(buyFees_.reflectionBps) + buyFees_.marketingBps + buyFees_.liquidityBps + buyFees_.burnBps;
        uint256 sellTotal = uint256(sellFees_.reflectionBps) + sellFees_.marketingBps + sellFees_.liquidityBps + sellFees_.burnBps;
        require(buyTotal <= MAX_TOTAL_BPS, "CustomToken: buy tax exceeds 5%");
        require(sellTotal <= MAX_TOTAL_BPS, "CustomToken: sell tax exceeds 5%");
        if (buyFees_.marketingBps > 0 || sellFees_.marketingBps > 0) {
            require(marketingWallet_ != address(0), "CustomToken: marketing wallet required when marketing fee is set");
        }

        _initialized = true;
        _tokenName = name_;
        _tokenSymbol = symbol_;
        creator = creator_;
        factory = factory_;
        router = router_;
        launchedAt = block.timestamp;
        buyFees = buyFees_;
        sellFees = sellFees_;
        reflectionAsset = reflectionAsset_;
        marketingWallet = marketingWallet_;
        swapThreshold = totalSupply_ / 1000; // 0.1% default; see setSwapThreshold()
        processingSlippageBps = 600; // 6.00% default; see setProcessingSlippageBps()
        reflectionsEnabled = buyFees_.reflectionBps > 0 || sellFees_.reflectionBps > 0;

        _mint(mintTo_, totalSupply_); // "deploy + liquidity": mints to the factory, which pairs it into the pool. "deploy only": mints straight to the creator — see CustomTokenFactory.createCustomToken.

        emit TokenInitialized(name_, symbol_, totalSupply_, creator_);
    }

    /// @notice One-time wiring step, called by the factory immediately
    /// after it seeds this token's pool — mirrors
    /// LaunchedToken.configureTax's role for the simpler contract.
    function setPair(address pair_) external onlyFactory {
        require(pair == address(0), "CustomToken: pair already set");
        require(pair_ != address(0), "CustomToken: invalid pair");
        pair = pair_;
        emit PairSet(pair_);
    }

    /// @notice The only way a "deploy-only" CustomToken (created via
    /// CustomTokenFactory.createCustomToken with addLiquidity=false) can
    /// ever activate its own buy/sell tax: _update()'s isBuy/isSell checks
    /// are gated on `pair` being set, and the deploy-only path never calls
    /// setPair() above — the full supply just mints straight to the
    /// creator, with no pool, no tax of any kind, exactly like
    /// TokenFactory's "Deploy Token". If that creator later adds liquidity
    /// entirely on their own — a plain call to the DEX router, completely
    /// outside this platform — the pool exists, but this token still has
    /// no idea about it until someone calls this.
    ///
    /// Only the creator can call it (their own choice when to switch their
    /// configured tax on), and only once, and only after a real pool
    /// actually exists: the pair address itself is never taken as an
    /// argument — it's derived the same trustless way
    /// CustomTokenFactory._seedLiquidityAndBuyIn does it, straight off the
    /// DEX factory's own getPair(token, WETH), so nobody can point `pair`
    /// at an arbitrary address.
    ///
    /// Deliberately does nothing to the platform's own graduating tax.
    /// configurePlatformTax() is onlyFactory and is only ever invoked from
    /// CustomTokenFactory._seedLiquidityAndBuyIn() — a path a deploy-only
    /// token's creation never went through — so platformTaxConfigured and
    /// platformTaxActive stay false forever here, no matter when this is
    /// called: the platform's 0.25% tax is permanently out of reach for a
    /// "Deploy Custom Tax Token" launch, exactly as intended. The
    /// resulting pool is also never LP-locked by this platform — that
    /// only ever happens inside the atomic addLiquidity=true path — so
    /// activating here doesn't create or imply any lock.
    function activateIndependentPair() external onlyCreator {
        require(pair == address(0), "CustomToken: pair already set");
        address dexFactory = IUniswapV2Router02(router).factory();
        address weth = IUniswapV2Router02(router).WETH();
        address detectedPair = IUniswapV2FactoryMinimal(dexFactory).getPair(address(this), weth);
        require(detectedPair != address(0), "CustomToken: no pool found yet");
        pair = detectedPair;
        emit PairSet(detectedPair);
    }

    /// @notice One-time wiring step, called by the factory immediately
    /// after setPair() — mirrors LaunchedToken.configureTax, but for a
    /// platform-level fee stream that sits entirely apart from the
    /// creator's own buyFees/sellFees above (it isn't counted against
    /// MAX_TOTAL_BPS, and it's skimmed in-kind rather than batched through
    /// the swap-and-process pipeline). Passing feeBps_ == 0 or a zero
    /// feeWallet_ records the settings but leaves the tax permanently
    /// inactive — e.g. for a deployment where the platform takes no cut.
    function configurePlatformTax(
        address feeWallet_,
        uint256 feeBps_,
        address priceFeed_,
        uint256 graduationTargetUsd_,
        uint256 maxOracleStaleness_,
        address rewardsDistributor_,
        uint256 rewardBps_,
        address creatorRewardsDistributor_,
        uint256 creatorRewardBps_
    ) external onlyFactory {
        require(!platformTaxConfigured, "CustomToken: platform tax already configured");
        require(pair != address(0), "CustomToken: pair not set yet");
        require(rewardBps_ + creatorRewardBps_ <= feeBps_, "CustomToken: rewardBps+creatorRewardBps exceeds feeBps");
        require(rewardsDistributor_ != address(0) || rewardBps_ == 0, "CustomToken: rewardBps requires a distributor");
        require(
            creatorRewardsDistributor_ != address(0) || creatorRewardBps_ == 0,
            "CustomToken: creatorRewardBps requires a distributor"
        );
        // Defends against the platform's own feeBps_ and this token's
        // already-locked-in creator-side tax (buyFees/sellFees, set back
        // at initialize()) summing past 100%. If they ever did,
        // _update()'s `value - totalCut` would underflow and revert on
        // every single taxed transfer of this token, permanently, since
        // neither side's fee rate can change after this point — see
        // Finding 3 of AUDIT-CustomToken.md. Not exploitable under any
        // config shipped today (platform defaults are far below this),
        // but this closes the combination off at configuration time
        // rather than relying on the platform owner never raising feeBps_
        // without checking.
        uint256 buyTotal = uint256(buyFees.reflectionBps) + buyFees.marketingBps + buyFees.liquidityBps + buyFees.burnBps;
        uint256 sellTotal = uint256(sellFees.reflectionBps) + sellFees.marketingBps + sellFees.liquidityBps + sellFees.burnBps;
        uint256 maxCreatorTotal = buyTotal > sellTotal ? buyTotal : sellTotal;
        require(feeBps_ + maxCreatorTotal <= 10_000, "CustomToken: combined platform and creator tax exceeds 100%");

        platformTaxConfigured = true;
        platformFeeWallet = feeWallet_;
        platformFeeBps = feeBps_;
        priceFeed = IAggregatorV3(priceFeed_);
        graduationTargetUsd = graduationTargetUsd_;
        maxOracleStaleness = maxOracleStaleness_;
        platformTaxActive = feeBps_ > 0 && feeWallet_ != address(0);
        rewardsDistributor = rewardsDistributor_;
        rewardBps = rewardBps_;
        creatorRewardsDistributor = creatorRewardsDistributor_;
        creatorRewardBps = creatorRewardBps_;

        emit PlatformTaxConfigured(feeWallet_, feeBps_, graduationTargetUsd_);
    }

    /// @notice Escape hatch for a platform price feed that's gone
    /// permanently stale or was never a real, maintained feed to begin
    /// with — mirrors LaunchedToken.updatePriceFeed exactly. Callable only
    /// by the factory (which gates it behind its own owner — see
    /// CustomTokenFactory.updateTokenPriceFeed), never by the creator.
    /// Repoints only the oracle inputs the platform-tax graduation check
    /// reads; touches nothing about platformFeeBps, platformFeeWallet,
    /// pair, or platformTaxActive directly.
    function updatePriceFeed(address newPriceFeed_, uint256 newMaxOracleStaleness_) external onlyFactory {
        require(platformTaxConfigured, "CustomToken: platform tax not configured");
        require(newPriceFeed_ != address(0), "CustomToken: invalid price feed");
        require(newMaxOracleStaleness_ > 0, "CustomToken: oracle staleness must be > 0");
        priceFeed = IAggregatorV3(newPriceFeed_);
        maxOracleStaleness = newMaxOracleStaleness_;
        emit PriceFeedUpdated(newPriceFeed_, newMaxOracleStaleness_);
    }

    function name() public view override returns (string memory) { return _tokenName; }
    function symbol() public view override returns (string memory) { return _tokenSymbol; }

    /// @notice The one piece of this token's fee configuration that can
    /// change after launch, exactly as requested — everyone can see a
    /// wallet change happen (event below), but nobody, including this
    /// contract's own code, can touch the tax rates themselves again.
    function setMarketingWallet(address newWallet) external onlyCreator {
        require(newWallet != address(0), "CustomToken: invalid wallet");
        marketingWallet = newWallet;
        emit MarketingWalletUpdated(newWallet);
    }

    /// @notice Retune how much pending fee-tokens must build up before a
    /// sell/transfer triggers the next swap-and-process batch. Bounded so
    /// it can't be set so high it never fires (rewards/liquidity/marketing
    /// would just sit uncollected forever) — a purely operational knob,
    /// not a fee rate, so letting the creator tune it doesn't reopen the
    /// "rates are locked forever" guarantee above.
    function setSwapThreshold(uint256 newThreshold) external onlyCreator {
        require(newThreshold > 0 && newThreshold <= totalSupply() / 20, "CustomToken: threshold out of bounds");
        swapThreshold = newThreshold;
        emit SwapThresholdUpdated(newThreshold);
    }

    /// @notice Retune the protective slippage floor applied to every
    /// internal swap-and-process trade — see processingSlippageBps above.
    /// Bounded to the same 5.00%-8.00% band already used elsewhere in this
    /// codebase for the identical purpose.
    function setProcessingSlippageBps(uint256 newBps) external onlyCreator {
        require(newBps >= MIN_PROCESSING_SLIPPAGE_BPS, "CustomToken: slippage below 5% floor");
        require(newBps <= MAX_PROCESSING_SLIPPAGE_BPS, "CustomToken: slippage above 8% ceiling");
        processingSlippageBps = uint16(newBps);
        emit ProcessingSlippageBpsUpdated(newBps);
    }

    /// @notice Step 1 of a two-step creator handoff — see pendingCreator
    /// above and Finding 5 of AUDIT-CustomToken.md. Does nothing to the
    /// live `creator` role until the proposed address calls
    /// acceptCreator() itself.
    function transferCreator(address newCreator) external onlyCreator {
        require(newCreator != address(0), "CustomToken: invalid creator");
        pendingCreator = newCreator;
        emit CreatorTransferStarted(creator, newCreator);
    }

    /// @notice Step 2: only the proposed address can complete the
    /// handoff, proving it controls that address before every
    /// onlyCreator-gated function (setMarketingWallet, setSwapThreshold,
    /// setRewardsBlocked, activateIndependentPair, setProcessingSlippageBps,
    /// rescueToken, rescueEth) starts listening to it instead of the old
    /// creator.
    function acceptCreator() external {
        require(msg.sender == pendingCreator, "CustomToken: caller is not the pending creator");
        address previousCreator = creator;
        creator = pendingCreator;
        pendingCreator = address(0);
        emit CreatorTransferred(previousCreator, creator);
    }

    /// @notice Permanently renounces the creator role — the standard
    /// "renounce ownership" assurance a token's own buyers can go verify
    /// on-chain. Sets `creator` (and any in-flight `pendingCreator`) to
    /// address(0) forever, with no recovery path by design. The instant
    /// this is called, every onlyCreator-gated function on this contract
    /// — setMarketingWallet, setSwapThreshold, setRewardsBlocked,
    /// activateIndependentPair, setProcessingSlippageBps, setTaxExempt,
    /// rescueToken, rescueEth, transferCreator — becomes permanently
    /// uncallable by anyone, including the address that just called this.
    /// Note what this does NOT touch: buyFees, sellFees, and
    /// platformFeeBps were never mutable in the first place (no function
    /// anywhere sets them after initialize()/configurePlatformTax()), so
    /// renouncing doesn't "lock in" the tax rate — it was already locked
    /// in at launch. What renouncing removes is every remaining
    /// *operational* lever, including the tax-exemption whitelist below.
    function renounceCreator() external onlyCreator {
        address previousCreator = creator;
        creator = address(0);
        pendingCreator = address(0);
        emit CreatorRenounced(previousCreator);
    }

    /// @notice Recovers ERC20 tokens sitting on this contract that aren't
    /// owed to anyone — e.g. dust left over from an imperfect-ratio
    /// addLiquidityETH call inside _processLiquidity, or a token sent
    /// here directly by mistake. See Finding 4 of AUDIT-CustomToken.md.
    /// Structurally cannot reach into anything this contract still owes:
    /// when `token` is this token itself, the rescuable amount excludes
    /// every pending fee stream (pendingLiquidityTokens/
    /// pendingMarketingTokens/pendingReflectionTokens); when `token` is
    /// reflectionAsset, it excludes every holder's still-unclaimed
    /// reflection entitlement (totalDividendsDistributed minus
    /// totalDividendsWithdrawn) — for any other token, the full balance
    /// is rescuable since this contract never intentionally holds one.
    function rescueToken(address token, address to, uint256 amount) external onlyCreator {
        require(to != address(0), "CustomToken: invalid recipient");
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 reserved;
        if (token == address(this)) {
            reserved = pendingLiquidityTokens + pendingMarketingTokens + pendingReflectionTokens;
        }
        if (reflectionAsset != address(0) && token == reflectionAsset) {
            reserved += totalDividendsDistributed - totalDividendsWithdrawn;
        }
        uint256 rescuable = balance > reserved ? balance - reserved : 0;
        require(amount <= rescuable, "CustomToken: amount exceeds rescuable balance");

        bool sent = IERC20(token).transfer(to, amount);
        require(sent, "CustomToken: rescue transfer failed");
        emit TokenRescued(token, to, amount);
    }

    /// @notice Recovers stray native ETH sitting on this contract —
    /// direct donations to receive(), or dust left over from an
    /// imperfect-ratio addLiquidityETH call. Never touches ETH owed to
    /// holders: when reflectionAsset == address(0) (native-ETH
    /// reflections), the rescuable amount excludes every holder's
    /// still-unclaimed dividend balance the same way rescueToken does
    /// above.
    function rescueEth(address to, uint256 amount) external onlyCreator {
        require(to != address(0), "CustomToken: invalid recipient");
        uint256 reserved = reflectionAsset == address(0) ? (totalDividendsDistributed - totalDividendsWithdrawn) : 0;
        uint256 balance = address(this).balance;
        uint256 rescuable = balance > reserved ? balance - reserved : 0;
        require(amount <= rescuable, "CustomToken: amount exceeds rescuable balance");

        (bool sent, ) = payable(to).call{value: amount}("");
        require(sent, "CustomToken: rescue transfer failed");
        emit EthRescued(to, amount);
    }

    /// @notice Blocks (or unblocks) `account` from ever showing or
    /// accruing a reflection entitlement — see accumulativeDividendOf()
    /// and isBlockedFromRewards above. Only affects reflections: a blocked
    /// account can still hold, send, and receive the token normally, and
    /// still pays/receives the same transfer tax as anyone else.
    ///
    /// While blocked, every distribution that happens is simply never
    /// payable to this account — not deferred, not redirected to other
    /// holders (same "safe over maximal" tradeoff as the pair exclusion
    /// above; see the README for why). If later unblocked, the account's
    /// entitlement resumes from the same magnified-dividend-per-share
    /// bookkeeping every other holder uses, which was never paused while
    /// they were blocked — so anything distributed during the blocked
    /// window becomes claimable again once unblocked, exactly as if they'd
    /// simply not gotten around to claiming it yet. Treat blocking as
    /// meant to be permanent for an address you actually want to exclude;
    /// toggling it on and off is not a way to selectively skip specific
    /// distributions.
    function setRewardsBlocked(address account, bool blocked) external onlyCreator {
        require(account != address(0), "CustomToken: invalid account");
        isBlockedFromRewards[account] = blocked;
        emit RewardsAccessUpdated(account, blocked);
    }

    /// @notice Whitelists (or un-whitelists) `account` to bypass ALL tax —
    /// both the creator's own buy/sell fee (reflection/marketing/
    /// liquidity/burn) and the platform's graduating tax — on any
    /// transfer where it's either side (see _update's `exempt` check).
    /// Does NOT touch buyFees/sellFees/platformFeeBps themselves, which
    /// stay exactly as fixed at launch — this only ever changes WHO pays
    /// the already-fixed rate, never the rate itself, so it can't be used
    /// to reintroduce the "creator jacks up the tax" rug this contract's
    /// immutable fee rates are built to prevent. Meant for addresses that
    /// legitimately shouldn't be taxed on their own token movements —
    /// e.g. the LiquidityLocker holding the locked LP, a vesting or
    /// airdrop-distribution contract, or a CEX deposit wallet the creator
    /// has arranged a listing with.
    function setTaxExempt(address account, bool exempt) external onlyCreator {
        require(account != address(0), "CustomToken: invalid account");
        isTaxExempt[account] = exempt;
        emit TaxExemptionUpdated(account, exempt);
    }

    // ---------------------------------------------------------------
    // Transfer tax + reflection bookkeeping
    // ---------------------------------------------------------------

    /// @dev Buy = from the pair; sell = to the pair; anything else
    /// (including every leg of our own swap-and-process batch, guarded by
    /// _inSwap) is untaxed, same convention LaunchedToken already uses.
    function _update(address from, address to, uint256 value) internal override {
        if (_inSwap || from == address(0) || value == 0) {
            super._update(from, to, value);
            _afterBalanceChange(from, to, value);
            return;
        }

        bool isBuy = pair != address(0) && from == pair;
        bool isSell = pair != address(0) && to == pair;

        if (!isBuy && !isSell) {
            super._update(from, to, value);
            _afterBalanceChange(from, to, value);
            _maybeSwapAndProcess();
            return;
        }

        // Tax-exemption whitelist (see setTaxExempt above): bypasses BOTH
        // the creator's own fee and the platform's cut for this specific
        // transfer, but every other side effect of a buy/sell still runs
        // exactly as normal — the pending-fee batch can still be
        // triggered by an exempt seller (it's about the token's overall
        // backlog, not this trade), and the graduation check still runs
        // (it's about market cap, not this trade's tax). Only the fee
        // computation itself is skipped.
        if (isTaxExempt[from] || isTaxExempt[to]) {
            super._update(from, to, value);
            _afterBalanceChange(from, to, value);
            if (isSell) _maybeSwapAndProcess();
            if (platformTaxActive) _maybeDisablePlatformTax();
            return;
        }

        FeeSet memory fees = isBuy ? buyFees : sellFees;
        TransferCuts memory cuts;
        cuts.reflection = (value * fees.reflectionBps) / 10_000;
        cuts.marketing = (value * fees.marketingBps) / 10_000;
        cuts.liquidity = (value * fees.liquidityBps) / 10_000;
        cuts.burn = (value * fees.burnBps) / 10_000;
        // Platform cut is independent of the creator's own fee config above
        // (not part of `fees`/MAX_TOTAL_BPS) — same flat rate on both buy
        // and sell, exactly like LaunchedToken's tax.
        cuts.platform = platformTaxActive ? (value * platformFeeBps) / 10_000 : 0;
        cuts.total = cuts.reflection + cuts.marketing + cuts.liquidity + cuts.burn + cuts.platform;

        cuts.toContract = cuts.reflection + cuts.marketing + cuts.liquidity;
        if (cuts.toContract > 0) {
            super._update(from, address(this), cuts.toContract);
            _afterBalanceChange(from, address(this), cuts.toContract);
            pendingReflectionTokens += cuts.reflection;
            pendingMarketingTokens += cuts.marketing;
            pendingLiquidityTokens += cuts.liquidity;
        }
        if (cuts.burn > 0) {
            super._update(from, address(0), cuts.burn); // true burn — totalSupply actually decreases
            _afterBalanceChange(from, address(0), cuts.burn);
            emit TokensBurned(cuts.burn);
        }
        if (cuts.platform > 0) {
            // rewardCut and creatorCut are both carved OUT OF cuts.platform,
            // never added on top of it — the platform's total cut on this
            // transfer stays exactly platformFeeBps. Neither touches
            // cuts.reflection/marketing/liquidity/burn above, which are the
            // creator's own separately-capped fee config and have nothing
            // to do with this feature. rewardBps + creatorRewardBps <=
            // platformFeeBps is enforced once, at configurePlatformTax(),
            // so this can never underflow.
            uint256 rewardCut = (rewardsDistributor != address(0) && rewardBps > 0) ? (value * rewardBps) / 10_000 : 0;
            uint256 creatorCut = (creatorRewardsDistributor != address(0) && creatorRewardBps > 0) ? (value * creatorRewardBps) / 10_000 : 0;
            uint256 toFeeWallet = cuts.platform - rewardCut - creatorCut;
            if (rewardCut > 0) {
                // In-kind, straight to the rewards contract — no swap, same
                // as the rest of the platform tax.
                super._update(from, rewardsDistributor, rewardCut);
                _afterBalanceChange(from, rewardsDistributor, rewardCut);
            }
            if (creatorCut > 0) {
                super._update(from, creatorRewardsDistributor, creatorCut);
                _afterBalanceChange(from, creatorRewardsDistributor, creatorCut);
            }
            if (toFeeWallet > 0) {
                super._update(from, platformFeeWallet, toFeeWallet);
                _afterBalanceChange(from, platformFeeWallet, toFeeWallet);
            }
        }
        super._update(from, to, value - cuts.total);
        _afterBalanceChange(from, to, value - cuts.total);

        // Never trigger a swap mid-buy (avoids selling against the pool's
        // reserves while a buy against those same reserves is still being
        // priced) — only a sell or an ordinary transfer can kick it off.
        if (isSell) _maybeSwapAndProcess();
        // The graduation check, by contrast, runs after either a buy or a
        // sell — same as LaunchedToken, which checks after any transfer
        // that touches the pool.
        if (platformTaxActive) _maybeDisablePlatformTax();
    }

    // ---------------------------------------------------------------
    // Burn: a true burn, callable directly by any holder at any time — on
    // top of (and completely independent from) the tax-triggered burnBps
    // component above. A voluntary burn's `to` is address(0), which is
    // never `pair`, so it takes the plain untaxed path through _update()
    // above (the `!isBuy && !isSell` branch) exactly like an ordinary
    // wallet-to-wallet transfer — no tax is ever skimmed off a holder
    // choosing to destroy their own tokens. "True burn" means totalSupply
    // actually decreases (OpenZeppelin's ERC20._burn, routed through the
    // same _update() override every other transfer uses), same as the
    // existing tax burn already does — not a transfer to a dead address.
    // ---------------------------------------------------------------

    /// @notice Permanently destroys `amount` of the caller's own tokens.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
        emit TokensBurned(amount);
    }

    /// @notice Same as burn(), but spends `account`'s allowance to the
    /// caller first — standard OpenZeppelin ERC20Burnable behavior, so a
    /// third-party contract a holder has approved can burn on their behalf
    /// without ever taking custody of the tokens first.
    function burnFrom(address account, uint256 amount) external {
        _spendAllowance(account, msg.sender, amount);
        _burn(account, amount);
        emit TokensBurned(amount);
    }

    function _afterBalanceChange(address from, address to, uint256 value) private {
        if (value == 0) return;

        if (magnifiedDividendPerShare != 0) {
            int256 magCorrection = _toInt256Safe(magnifiedDividendPerShare * value);
            if (from != address(0)) _magnifiedDividendCorrections[from] += magCorrection;
            if (to != address(0)) _magnifiedDividendCorrections[to] -= magCorrection;
        }

        // Holder-registry maintenance for pushReflections() — independent
        // of the dividend-correction block above (it must keep running
        // even before any distribution has ever happened, i.e. while
        // magnifiedDividendPerShare is still 0) and skipped entirely for a
        // token that never turned reflections on.
        if (reflectionsEnabled) {
            if (from != address(0) && balanceOf(from) == 0) _removeReflectionHolder(from);
            if (to != address(0) && balanceOf(to) > 0) _addReflectionHolder(to);
        }
    }

    function _addReflectionHolder(address account) private {
        if (_reflectionHolderIndex[account] != 0) return;
        _reflectionHolders.push(account);
        _reflectionHolderIndex[account] = _reflectionHolders.length;
    }

    function _removeReflectionHolder(address account) private {
        uint256 idx = _reflectionHolderIndex[account];
        if (idx == 0) return;
        uint256 lastIndex = _reflectionHolders.length;
        if (idx != lastIndex) {
            address lastAccount = _reflectionHolders[lastIndex - 1];
            _reflectionHolders[idx - 1] = lastAccount;
            _reflectionHolderIndex[lastAccount] = idx;
        }
        _reflectionHolders.pop();
        delete _reflectionHolderIndex[account];
    }

    function reflectionHolderCount() external view returns (uint256) {
        return _reflectionHolders.length;
    }

    function reflectionHolderAt(uint256 index) external view returns (address) {
        return _reflectionHolders[index];
    }

    function _toInt256Safe(uint256 a) private pure returns (int256) {
        require(a <= uint256(type(int256).max), "CustomToken: dividend correction overflow");
        return int256(a);
    }

    // ---------------------------------------------------------------
    // Reflections: view + claim
    // ---------------------------------------------------------------

    function accumulativeDividendOf(address account) public view returns (uint256) {
        // The pair (and the token contract itself) never has a real "holder"
        // entitled to reflections — its balance is pool liquidity, not a
        // position — and a creator-blocked address (see
        // isBlockedFromRewards/setRewardsBlocked above) is excluded the
        // same way. Block both here so withdrawableDividendOf() and
        // claimReflections() both automatically inherit the exclusion,
        // without touching the correction bookkeeping that every other
        // (real, unblocked) holder relies on for correct accounting.
        if (account == pair || account == address(this) || isBlockedFromRewards[account]) return 0;
        int256 total = int256(magnifiedDividendPerShare * balanceOf(account)) + _magnifiedDividendCorrections[account];
        if (total < 0) return 0; // defensive only — correct bookkeeping never produces a negative total
        return uint256(total) / MAGNITUDE;
    }

    function withdrawableDividendOf(address account) public view returns (uint256) {
        uint256 total = accumulativeDividendOf(account);
        uint256 withdrawn = withdrawnDividends[account];
        // Guards against underflow for an account that had already claimed
        // before being blocked (accumulativeDividendOf forces `total` to 0
        // the moment they're blocked, which would otherwise be less than
        // their pre-existing withdrawnDividends) — correctly reads as
        // "nothing withdrawable" rather than reverting.
        return total > withdrawn ? total - withdrawn : 0;
    }

    /// @notice Pull your accumulated share of whatever's been distributed so
    /// far (native ETH, or reflectionAsset if one was set) straight to your
    /// wallet right now, rather than waiting for pushReflections() below to
    /// sweep around to you. Both paths read and write the exact same
    /// accounting (withdrawableDividendOf / withdrawnDividends), so there is
    /// no way to be paid twice for one distribution regardless of which
    /// path — or both, at different times — a given holder ends up using.
    /// nonReentrant alongside pushReflections(), sharing the same guard: see
    /// pushReflections' own comment for exactly what that closes off.
    function claimReflections() external nonReentrant returns (uint256 amount) {
        amount = withdrawableDividendOf(msg.sender);
        require(amount > 0, "CustomToken: nothing to claim");
        withdrawnDividends[msg.sender] += amount;
        totalDividendsWithdrawn += amount;

        if (reflectionAsset == address(0)) {
            (bool sent, ) = payable(msg.sender).call{value: amount}("");
            require(sent, "CustomToken: ETH claim transfer failed");
        } else {
            bool sent = IERC20(reflectionAsset).transfer(msg.sender, amount);
            require(sent, "CustomToken: reflection token claim transfer failed");
        }
        emit DividendWithdrawn(msg.sender, amount);
    }

    /// @notice Permissionlessly pushes a batch of holders' currently
    /// withdrawable reflection share directly to their wallets — the
    /// "holders don't have to do anything" counterpart to claimReflections()
    /// above. Anyone can call this (the creator, an off-chain keeper on a
    /// schedule, this platform's own front end, a curious holder) — it
    /// takes no special permission because it can only ever pay people
    /// exactly what they're already owed, to their own recorded address,
    /// never anywhere else.
    ///
    /// Gas-bounded by maxHolders, walking the holder registry starting from
    /// reflectionPushCursor and wrapping back to the start once it reaches
    /// the end, so repeated calls keep covering fresh holders rather than
    /// always restarting at index 0. This function's own gas cost depends
    /// only on maxHolders, never on the total holder count — the same
    /// anti-griefing shape as PlatformRewardsDistributor.processAirdropBatch,
    /// and exactly why this is a standalone call rather than something
    /// triggered automatically inside a transfer: looping over an
    /// unbounded holder list inside `_update` is exactly the failure mode
    /// this design avoids (see the reflections NatSpec at the top of this
    /// file).
    ///
    /// address(this) and `pair` are always skipped, whether or not they
    /// happen to appear in the registry (see its own comment for why they
    /// can end up there) — paying either would either pay the contract's
    /// own temporarily-held, not-yet-swapped fee balance to itself, or
    /// donate real funds to the AMM pool, which is a real, irreversible
    /// loss (recoverable by anyone via a plain skim() call), not a
    /// bookkeeping quirk.
    ///
    /// A single holder's payment failing — a smart-contract wallet that
    /// reverts on receiving ETH, or one that's simply out of gas at that
    /// moment — never blocks the rest of the batch and never costs that
    /// holder their entitlement: this function only marks a holder's
    /// dividend withdrawn AFTER their transfer actually succeeds, so a
    /// failed push leaves their balance exactly as claimable as it was
    /// before, fully available via claimReflections() whenever they like.
    /// Sending is capped at PUSH_GAS_STIPEND gas specifically so one
    /// holder's receive()/fallback can't consume the batch caller's entire
    /// remaining gas — plenty for a plain wallet or a simple forwarding
    /// contract, but bounded rather than open-ended.
    ///
    /// nonReentrant is required, not just defense in depth, given the
    /// send-then-record ordering above: it's what stops a malicious
    /// holder's receive() from calling back into this function or
    /// claimReflections() and being paid twice for the same distribution
    /// before this call gets to record it as withdrawn. Both functions
    /// share one OpenZeppelin ReentrancyGuard status, so the guard blocks
    /// cross-function reentrancy between them, not only self-recursion.

    function pushReflections(uint256 maxHolders) external nonReentrant returns (uint256 holdersPaid, uint256 totalPaid) {
        require(maxHolders > 0, "CustomToken: maxHolders must be > 0");
        uint256 total = _reflectionHolders.length;
        if (total == 0) return (0, 0);

        uint256 cursor = reflectionPushCursor;
        if (cursor >= total) cursor = 0;

        uint256 steps = maxHolders < total ? maxHolders : total;
        for (uint256 visited = 0; visited < steps; visited++) {
            address holder = _reflectionHolders[cursor];
            cursor = cursor + 1 == total ? 0 : cursor + 1;

            if (holder == address(this) || holder == pair || isBlockedFromRewards[holder]) continue;
            uint256 amount = withdrawableDividendOf(holder);
            if (amount == 0) continue;

            bool sent;
            if (reflectionAsset == address(0)) {
                (sent, ) = payable(holder).call{value: amount, gas: PUSH_GAS_STIPEND}("");
            } else {
                // A standard ERC20 transfer() never invokes recipient code
                // the way a native ETH send can, so this branch doesn't
                // carry the same griefing/reentrancy exposure — but it's
                // still wrapped defensively in case reflectionAsset turns
                // out to be a nonstandard token whose transfer() reverts
                // instead of returning false.
                try IERC20(reflectionAsset).transfer(holder, amount) returns (bool ok) {
                    sent = ok;
                } catch {
                    sent = false;
                }
            }

            if (sent) {
                withdrawnDividends[holder] += amount;
                totalDividendsWithdrawn += amount;
                holdersPaid++;
                totalPaid += amount;
                emit DividendWithdrawn(holder, amount);
            }
            // A failed send leaves this holder's entitlement completely
            // untouched — not marked withdrawn, not lost — so
            // claimReflections() will report exactly the same amount as
            // still due if they come claim it themselves.
        }

        reflectionPushCursor = cursor;
        emit ReflectionsPushed(holdersPaid, totalPaid, cursor);
    }

    function _distributeDividends(uint256 amount) private {
        if (amount == 0 || totalSupply() == 0) return;
        magnifiedDividendPerShare += (amount * MAGNITUDE) / totalSupply();
        totalDividendsDistributed += amount;
        emit DividendsDistributed(amount);
    }

    // ---------------------------------------------------------------
    // Platform tax: graduation check (identical approach to LaunchedToken)
    // ---------------------------------------------------------------

    /// @notice Current market cap in the price feed's own decimals (e.g. 8
    /// for a typical Chainlink USD feed), or (0, false) if there's no pool
    /// yet, the feed can't be read, or its data is stale beyond
    /// maxOracleStaleness. A stale/broken feed never blocks trading — it
    /// only means the tax-disable check can't run until the feed recovers.
    ///
    /// The pool-reads-and-arithmetic half of this (everything past the
    /// oracle call) is delegated to _computeMarketCapFromPair() through an
    /// external self-call specifically so it can sit behind its own
    /// try/catch — see LaunchedToken.currentMarketCapInFeedDecimals for why
    /// this matters: without it, a revert from a misbehaving pair or from
    /// arithmetic overflow would propagate out and revert the entire
    /// transfer instead of just leaving this check unable to run.
    function currentMarketCapInFeedDecimals() public view returns (uint256 marketCap, bool feedIsFresh) {
        if (pair == address(0)) return (0, false);
        try priceFeed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0) return (0, false);
            if (block.timestamp - updatedAt > maxOracleStaleness) return (0, false);

            try this._computeMarketCapFromPair(uint256(answer)) returns (uint256 mc, bool ok) {
                if (!ok) return (0, false);
                return (mc, true);
            } catch {
                return (0, false);
            }
        } catch {
            return (0, false);
        }
    }

    /// @dev External purely so currentMarketCapInFeedDecimals() can wrap it
    /// in try/catch — see LaunchedToken._computeMarketCapFromPair, which
    /// this mirrors exactly. Not meant to be called by anything but this
    /// contract itself.
    function _computeMarketCapFromPair(uint256 ethUsd) external view returns (uint256 marketCap, bool ok) {
        require(msg.sender == address(this), "CustomToken: internal only");
        (uint112 reserve0, uint112 reserve1, ) = IUniswapV2PairMinimal(pair).getReserves();
        address token0 = IUniswapV2PairMinimal(pair).token0();
        uint256 tokenReserve = token0 == address(this) ? uint256(reserve0) : uint256(reserve1);
        uint256 ethReserve = token0 == address(this) ? uint256(reserve1) : uint256(reserve0);
        if (tokenReserve == 0) return (0, false);

        uint256 pricePerTokenWei = (ethReserve * 1e18) / tokenReserve;
        uint256 usdPerToken = (pricePerTokenWei * ethUsd) / 1e18;
        marketCap = (usdPerToken * totalSupply()) / 1e18;
        ok = true;
    }

    /// @notice Mirrors LaunchedToken._maybeDisableTax exactly — see that
    /// contract's comment for the full reasoning on why graduation now
    /// requires two separate observations at least
    /// GRADUATION_CONFIRMATION_WINDOW apart, rather than disabling the tax
    /// off one instantaneous spot-price read.
    function _maybeDisablePlatformTax() internal {
        if (!platformTaxActive) return;
        (uint256 marketCap, bool feedIsFresh) = currentMarketCapInFeedDecimals();
        if (!feedIsFresh) return; // oracle hiccup: leave any in-progress candidacy exactly as it was

        uint256 targetInFeedDecimals = graduationTargetUsd * (10 ** priceFeed.decimals());
        if (marketCap < targetInFeedDecimals) {
            if (graduationCandidateAt != 0) {
                graduationCandidateAt = 0;
                emit GraduationCandidateReset();
            }
            return;
        }

        if (graduationCandidateAt == 0) {
            graduationCandidateAt = block.timestamp;
            emit GraduationCandidateObserved(marketCap, block.timestamp + GRADUATION_CONFIRMATION_WINDOW);
            return;
        }

        if (block.timestamp < graduationCandidateAt + GRADUATION_CONFIRMATION_WINDOW) {
            return; // still within the confirmation window; needs a later transfer to confirm
        }

        platformTaxActive = false;
        emit PlatformTaxDisabled(marketCap);
    }

    // ---------------------------------------------------------------
    // Swap-and-process: turns collected in-kind fees into their real
    // outcomes (auto-liquidity, marketing ETH, reflection payouts)
    // ---------------------------------------------------------------

    function _maybeSwapAndProcess() private {
        if (_inSwap || pair == address(0)) return;
        uint256 pending = pendingLiquidityTokens + pendingMarketingTokens + pendingReflectionTokens;
        if (pending < swapThreshold) return;
        _swapAndProcess();
    }

    /// @dev Each of the three _process* steps below is called through an
    /// external self-call wrapped in its own try/catch — the same pattern
    /// _computeMarketCapFromPair already uses for the graduation math (try/
    /// catch only wraps external calls, never arbitrary internal logic).
    /// Before this fix, a revert in any one step — a marketingWallet that
    /// rejects ETH, a reflectionAsset pool that's been drained, an
    /// addLiquidityETH call that reverts for an ordinary router-level
    /// reason — propagated straight out of _swapAndProcess and reverted
    /// the entire outer transfer that happened to trigger this batch.
    /// Since this runs on every sell/plain-transfer once pending fees
    /// cross swapThreshold, that meant one broken step could permanently
    /// brick all trading and transfers for the token, with no admin
    /// override anywhere in the contract. See Finding 1 of
    /// AUDIT-CustomToken.md. A failed step's tokens are added straight
    /// back to the relevant pending counter — nothing is silently
    /// forfeited, it just waits for whatever was broken to get fixed
    /// (e.g. via setMarketingWallet()) and gets retried on a later batch.
    function _swapAndProcess() private lockTheSwap {
        uint256 liquidityTokens = pendingLiquidityTokens;
        uint256 marketingTokens = pendingMarketingTokens;
        uint256 reflectionTokens = pendingReflectionTokens;
        pendingLiquidityTokens = 0;
        pendingMarketingTokens = 0;
        pendingReflectionTokens = 0;

        if (liquidityTokens > 0) {
            try this._processLiquidity(liquidityTokens) {
                // succeeded — nothing left to do
            } catch {
                pendingLiquidityTokens += liquidityTokens;
            }
        }
        if (marketingTokens > 0 && marketingWallet != address(0)) {
            try this._processMarketing(marketingTokens) {
            } catch {
                pendingMarketingTokens += marketingTokens;
            }
        }
        if (reflectionTokens > 0) {
            try this._processReflections(reflectionTokens) {
            } catch {
                pendingReflectionTokens += reflectionTokens;
            }
        }
    }

    /// @dev Half swapped for ETH, the other half paired with that ETH as
    /// fresh liquidity — the resulting LP tokens go straight to a burn
    /// address, so this stream of liquidity can never be withdrawn by
    /// anyone, ever, including the creator. External purely so
    /// _swapAndProcess can wrap it in try/catch — see that function's own
    /// comment; not meant to be called by anything but this contract
    /// itself.
    function _processLiquidity(uint256 amount) external {
        require(msg.sender == address(this), "CustomToken: internal only");
        uint256 half = amount / 2;
        uint256 otherHalf = amount - half;
        if (half == 0 || otherHalf == 0) return;

        uint256 ethBefore = address(this).balance;
        _swapTokensForEth(half);
        uint256 ethForLiquidity = address(this).balance - ethBefore;
        if (ethForLiquidity == 0) return;

        _approve(address(this), router, otherHalf);
        (, , uint256 lpAmount) = IUniswapV2Router02(router).addLiquidityETH{value: ethForLiquidity}(
            address(this),
            otherHalf,
            _applySlippage(otherHalf),
            _applySlippage(ethForLiquidity),
            BURN_ADDRESS,
            block.timestamp + 15 minutes
        );
        emit LiquidityAutoAdded(otherHalf, ethForLiquidity, lpAmount);
    }

    /// @dev External purely so _swapAndProcess can wrap it in try/catch —
    /// see that function's own comment; not meant to be called by
    /// anything but this contract itself.
    function _processMarketing(uint256 amount) external {
        require(msg.sender == address(this), "CustomToken: internal only");
        uint256 ethBefore = address(this).balance;
        _swapTokensForEth(amount);
        uint256 ethOut = address(this).balance - ethBefore;
        if (ethOut == 0) return;
        (bool sent, ) = payable(marketingWallet).call{value: ethOut}("");
        require(sent, "CustomToken: marketing transfer failed");
        emit MarketingFeeSent(ethOut);
    }

    /// @dev External purely so _swapAndProcess can wrap it in try/catch —
    /// see that function's own comment; not meant to be called by
    /// anything but this contract itself.
    function _processReflections(uint256 amount) external {
        require(msg.sender == address(this), "CustomToken: internal only");
        if (reflectionAsset == address(0)) {
            uint256 ethBefore = address(this).balance;
            _swapTokensForEth(amount);
            uint256 ethOut = address(this).balance - ethBefore;
            _distributeDividends(ethOut);
        } else {
            uint256 balBefore = IERC20(reflectionAsset).balanceOf(address(this));
            _swapTokensForToken(amount, reflectionAsset);
            uint256 received = IERC20(reflectionAsset).balanceOf(address(this)) - balBefore;
            _distributeDividends(received);
        }
    }

    /// @dev Standard Uniswap V2 constant-product quote (0.30% swap fee
    /// baked into the 997/1000 constants) — used only to derive a
    /// protective slippage floor below, never to execute anything, same
    /// convention as TokenFactory/CustomTokenFactory's identical helper.
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        return numerator / denominator;
    }

    /// @dev Quotes amountIn's expected output in tokenOut off the
    /// relevant pool's own live reserves — the token/WETH leg always
    /// reads `pair` directly (already known, no lookup needed); any other
    /// leg (e.g. WETH/reflectionAsset) is looked up off the DEX factory.
    /// Returns 0 if no pool exists yet or either reserve is empty, which
    /// callers treat as "can't protect this trade" rather than blocking
    /// it — a missing quote must never be able to revert or brick a
    /// transfer (see Finding 1's reasoning, which this is deliberately
    /// consistent with).
    function _quoteOut(uint256 amountIn, address tokenIn, address tokenOut) private view returns (uint256) {
        address pairAddr;
        if (tokenIn == address(this) || tokenOut == address(this)) {
            pairAddr = pair;
        } else {
            address dexFactory = IUniswapV2Router02(router).factory();
            pairAddr = IUniswapV2FactoryMinimal(dexFactory).getPair(tokenIn, tokenOut);
        }
        if (pairAddr == address(0)) return 0;

        (uint112 reserve0, uint112 reserve1, ) = IUniswapV2PairMinimal(pairAddr).getReserves();
        address token0 = IUniswapV2PairMinimal(pairAddr).token0();
        uint256 reserveIn = token0 == tokenIn ? uint256(reserve0) : uint256(reserve1);
        uint256 reserveOut = token0 == tokenIn ? uint256(reserve1) : uint256(reserve0);
        if (reserveIn == 0 || reserveOut == 0) return 0;

        return _getAmountOut(amountIn, reserveIn, reserveOut);
    }

    /// @dev floor = amount minus processingSlippageBps of it.
    function _applySlippage(uint256 amount) private view returns (uint256) {
        return amount - (amount * processingSlippageBps) / 10_000;
    }

    function _swapTokensForEth(uint256 amount) private {
        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = IUniswapV2Router02(router).WETH();
        uint256 quoted = _quoteOut(amount, path[0], path[1]);
        uint256 minOut = quoted > 0 ? _applySlippage(quoted) : 0;
        _approve(address(this), router, amount);
        IUniswapV2Router02(router).swapExactTokensForETHSupportingFeeOnTransferTokens(
            amount, minOut, path, address(this), block.timestamp + 15 minutes
        );
    }

    function _swapTokensForToken(uint256 amount, address outputToken) private {
        address weth = IUniswapV2Router02(router).WETH();
        address[] memory path = new address[](3);
        path[0] = address(this);
        path[1] = weth;
        path[2] = outputToken;

        // Two-hop quote: estimate the WETH leg first, then use that
        // estimate as the input to quote the second leg — an
        // approximation (the real swap's first leg may land slightly
        // differently), but one that only ever sets a protective floor,
        // never the trade itself, same as every other quote helper in
        // this codebase.
        uint256 wethQuoted = _quoteOut(amount, path[0], path[1]);
        uint256 minOut = 0;
        if (wethQuoted > 0) {
            uint256 finalQuoted = _quoteOut(wethQuoted, path[1], path[2]);
            if (finalQuoted > 0) minOut = _applySlippage(finalQuoted);
        }

        _approve(address(this), router, amount);
        IUniswapV2Router02(router).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amount, minOut, path, address(this), block.timestamp + 15 minutes
        );
    }
}
