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
/// life of the token from that point on. The only thing that can ever
/// change after launch is the marketing wallet address itself, exactly as
/// requested — every fee rate is locked in at creation, closing off the
/// classic "creator jacks up the sell tax after launch" move.
contract CustomToken is ERC20, ReentrancyGuard {
    bool private _initialized;

    address public creator;
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
    uint256 public rewardBps; // absolute bps of transfer value diverted to rewardsDistributor, carved OUT OF platformFeeBps (never on top of it); always <= platformFeeBps

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
    event DividendsDistributed(uint256 amount);
    event DividendWithdrawn(address indexed to, uint256 amount);
    event ReflectionsPushed(uint256 holdersPaid, uint256 totalPaid, uint256 nextCursor);
    event LiquidityAutoAdded(uint256 tokenAmount, uint256 ethAmount, uint256 lpAmount);
    event MarketingFeeSent(uint256 ethAmount);
    event TokensBurned(uint256 amount);
    event PlatformTaxConfigured(address indexed feeWallet, uint256 feeBps, uint256 graduationTargetUsd);
    event PlatformTaxDisabled(uint256 marketCapInFeedDecimals);

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
        require(creator_ != address(0), "CustomToken: invalid creator");
        require(mintTo_ != address(0), "CustomToken: invalid mint recipient");
        require(factory_ != address(0), "CustomToken: invalid factory");
        require(router_ != address(0), "CustomToken: invalid router");

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
        uint256 rewardBps_
    ) external onlyFactory {
        require(!platformTaxConfigured, "CustomToken: platform tax already configured");
        require(pair != address(0), "CustomToken: pair not set yet");
        require(rewardBps_ <= feeBps_, "CustomToken: rewardBps exceeds feeBps");
        require(rewardsDistributor_ != address(0) || rewardBps_ == 0, "CustomToken: rewardBps requires a distributor");

        platformTaxConfigured = true;
        platformFeeWallet = feeWallet_;
        platformFeeBps = feeBps_;
        priceFeed = IAggregatorV3(priceFeed_);
        graduationTargetUsd = graduationTargetUsd_;
        maxOracleStaleness = maxOracleStaleness_;
        platformTaxActive = feeBps_ > 0 && feeWallet_ != address(0);
        rewardsDistributor = rewardsDistributor_;
        rewardBps = rewardBps_;

        emit PlatformTaxConfigured(feeWallet_, feeBps_, graduationTargetUsd_);
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

        FeeSet memory fees = isBuy ? buyFees : sellFees;
        uint256 reflectionCut = (value * fees.reflectionBps) / 10_000;
        uint256 marketingCut = (value * fees.marketingBps) / 10_000;
        uint256 liquidityCut = (value * fees.liquidityBps) / 10_000;
        uint256 burnCut = (value * fees.burnBps) / 10_000;
        // Platform cut is independent of the creator's own fee config above
        // (not part of `fees`/MAX_TOTAL_BPS) — same flat rate on both buy
        // and sell, exactly like LaunchedToken's tax.
        uint256 platformCut = platformTaxActive ? (value * platformFeeBps) / 10_000 : 0;
        uint256 totalCut = reflectionCut + marketingCut + liquidityCut + burnCut + platformCut;

        uint256 toContract = reflectionCut + marketingCut + liquidityCut;
        if (toContract > 0) {
            super._update(from, address(this), toContract);
            _afterBalanceChange(from, address(this), toContract);
            pendingReflectionTokens += reflectionCut;
            pendingMarketingTokens += marketingCut;
            pendingLiquidityTokens += liquidityCut;
        }
        if (burnCut > 0) {
            super._update(from, address(0), burnCut); // true burn — totalSupply actually decreases
            _afterBalanceChange(from, address(0), burnCut);
            emit TokensBurned(burnCut);
        }
        if (platformCut > 0) {
            // rewardCut is carved OUT OF platformCut, never added on top of
            // it — the platform's total cut on this transfer stays exactly
            // platformFeeBps. This never touches reflectionCut/
            // marketingCut/liquidityCut/burnCut above, which are the
            // creator's own separately-capped fee config and have nothing
            // to do with this feature. rewardBps <= platformFeeBps is
            // enforced once, at configurePlatformTax(), so this can never
            // underflow.
            uint256 rewardCut = (rewardsDistributor != address(0) && rewardBps > 0) ? (value * rewardBps) / 10_000 : 0;
            uint256 toFeeWallet = platformCut - rewardCut;
            if (rewardCut > 0) {
                // In-kind, straight to the rewards contract — no swap, same
                // as the rest of the platform tax.
                super._update(from, rewardsDistributor, rewardCut);
                _afterBalanceChange(from, rewardsDistributor, rewardCut);
            }
            if (toFeeWallet > 0) {
                super._update(from, platformFeeWallet, toFeeWallet);
                _afterBalanceChange(from, platformFeeWallet, toFeeWallet);
            }
        }
        super._update(from, to, value - totalCut);
        _afterBalanceChange(from, to, value - totalCut);

        // Never trigger a swap mid-buy (avoids selling against the pool's
        // reserves while a buy against those same reserves is still being
        // priced) — only a sell or an ordinary transfer can kick it off.
        if (isSell) _maybeSwapAndProcess();
        // The graduation check, by contrast, runs after either a buy or a
        // sell — same as LaunchedToken, which checks after any transfer
        // that touches the pool.
        if (platformTaxActive) _maybeDisablePlatformTax();
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
        // position. Block it here so withdrawableDividendOf() and
        // claimReflections() both automatically inherit the exclusion,
        // without touching the correction bookkeeping that every other
        // (real) holder relies on for correct accounting.
        if (account == pair || account == address(this)) return 0;
        int256 total = int256(magnifiedDividendPerShare * balanceOf(account)) + _magnifiedDividendCorrections[account];
        if (total < 0) return 0; // defensive only — correct bookkeeping never produces a negative total
        return uint256(total) / MAGNITUDE;
    }

    function withdrawableDividendOf(address account) public view returns (uint256) {
        return accumulativeDividendOf(account) - withdrawnDividends[account];
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

            if (holder == address(this) || holder == pair) continue;
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
    function currentMarketCapInFeedDecimals() public view returns (uint256 marketCap, bool feedIsFresh) {
        if (pair == address(0)) return (0, false);
        try priceFeed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0) return (0, false);
            if (block.timestamp - updatedAt > maxOracleStaleness) return (0, false);

            (uint112 reserve0, uint112 reserve1, ) = IUniswapV2PairMinimal(pair).getReserves();
            address token0 = IUniswapV2PairMinimal(pair).token0();
            uint256 tokenReserve = token0 == address(this) ? uint256(reserve0) : uint256(reserve1);
            uint256 ethReserve = token0 == address(this) ? uint256(reserve1) : uint256(reserve0);
            if (tokenReserve == 0) return (0, false);

            uint256 pricePerTokenWei = (ethReserve * 1e18) / tokenReserve;
            uint256 ethUsd = uint256(answer);
            uint256 usdPerToken = (pricePerTokenWei * ethUsd) / 1e18;
            marketCap = (usdPerToken * totalSupply()) / 1e18;
            feedIsFresh = true;
        } catch {
            return (0, false);
        }
    }

    function _maybeDisablePlatformTax() internal {
        if (!platformTaxActive) return;
        (uint256 marketCap, bool feedIsFresh) = currentMarketCapInFeedDecimals();
        if (!feedIsFresh) return;

        uint256 targetInFeedDecimals = graduationTargetUsd * (10 ** priceFeed.decimals());
        if (marketCap >= targetInFeedDecimals) {
            platformTaxActive = false;
            emit PlatformTaxDisabled(marketCap);
        }
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

    function _swapAndProcess() private lockTheSwap {
        uint256 liquidityTokens = pendingLiquidityTokens;
        uint256 marketingTokens = pendingMarketingTokens;
        uint256 reflectionTokens = pendingReflectionTokens;
        pendingLiquidityTokens = 0;
        pendingMarketingTokens = 0;
        pendingReflectionTokens = 0;

        if (liquidityTokens > 0) _processLiquidity(liquidityTokens);
        if (marketingTokens > 0 && marketingWallet != address(0)) _processMarketing(marketingTokens);
        if (reflectionTokens > 0) _processReflections(reflectionTokens);
    }

    /// @dev Half swapped for ETH, the other half paired with that ETH as
    /// fresh liquidity — the resulting LP tokens go straight to a burn
    /// address, so this stream of liquidity can never be withdrawn by
    /// anyone, ever, including the creator.
    function _processLiquidity(uint256 amount) private {
        uint256 half = amount / 2;
        uint256 otherHalf = amount - half;
        if (half == 0 || otherHalf == 0) return;

        uint256 ethBefore = address(this).balance;
        _swapTokensForEth(half);
        uint256 ethForLiquidity = address(this).balance - ethBefore;
        if (ethForLiquidity == 0) return;

        _approve(address(this), router, otherHalf);
        (, , uint256 lpAmount) = IUniswapV2Router02(router).addLiquidityETH{value: ethForLiquidity}(
            address(this), otherHalf, 0, 0, BURN_ADDRESS, block.timestamp + 15 minutes
        );
        emit LiquidityAutoAdded(otherHalf, ethForLiquidity, lpAmount);
    }

    function _processMarketing(uint256 amount) private {
        uint256 ethBefore = address(this).balance;
        _swapTokensForEth(amount);
        uint256 ethOut = address(this).balance - ethBefore;
        if (ethOut == 0) return;
        (bool sent, ) = payable(marketingWallet).call{value: ethOut}("");
        require(sent, "CustomToken: marketing transfer failed");
        emit MarketingFeeSent(ethOut);
    }

    function _processReflections(uint256 amount) private {
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

    function _swapTokensForEth(uint256 amount) private {
        address[] memory path = new address[](2);
        path[0] = address(this);
        path[1] = IUniswapV2Router02(router).WETH();
        _approve(address(this), router, amount);
        IUniswapV2Router02(router).swapExactTokensForETHSupportingFeeOnTransferTokens(
            amount, 0, path, address(this), block.timestamp + 15 minutes
        );
    }

    function _swapTokensForToken(uint256 amount, address outputToken) private {
        address[] memory path = new address[](3);
        path[0] = address(this);
        path[1] = IUniswapV2Router02(router).WETH();
        path[2] = outputToken;
        _approve(address(this), router, amount);
        IUniswapV2Router02(router).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amount, 0, path, address(this), block.timestamp + 15 minutes
        );
    }
}
