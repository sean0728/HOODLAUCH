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

    event TokenInitialized(string name, string symbol, uint256 totalSupply, address indexed creator);
    event TaxConfigured(address indexed pair, address indexed feeWallet, uint256 feeBps, uint256 graduationTargetUsd);
    event TaxDisabled(uint256 marketCapInFeedDecimals);

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

    function _maybeDisableTax() internal {
        if (!taxActive) return;
        (uint256 marketCap, bool feedIsFresh) = currentMarketCapInFeedDecimals();
        if (!feedIsFresh) return;

        uint256 targetInFeedDecimals = graduationTargetUsd * (10 ** priceFeed.decimals());
        if (marketCap >= targetInFeedDecimals) {
            taxActive = false;
            emit TaxDisabled(marketCap);
        }
    }
}
