// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IAggregatorV3.sol";

/// @title BondingCurve
/// @notice A "just launch" token's trading venue before it ever touches a
/// DEX. TokenFactory mints 100% of a bonding-curve token's supply directly
/// into one of these; from that point, anyone can buy() or sell() against
/// the curve itself. Price follows a constant-product formula over virtual
/// reserves (the same shape Uniswap V2 pools use, just with a virtual
/// starting depth instead of real reserves at zero) — the same general
/// approach pump.fun popularized on Solana.
///
/// A 0.25% fee is taken on both buys and sells, in ETH, and forwarded to
/// feeWallet immediately. Once the curve's live market cap (checked via a
/// Chainlink-style ETH/USD feed) reaches graduationTargetUsd, the buy that
/// crosses the line automatically deposits everything the curve has
/// collected into a real DEX pool, in the same transaction — no separate
/// step, no one has to trigger it. Because that liquidity came from many
/// different buyers rather than one creator funding it personally, the
/// resulting LP tokens are sent to a burn address rather than locked for
/// anyone to reclaim: it's permanent, unowned liquidity, not a position
/// someone can later withdraw.
///
/// Deployed as an EIP-1167 clone per launch, same pattern as LaunchedToken
/// — the constructor only ever locks the implementation contract itself;
/// initialize() does the real setup on each clone.
contract BondingCurve is ReentrancyGuard {
    // Standard "everyone knows this is a burn" address, used for graduated
    // LP tokens rather than address(0) — some pool implementations mint to
    // address(0) without issue, but plenty don't, and 0x...dEaD is the
    // convention that reliably works everywhere.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    bool private _initialized;

    IERC20 public token;
    IUniswapV2Router02 public router;
    IAggregatorV3 public priceFeed;

    address public feeWallet;
    uint256 public feeBps; // 25 = 0.25%

    uint256 public totalSupplyCached;
    uint256 public graduationTargetUsd; // whole dollars, e.g. 80000
    uint256 public maxOracleStaleness; // seconds; graduation check is skipped (not reverted) if the feed is older than this

    // virtualEthReserves and virtualTokenReserves ARE the pricing state —
    // every buy/sell updates them the same way it would update a real AMM
    // pool's reserves. They start deeper than the real token balance
    // alone would allow (see TokenFactory's initialVirtualEthReserves /
    // curveVirtualTokenMultiplierBps for how that initial depth is chosen)
    // so the price rises smoothly rather than spiking on the first trade.
    // If 100% of the real token balance were ever sold, the resulting
    // price implies a market cap of initialVirtualEthReserves * (1+f)/f^2
    // ETH, where f = curveVirtualTokenMultiplierBps / 10_000 — that should
    // land comfortably above graduationTargetUsd (in USD terms) so
    // graduation happens with real headroom left, not at the curve's own
    // capacity limit.
    uint256 public virtualEthReserves;
    uint256 public virtualTokenReserves;
    uint256 public realEthReserves; // actual ETH held, backing sells + the eventual DEX seed

    bool public graduated;

    event Buy(address indexed buyer, uint256 ethIn, uint256 fee, uint256 tokensOut);
    event Sell(address indexed seller, uint256 tokensIn, uint256 fee, uint256 ethOut);
    event Graduated(uint256 ethToLiquidity, uint256 tokensToLiquidity, uint256 lpAmount);

    // Runs exactly once, on the implementation contract TokenFactory clones
    // from. Never runs again on any clone.
    constructor() {
        _initialized = true;
    }

    function initialize(
        address token_,
        address router_,
        address feeWallet_,
        address priceFeed_,
        uint256 graduationTargetUsd_,
        uint256 maxOracleStaleness_,
        uint256 feeBps_,
        uint256 initialVirtualEthReserves_,
        uint256 initialVirtualTokenReserves_,
        uint256 totalSupply_
    ) external {
        require(!_initialized, "BondingCurve: already initialized");
        require(token_ != address(0), "BondingCurve: invalid token");
        require(router_ != address(0), "BondingCurve: invalid router");
        require(feeWallet_ != address(0), "BondingCurve: invalid fee wallet");
        require(priceFeed_ != address(0), "BondingCurve: invalid price feed");
        require(initialVirtualEthReserves_ > 0, "BondingCurve: invalid virtual ETH reserves");
        require(initialVirtualTokenReserves_ > 0, "BondingCurve: invalid virtual token reserves");

        _initialized = true;
        token = IERC20(token_);
        router = IUniswapV2Router02(router_);
        feeWallet = feeWallet_;
        priceFeed = IAggregatorV3(priceFeed_);
        graduationTargetUsd = graduationTargetUsd_;
        maxOracleStaleness = maxOracleStaleness_;
        feeBps = feeBps_;
        virtualEthReserves = initialVirtualEthReserves_;
        virtualTokenReserves = initialVirtualTokenReserves_;
        totalSupplyCached = totalSupply_;
    }

    /// @notice Buy tokens with ETH. Reverts if the curve has already
    /// graduated (trade on the DEX instead at that point) or if the tokens
    /// out would be below minTokensOut.
    function buy(uint256 minTokensOut) external payable nonReentrant {
        require(!graduated, "BondingCurve: already graduated");
        require(msg.value > 0, "BondingCurve: no ETH sent");

        uint256 fee = (msg.value * feeBps) / 10_000;
        uint256 ethIn = msg.value - fee;

        uint256 k = virtualEthReserves * virtualTokenReserves;
        uint256 newVirtualEthReserves = virtualEthReserves + ethIn;
        uint256 newVirtualTokenReserves = k / newVirtualEthReserves;
        uint256 tokensOut = virtualTokenReserves - newVirtualTokenReserves;

        require(tokensOut >= minTokensOut, "BondingCurve: slippage");
        require(tokensOut <= token.balanceOf(address(this)), "BondingCurve: insufficient curve liquidity");

        virtualEthReserves = newVirtualEthReserves;
        virtualTokenReserves = newVirtualTokenReserves;
        realEthReserves += ethIn;

        if (fee > 0) {
            (bool sentFee, ) = feeWallet.call{value: fee}("");
            require(sentFee, "BondingCurve: fee transfer failed");
        }

        bool sentTokens = token.transfer(msg.sender, tokensOut);
        require(sentTokens, "BondingCurve: token transfer failed");

        emit Buy(msg.sender, msg.value, fee, tokensOut);

        _maybeGraduate();
    }

    /// @notice Sell tokens back to the curve for ETH. Requires an ERC20
    /// approval to this contract first. Reverts if the curve has already
    /// graduated, or if the net ETH out would be below minEthOut.
    function sell(uint256 tokenAmount, uint256 minEthOut) external nonReentrant {
        require(!graduated, "BondingCurve: already graduated");
        require(tokenAmount > 0, "BondingCurve: no tokens sent");

        uint256 k = virtualEthReserves * virtualTokenReserves;
        uint256 newVirtualTokenReserves = virtualTokenReserves + tokenAmount;
        uint256 newVirtualEthReserves = k / newVirtualTokenReserves;
        uint256 ethOutGross = virtualEthReserves - newVirtualEthReserves;

        uint256 fee = (ethOutGross * feeBps) / 10_000;
        uint256 ethOutNet = ethOutGross - fee;

        require(ethOutNet >= minEthOut, "BondingCurve: slippage");
        require(ethOutGross <= realEthReserves, "BondingCurve: insufficient real ETH reserves");

        virtualEthReserves = newVirtualEthReserves;
        virtualTokenReserves = newVirtualTokenReserves;
        realEthReserves -= ethOutGross;

        bool pulled = token.transferFrom(msg.sender, address(this), tokenAmount);
        require(pulled, "BondingCurve: token transferFrom failed");

        if (fee > 0) {
            (bool sentFee, ) = feeWallet.call{value: fee}("");
            require(sentFee, "BondingCurve: fee transfer failed");
        }
        (bool sentEth, ) = msg.sender.call{value: ethOutNet}("");
        require(sentEth, "BondingCurve: ETH transfer failed");

        emit Sell(msg.sender, tokenAmount, fee, ethOutNet);
    }

    /// @notice Current marginal price, in wei per whole token (18 decimals
    /// assumed on the token side). This is a spot price off the curve's
    /// current reserves, not an average execution price for any given
    /// trade size.
    function currentPriceWeiPerToken() public view returns (uint256) {
        return (virtualEthReserves * 1e18) / virtualTokenReserves;
    }

    /// @notice Current market cap in the price feed's own decimals (e.g.
    /// 8 for a typical Chainlink USD feed), or 0 if the feed can't be read
    /// or its data is stale beyond maxOracleStaleness. A stale/broken feed
    /// never blocks trading — it only means graduation can't be checked
    /// until the feed recovers.
    function currentMarketCapInFeedDecimals() public view returns (uint256 marketCap, bool feedIsFresh) {
        try priceFeed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0) return (0, false);
            if (block.timestamp - updatedAt > maxOracleStaleness) return (0, false);

            uint256 pricePerTokenWei = currentPriceWeiPerToken();
            uint256 ethUsd = uint256(answer);
            uint256 usdPerToken = (pricePerTokenWei * ethUsd) / 1e18;
            marketCap = (usdPerToken * totalSupplyCached) / 1e18;
            feedIsFresh = true;
        } catch {
            return (0, false);
        }
    }

    function _maybeGraduate() internal {
        (uint256 marketCap, bool feedIsFresh) = currentMarketCapInFeedDecimals();
        if (!feedIsFresh) return;

        uint256 targetInFeedDecimals = graduationTargetUsd * (10 ** priceFeed.decimals());
        if (marketCap >= targetInFeedDecimals) {
            _graduate();
        }
    }

    function _graduate() internal {
        graduated = true;

        uint256 ethForLiquidity = realEthReserves;
        uint256 tokensForLiquidity = token.balanceOf(address(this));
        realEthReserves = 0;

        bool approved = token.approve(address(router), tokensForLiquidity);
        require(approved, "BondingCurve: approve failed");

        (, , uint256 lpAmount) = router.addLiquidityETH{value: ethForLiquidity}(
            address(token),
            tokensForLiquidity,
            0,
            0,
            BURN_ADDRESS,
            block.timestamp + 15 minutes
        );

        emit Graduated(ethForLiquidity, tokensForLiquidity, lpAmount);
    }
}
