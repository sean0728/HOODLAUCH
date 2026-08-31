// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "./interfaces/IAggregatorV3.sol";
import "./interfaces/IUniswapV2Pair.sol";

/// @title LaunchedToken
/// @notice The ERC20 every launch deploys as an EIP-1167 clone of this
/// implementation. What happens next depends entirely on which mode
/// TokenFactory launched it under:
///
///  - "Just Launch": the full supply mints straight to the creator's own
///    wallet. configureTax() is never called for this token, so it behaves
///    as a completely ordinary, untaxed ERC20 for its entire life —
///    creating a pool and adding liquidity anywhere, any time, by whatever
///    means, is entirely the creator's own responsibility from here.
///
///  - "Launch + Add Liquidity": the full supply mints to TokenFactory,
///    which immediately pairs it into a real DEX pool and then calls
///    configureTax() exactly once, pointing this token at that pool. From
///    that moment on, every transfer that touches the pool (a buy or a
///    sell) has feeBps skimmed to feeWallet — this is the only way to
///    collect a fee against a real Uniswap V2-style pool, since those
///    pools have no transaction hooks of their own. After every taxed
///    transfer this token checks the pool's live market cap (via a
///    Chainlink-style price feed) and permanently disables the tax,
///    forever, the moment that market cap crosses graduationTargetUsd.
contract LaunchedToken is ERC20 {
    bool private _initialized;

    address public creator;
    address public factory;
    uint256 public launchedAt;
    string private _tokenName;
    string private _tokenSymbol;

    // ---- tax state, set once via configureTax(). Everything below stays
    // zero/false/unset for a "Just Launch" token, which never calls
    // configureTax() at all. ----
    bool public taxConfigured;
    address public pair;
    address public feeWallet;
    uint256 public feeBps; // 25 = 0.25%
    bool public taxActive;
    IAggregatorV3 public priceFeed;
    uint256 public graduationTargetUsd; // whole dollars, e.g. 80000
    uint256 public maxOracleStaleness; // seconds; the tax-disable check is skipped (never reverted) if the feed is older than this

    // ---- reward diversion: carves a slice of the platform's own feeBps
    // cut off to PlatformRewardsDistributor instead of feeWallet, on every
    // taxed transfer. Snapshotted once, in configureTax(), same "applies
    // going forward only" convention as every other tax default here.
    // rewardsDistributor == address(0) (the default) means this is
    // entirely inactive and every taxed transfer behaves exactly as it did
    // before this feature existed — 100% of feeBps still goes to
    // feeWallet. ----
    address public rewardsDistributor;
    uint256 public rewardBps; // absolute bps of transfer value diverted to rewardsDistributor, carved OUT OF feeBps (never on top of it); always <= feeBps

    /// @notice Hard ceiling on totalSupply_, enforced once at initialize().
    /// Purely defense-in-depth: currentMarketCapInFeedDecimals()'s own
    /// arithmetic (usdPerToken * totalSupply()) would need a totalSupply in
    /// the neighborhood of 1e44 tokens to have any realistic path to
    /// overflowing a uint256 at ordinary prices — utterly outside anything
    /// a real launch would ever use — but capping it here at 1 quadrillion
    /// tokens (comfortably above real-world outliers like PEPE's ~420
    /// trillion or SHIB's ~589 trillion supply) removes that edge case
    /// entirely rather than relying on it staying implausible. See
    /// _computeMarketCapFromPair for the other half of this hardening (a
    /// revert in the graduation math is caught, not left to brick trading).
    uint256 public constant MAX_TOTAL_SUPPLY = 1_000_000_000_000_000 * 1e18; // 1 quadrillion tokens, 18 decimals

    /// @notice Once a taxed transfer first observes the pool's market cap at
    /// or above graduationTargetUsd, this records when — rather than
    /// disabling the tax immediately off that one instantaneous reading.
    /// 0 means "not currently a graduation candidate". See
    /// _maybeDisableTax() for why: a single spot-price read is cheap to
    /// manipulate temporarily (a large trade against a pool whose totalSupply
    /// dwarfs its real liquidity can imply a market cap far beyond the
    /// pool's actual ETH value for exactly one instant), so graduation now
    /// requires the target to still be met on a later transfer, at least
    /// GRADUATION_CONFIRMATION_WINDOW after the first qualifying
    /// observation — and any transfer that observes the target no longer
    /// met in between resets this back to 0, so unwinding a manipulated
    /// position (itself a transfer against the pool) undoes the candidate
    /// window instead of letting it quietly finish counting down.
    uint256 public graduationCandidateAt;

    /// @notice Minimum time a pool's market cap must stay at or above
    /// graduationTargetUsd, confirmed across at least two separate
    /// pair-touching transfers, before the tax actually disables. Fixed
    /// rather than owner-configurable — this is a security property of
    /// every launch, not a tunable default.
    uint256 public constant GRADUATION_CONFIRMATION_WINDOW = 30 minutes;

    event TokenInitialized(string name, string symbol, uint256 totalSupply, address indexed creator);
    event TaxConfigured(address indexed pair, address indexed feeWallet, uint256 feeBps, uint256 graduationTargetUsd);
    event TaxDisabled(uint256 marketCapInFeedDecimals);
    event GraduationCandidateObserved(uint256 marketCapInFeedDecimals, uint256 confirmEligibleAt);
    event GraduationCandidateReset();
    event PriceFeedUpdated(address indexed newPriceFeed, uint256 newMaxOracleStaleness);

    modifier onlyFactory() {
        require(msg.sender == factory, "LaunchedToken: caller is not the factory");
        _;
    }

    // Runs exactly once, on the implementation contract TokenFactory clones
    // from. Never runs again on any clone.
    constructor() ERC20("", "") {
        _initialized = true;
    }

    function initialize(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address creator_,
        address mintTo_,
        address factory_
    ) external {
        require(!_initialized, "LaunchedToken: already initialized");
        require(totalSupply_ > 0, "LaunchedToken: supply must be > 0");
        require(totalSupply_ <= MAX_TOTAL_SUPPLY, "LaunchedToken: supply too large");
        require(creator_ != address(0), "LaunchedToken: invalid creator");
        require(mintTo_ != address(0), "LaunchedToken: invalid mint recipient");
        require(factory_ != address(0), "LaunchedToken: invalid factory");

        _initialized = true;
        _tokenName = name_;
        _tokenSymbol = symbol_;
        creator = creator_;
        factory = factory_;
        launchedAt = block.timestamp;

        _mint(mintTo_, totalSupply_);

        emit TokenInitialized(name_, symbol_, totalSupply_, creator_);
    }

    /// @notice One-time wiring step, called by TokenFactory immediately
    /// after it seeds this token's DEX pool (see
    /// TokenFactory._launchWithLiquidity) — never called at all for a
    /// "Just Launch" token. Passing feeBps_ == 0 or a zero feeWallet_
    /// records the pair but leaves the tax permanently inactive.
    function configureTax(
        address pair_,
        address feeWallet_,
        uint256 feeBps_,
        address priceFeed_,
        uint256 graduationTargetUsd_,
        uint256 maxOracleStaleness_,
        address rewardsDistributor_,
        uint256 rewardBps_
    ) external onlyFactory {
        require(!taxConfigured, "LaunchedToken: tax already configured");
        require(pair_ != address(0), "LaunchedToken: invalid pair");
        require(rewardBps_ <= feeBps_, "LaunchedToken: rewardBps exceeds feeBps");
        require(rewardsDistributor_ != address(0) || rewardBps_ == 0, "LaunchedToken: rewardBps requires a distributor");

        taxConfigured = true;
        pair = pair_;
        feeWallet = feeWallet_;
        feeBps = feeBps_;
        priceFeed = IAggregatorV3(priceFeed_);
        graduationTargetUsd = graduationTargetUsd_;
        maxOracleStaleness = maxOracleStaleness_;
        taxActive = feeBps_ > 0 && feeWallet_ != address(0);
        rewardsDistributor = rewardsDistributor_;
        rewardBps = rewardBps_;

        emit TaxConfigured(pair_, feeWallet_, feeBps_, graduationTargetUsd_);
    }

    /// @notice Escape hatch for a price feed that's gone permanently stale
    /// or was never a real, maintained feed to begin with (a real risk on a
    /// young chain — see the comment on IAggregatorV3). Callable only by
    /// the factory, which gates it behind its own owner (see
    /// TokenFactory.updateTokenPriceFeed) — never by the creator or anyone
    /// else. Deliberately narrow: it repoints the oracle inputs the
    /// graduation check reads, and nothing else. It cannot touch feeBps,
    /// feeWallet, pair, or taxActive directly, and disabling the tax still
    /// requires the same currentMarketCapInFeedDecimals()/confirmation-
    /// window path as ever — this only unblocks that path when it would
    /// otherwise be stuck forever behind a dead oracle, it doesn't grant a
    /// shortcut around it.
    function updatePriceFeed(address newPriceFeed_, uint256 newMaxOracleStaleness_) external onlyFactory {
        require(taxConfigured, "LaunchedToken: tax not configured");
        require(newPriceFeed_ != address(0), "LaunchedToken: invalid price feed");
        require(newMaxOracleStaleness_ > 0, "LaunchedToken: oracle staleness must be > 0");
        priceFeed = IAggregatorV3(newPriceFeed_);
        maxOracleStaleness = newMaxOracleStaleness_;
        emit PriceFeedUpdated(newPriceFeed_, newMaxOracleStaleness_);
    }

    function name() public view override returns (string memory) { return _tokenName; }
    function symbol() public view override returns (string memory) { return _tokenSymbol; }

    /// @dev The tax itself. Skims feeBps to feeWallet on any transfer that
    /// touches the pool directly (a buy sends pair -> someone; a sell sends
    /// someone -> pair). Every other transfer — the factory's own seeding
    /// transfer into the pair inside addLiquidityETH (taxActive is still
    /// false at that point, since configureTax runs right after), the
    /// initial mint, and any ordinary wallet-to-wallet transfer (neither
    /// side is ever the pool) — passes through untaxed automatically,
    /// since none of those match `from == pair || to == pair` while taxed.
    function _update(address from, address to, uint256 value) internal override {
        if (taxActive && value > 0 && (from == pair || to == pair)) {
            uint256 fee = (value * feeBps) / 10_000;
            if (fee > 0) {
                // rewardCut is carved OUT OF fee, never added on top of it —
                // the platform's total take on this transfer stays exactly
                // feeBps, same as before this feature existed. rewardBps <=
                // feeBps is enforced once, at configureTax(), so this can
                // never underflow.
                uint256 rewardCut = (rewardsDistributor != address(0) && rewardBps > 0) ? (value * rewardBps) / 10_000 : 0;
                uint256 toFeeWallet = fee - rewardCut;
                if (rewardCut > 0) super._update(from, rewardsDistributor, rewardCut);
                if (toFeeWallet > 0) super._update(from, feeWallet, toFeeWallet);
                super._update(from, to, value - fee);
            } else {
                super._update(from, to, value);
            }
            _maybeDisableTax();
        } else {
            super._update(from, to, value);
        }
    }

    /// @notice Current market cap in the price feed's own decimals (e.g. 8
    /// for a typical Chainlink USD feed), or (0, false) if there's no pool
    /// yet, the feed can't be read, or its data is stale beyond
    /// maxOracleStaleness. A stale/broken feed never blocks trading — it
    /// only means the tax-disable check can't run until the feed recovers.
    ///
    /// The pool-reads-and-arithmetic half of this (everything past the
    /// oracle call) is delegated to _computeMarketCapFromPair() through an
    /// external self-call specifically so it can sit behind its own
    /// try/catch: unlike the oracle call, that inner computation was
    /// previously unguarded, so any revert from it (a misbehaving pair, or
    /// arithmetic overflow) would have propagated out of here, out of
    /// _maybeDisableTax(), and reverted the entire transfer instead of just
    /// leaving the tax-disable check unable to run this time.
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
    /// in try/catch (Solidity's try/catch only guards external calls) —
    /// this is not meant to be called by anything other than this contract
    /// itself, hence the msg.sender check. Contains everything that reads
    /// the pair and derives a USD market cap from it; isolated here so a
    /// revert anywhere in this block degrades to "can't confirm graduation
    /// right now" instead of bricking the transfer that triggered it.
    function _computeMarketCapFromPair(uint256 ethUsd) external view returns (uint256 marketCap, bool ok) {
        require(msg.sender == address(this), "LaunchedToken: internal only");
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

    /// @notice Graduation requires the market cap target to be met on TWO
    /// separate observations, at least GRADUATION_CONFIRMATION_WINDOW apart,
    /// rather than disabling the tax off a single instantaneous reading.
    ///
    /// Why: a pool's spot price is cheap to move temporarily, and because
    /// marketCap here is spot price * totalSupply(), a typical launch's
    /// enormous totalSupply relative to its actual (thin, freshly-seeded)
    /// liquidity means a comparatively small, temporary trade can imply a
    /// market cap far beyond the pool's real ETH value for exactly one
    /// instant — see the audit note in the repo. Requiring the target to
    /// still hold on a later, separate transfer means unwinding the
    /// manipulating position — itself a transfer against this same pool —
    /// resets graduationCandidateAt back to 0 before confirmation can ever
    /// complete, so an attacker has to keep real capital committed and the
    /// price genuinely elevated for the entire window, not just for one
    /// instant.
    function _maybeDisableTax() internal {
        if (!taxActive) return;
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

        taxActive = false;
        emit TaxDisabled(marketCap);
    }

    // ---------------------------------------------------------------
    // Burn: a true burn, callable directly by any holder at any time —
    // unlike the transfer tax above, this has nothing to do with a pool and
    // is never taxed (a burn's `to` is address(0), never `pair`, so the tax
    // branch in _update() above never applies to it). "True burn" means
    // totalSupply actually decreases (OpenZeppelin's ERC20._burn, which
    // routes through the same _update() override as every other transfer)
    // — not a transfer to a dead address that a holder or explorer could
    // mistake for real supply still existing somewhere.
    // ---------------------------------------------------------------

    event TokensBurned(uint256 amount);

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
}
