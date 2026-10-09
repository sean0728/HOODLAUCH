// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./interfaces/ICreatorAware.sol";

/// @title CreatorRewardsDistributor
/// @notice Where the creator-reward slice of every taxed buy/sell ends up.
/// LaunchedToken/CustomToken each carve creatorRewardBps (out of their total
/// feeBps/platformFeeBps platform tax — never on top of it, and never
/// overlapping the existing rewardBps carve-out to PlatformRewardsDistributor)
/// off of every taxed transfer and send it here, in-kind, in whatever token
/// that trade was actually taxed in. See LaunchedToken._update /
/// CustomToken._update.
///
/// Unlike PlatformRewardsDistributor — which pools every token's
/// contribution into one shared PlatformToken buyback split across all
/// PlatformToken holders — this keeps every token's creator-reward stream
/// entirely separate and pays out in native ETH, per token, to that
/// specific token's own creator. Closer to how pump.fun's creator-fee-share
/// works than to this platform's own holder-airdrop mechanism.
///
/// Flow, per token:
///  1. In-kind creatorRewardBps accumulates here as an ordinary ERC20
///     balance of that token — no bookkeeping needed for this step, the
///     token's own balanceOf(this) already is the ledger.
///  2. Anyone (typically an off-chain keeper — see scripts/relayer.js's
///     pollCreatorRewardSwaps) calls triggerCreatorSwap(token) once the
///     accumulated balance clears that token's swapThreshold. This swaps
///     the FULL current balance for ETH via the router (using the
///     fee-on-transfer-tolerant variant, since the token being sold here can
///     itself carry a live transfer tax) and credits claimableEth[token].
///  3. Anyone can call claimCreatorRewards(token) — it always pays out to
///     that token's own creator(), regardless of who calls it, so a
///     creator's own "Claim" button on the site, an off-chain keeper, or a
///     direct call from a block explorer all resolve to the exact same
///     recipient.
///
/// claimableEth is keyed by TOKEN, not by creator address, deliberately —
/// per-token claiming is the explicit design here. A creator with several
/// launches gets several independent claimable balances, one per token,
/// matching how a portfolio view naturally lists them — never one pooled
/// balance across everything a wallet has ever launched.
contract CreatorRewardsDistributor is Ownable2Step, ReentrancyGuard {
    IUniswapV2Router02 public immutable router;

    /// @notice ETH owed to a token's creator, credited by
    /// triggerCreatorSwap and zeroed by claimCreatorRewards. Keyed by the
    /// TOKEN address (see contract-level comment for why), not the
    /// creator's own address.
    mapping(address => uint256) public claimableEth;

    /// @notice Minimum balance of `token` this contract must be holding
    /// before triggerCreatorSwap(token) will execute — same anti-dust/
    /// anti-griefing knob as PlatformRewardsDistributor.tokenBuybackThreshold,
    /// and for the same reason a single global threshold wouldn't make sense
    /// (every token has its own supply/decimals scale). Defaults to 0 (any
    /// nonzero balance triggers) until the owner sets one for a given token.
    mapping(address => uint256) public swapThreshold;

    /// @notice Caps how much of `token`'s balance a single
    /// triggerCreatorSwap(token) call is allowed to sell — the anti-dump
    /// knob. Before this existed, an infrequently-triggered token could
    /// accumulate a large balance and then have its *entire* pile sold in
    /// one swap the moment someone finally called triggerCreatorSwap,
    /// showing up as a single visible dump against that token's own pool.
    /// Defaults to 0, meaning "uncapped" (the original all-at-once
    /// behavior) until the owner sets one. Once set, a balance above the
    /// cap is drained across multiple separate calls instead of one — each
    /// individual swap stays small and proportional, at the cost of taking
    /// more calls (and, if swapThreshold is also set, more time re-crossing
    /// it between partial drains) to fully clear a large backlog. See
    /// scripts/relayer.js's creator-rewards sweep loop, which already calls
    /// this on a recurring schedule and so naturally keeps re-draining a
    /// capped balance over successive ticks without any changes needed
    /// there.
    mapping(address => uint256) public maxSwapAmount;

    /// @notice Protective slippage floor applied to triggerCreatorSwap's own
    /// router trade — see Finding CR-2 in the accompanying audit report.
    /// Before this existed, triggerCreatorSwap accepted a purely
    /// caller-supplied minEthOut with no protocol-side floor computed from
    /// the pool's own reserves; since the function is deliberately
    /// permissionless (see its own comment), anyone could call it with
    /// minEthOut == 0 and sandwich their own call for MEV profit at the
    /// creator's expense. Same fixed 5.00%-8.00% band, and the same
    /// "whichever is stricter" combination with the caller's own minEthOut,
    /// already used for CustomToken/CustomTokenFactory's internal swaps.
    uint256 public swapSlippageBps = 600; // 6.00% default
    uint256 public constant MIN_SWAP_SLIPPAGE_BPS = 500; // 5.00%
    uint256 public constant MAX_SWAP_SLIPPAGE_BPS = 800; // 8.00%

    event SwapThresholdUpdated(address indexed token, uint256 newThreshold);
    event MaxSwapAmountUpdated(address indexed token, uint256 newMax);
    event SwapSlippageBpsUpdated(uint256 newBps);
    event CreatorSwapTriggered(address indexed token, address indexed creator, uint256 amountIn, uint256 ethOut);
    event CreatorRewardsClaimed(address indexed token, address indexed creator, address indexed caller, uint256 amount);
    event OrphanedEthRescued(address indexed token, address indexed to, uint256 amount);
    event OrphanedTokensRescued(address indexed token, address indexed to, uint256 amount);

    constructor(address router_, address initialOwner_) Ownable(initialOwner_) {
        require(router_ != address(0), "CreatorRewardsDistributor: invalid router");
        router = IUniswapV2Router02(router_);
    }

    /// @notice Lets this contract receive ETH — its only intended inflow is
    /// the swap output inside triggerCreatorSwap below, but this also covers
    /// any stray dust sent directly.
    receive() external payable {}

    function setSwapThreshold(address token, uint256 newThreshold) external onlyOwner {
        swapThreshold[token] = newThreshold;
        emit SwapThresholdUpdated(token, newThreshold);
    }

    /// @notice See maxSwapAmount's own comment above. 0 means uncapped.
    function setMaxSwapAmount(address token, uint256 newMax) external onlyOwner {
        maxSwapAmount[token] = newMax;
        emit MaxSwapAmountUpdated(token, newMax);
    }

    /// @notice Adjusts the protective slippage floor applied to every
    /// triggerCreatorSwap trade — see swapSlippageBps above and Finding CR-2.
    /// Bounded to the same 5.00%-8.00% band used everywhere else in this
    /// codebase for the identical purpose.
    function setSwapSlippageBps(uint256 newBps) external onlyOwner {
        require(newBps >= MIN_SWAP_SLIPPAGE_BPS, "CreatorRewardsDistributor: slippage below 5% floor");
        require(newBps <= MAX_SWAP_SLIPPAGE_BPS, "CreatorRewardsDistributor: slippage above 8% ceiling");
        swapSlippageBps = newBps;
        emit SwapSlippageBpsUpdated(newBps);
    }

    /// @dev Standard Uniswap V2 constant-product quote (0.30% swap fee baked
    /// into the 997/1000 constants) — used only to derive a protective
    /// slippage floor below, never to execute anything. Same helper as
    /// TokenFactory/CustomToken/CustomTokenFactory's identical utility.
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        return numerator / denominator;
    }

    /// @dev Quotes amountIn's expected ETH output off the token/WETH pool's
    /// own live reserves and applies swapSlippageBps — see Finding CR-2.
    /// Returns 0 if no pool is found or either reserve is empty, which
    /// triggerCreatorSwap treats as "can't compute a protocol floor this
    /// time," falling back to the caller's own minEthOut rather than
    /// blocking the swap outright — consistent with how every other
    /// quote-derived floor in this codebase degrades on a missing pool.
    function _protectiveMinOut(address token, uint256 amountIn) private view returns (uint256) {
        address weth = router.WETH();
        address pairAddr = IUniswapV2FactoryMinimal(router.factory()).getPair(token, weth);
        if (pairAddr == address(0)) return 0;

        (uint112 reserve0, uint112 reserve1, ) = IUniswapV2PairMinimal(pairAddr).getReserves();
        address token0 = IUniswapV2PairMinimal(pairAddr).token0();
        uint256 reserveIn = token0 == token ? uint256(reserve0) : uint256(reserve1);
        uint256 reserveOut = token0 == token ? uint256(reserve1) : uint256(reserve0);
        if (reserveIn == 0 || reserveOut == 0) return 0;

        uint256 quoted = _getAmountOut(amountIn, reserveIn, reserveOut);
        return quoted - (quoted * swapSlippageBps) / 10_000;
    }

    /// @notice Swaps up to maxSwapAmount[token] of this contract's balance
    /// of `token` for ETH (the entire balance, if no cap is set — see
    /// maxSwapAmount above), routed straight through WETH
    /// (path = [token, router.WETH()]), and credits the proceeds to that
    /// token's own creator via claimableEth[token]. Permissionless, like
    /// every trigger in PlatformRewardsDistributor — the destination (this
    /// exact token's own creator) never depends on who calls it. Reads
    /// creator() off the token itself at call time (ICreatorAware — both
    /// LaunchedToken and CustomToken expose it as a plain public getter),
    /// so a creator transfer on CustomToken (transferCreator/acceptCreator)
    /// is always reflected in whatever swap happens after it goes through,
    /// never a stale snapshot taken here.
    /// @dev Stack-pressure fix only (no behavior change): groups the loose
    /// uint256 locals this function used to carry (amountIn, protectiveFloor,
    /// effectiveMinOut, before) into a single memory struct. A struct local
    /// is one memory-pointer stack slot regardless of how many fields it
    /// carries, whereas N loose uint256 locals are N separate stack slots —
    /// this function never had a helper split at all, so unlike the other
    /// distributor contracts it was tripping HH600 ("stack too deep") purely
    /// from its own flat local count, not from any later re-inlining.
    struct SwapPlan {
        uint256 amountIn;
        uint256 protectiveFloor;
        uint256 effectiveMinOut;
        uint256 before;
    }

    function triggerCreatorSwap(address token, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        require(token != address(0), "CreatorRewardsDistributor: invalid token");
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0 && balance >= swapThreshold[token], "CreatorRewardsDistributor: below threshold");
        uint256 cap = maxSwapAmount[token];

        SwapPlan memory plan;
        plan.amountIn = (cap > 0 && balance > cap) ? cap : balance;

        address creator = ICreatorAware(token).creator();
        require(creator != address(0), "CreatorRewardsDistributor: token has no creator");

        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = router.WETH();

        // Finding CR-2: minEthOut alone was a purely caller-supplied value
        // with no protocol-side floor — since this function is deliberately
        // permissionless, that let anyone call it with minEthOut == 0 and
        // sandwich their own call for MEV profit at the creator's expense.
        // effectiveMinOut is whichever is stricter of the caller's own
        // minEthOut and a floor computed from the pool's own live reserves,
        // same "whichever is stricter" combination CustomTokenFactory uses
        // for its own creator buy-in.
        plan.protectiveFloor = _protectiveMinOut(token, plan.amountIn);
        plan.effectiveMinOut = minEthOut > plan.protectiveFloor ? minEthOut : plan.protectiveFloor;

        plan.before = address(this).balance;
        IERC20(token).approve(address(router), plan.amountIn);
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            plan.amountIn,
            plan.effectiveMinOut,
            path,
            address(this),
            block.timestamp + 15 minutes
        );
        ethOut = address(this).balance - plan.before;

        claimableEth[token] += ethOut;
        emit CreatorSwapTriggered(token, creator, plan.amountIn, ethOut);
    }

    /// @notice Intake for the creator's share of a bonding curve's per-trade fee,
    /// which arrives as ETH rather than as the launched token. Credited to
    /// `token`'s creator exactly like ETH converted from in-kind rewards, and
    /// claimed the same way (claimCreatorRewards). Anyone may send ETH here; it
    /// can only ever be claimed by the token's creator.
    event CreatorFeeDeposited(address indexed token, address indexed from, uint256 amount);

    function depositFor(address token) external payable {
        require(token != address(0), "CreatorRewardsDistributor: invalid token");
        require(msg.value > 0, "CreatorRewardsDistributor: no ETH");
        claimableEth[token] += msg.value;
        emit CreatorFeeDeposited(token, msg.sender, msg.value);
    }

    /// @notice Pays out claimableEth[token] to that token's own creator().
    /// Callable by anyone — same permissionless-but-fixed-destination
    /// pattern as triggerCreatorSwap above — so a creator's own claim
    /// button, an off-chain keeper, or a direct block-explorer call all pay
    /// the exact same recipient. Checks-effects-interactions (balance
    /// zeroed before the external call) plus nonReentrant besides.
    function claimCreatorRewards(address token) external nonReentrant returns (uint256 amount) {
        address creator = ICreatorAware(token).creator();
        require(creator != address(0), "CreatorRewardsDistributor: token has no creator");
        amount = claimableEth[token];
        require(amount > 0, "CreatorRewardsDistributor: nothing to claim");
        claimableEth[token] = 0;
        (bool sent, ) = payable(creator).call{value: amount}("");
        require(sent, "CreatorRewardsDistributor: ETH transfer failed");
        emit CreatorRewardsClaimed(token, creator, msg.sender, amount);
    }

    /// @notice Escape hatch for Finding CR-1: once a token's creator has
    /// permanently renounced (LaunchedToken.renounceCreator() /
    /// CustomToken.renounceCreator() — a normal, explicitly supported action
    /// elsewhere in this platform), creator() returns address(0) forever,
    /// which means claimCreatorRewards(token) can never succeed again for
    /// that token. Without this function, any ETH already sitting in
    /// claimableEth[token] at that point — and, before the CR-1 fix,
    /// anything triggerCreatorSwap would have credited afterward — would be
    /// stuck in this contract permanently, with no recovery path anywhere.
    ///
    /// Deliberately narrow, mirroring the rest of this codebase's escape
    /// hatches (e.g. LaunchedToken/CustomToken.updatePriceFeed, which only
    /// works once the current feed has gone stale): only callable once the
    /// token's OWN creator() call reports address(0). The owner can never
    /// redirect a live creator's still-claimable balance this way — doing so
    /// would require the creator to have already, irreversibly, given up the
    /// role that balance was owed to.
    function rescueOrphanedEth(address token, address to) external onlyOwner nonReentrant returns (uint256 amount) {
        require(to != address(0), "CreatorRewardsDistributor: invalid recipient");
        require(ICreatorAware(token).creator() == address(0), "CreatorRewardsDistributor: creator has not renounced");
        amount = claimableEth[token];
        require(amount > 0, "CreatorRewardsDistributor: nothing to rescue");
        claimableEth[token] = 0;
        (bool sent, ) = payable(to).call{value: amount}("");
        require(sent, "CreatorRewardsDistributor: ETH transfer failed");
        emit OrphanedEthRescued(token, to, amount);
    }

    /// @notice Companion to rescueOrphanedEth above, for the in-kind token
    /// side of the same problem: once a token's creator has renounced,
    /// triggerCreatorSwap(token) can never run again either (it requires the
    /// same nonzero creator()), so whatever `token` balance this contract is
    /// still holding — including anything the token's own tax keeps sending
    /// here on every subsequent trade, since LaunchedToken/CustomToken's own
    /// creatorRewardBps carve-out never checks the token's creator status —
    /// would otherwise sit here forever, permanently unswappable and
    /// unclaimable. Same narrow, renounced-only gate as rescueOrphanedEth;
    /// moves the raw token balance rather than swapping it here, so the
    /// owner decides what happens to it next (e.g. route it to the fee
    /// treasury, or to a replacement distributor) rather than this function
    /// making that call unilaterally.
    function rescueOrphanedTokens(address token, address to) external onlyOwner returns (uint256 amount) {
        require(to != address(0), "CreatorRewardsDistributor: invalid recipient");
        require(ICreatorAware(token).creator() == address(0), "CreatorRewardsDistributor: creator has not renounced");
        amount = IERC20(token).balanceOf(address(this));
        require(amount > 0, "CreatorRewardsDistributor: nothing to rescue");
        bool sent = IERC20(token).transfer(to, amount);
        require(sent, "CreatorRewardsDistributor: token transfer failed");
        emit OrphanedTokensRescued(token, to, amount);
    }
}
