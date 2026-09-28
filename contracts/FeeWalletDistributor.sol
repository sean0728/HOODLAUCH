// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IUniswapV2Pair.sol";

/// @title FeeWalletDistributor
/// @notice Where the platform-fee-wallet slice of every taxed buy/sell ends
/// up, once a token's feeWalletDistributor is set. LaunchedToken/CustomToken
/// each carve `toFeeWallet` (whatever's left of their feeBps/platformFeeBps
/// cut after rewardBps/creatorRewardBps are carved out) off of every taxed
/// transfer and send it here in-kind, instead of straight to a plain wallet
/// address. Before this contract existed, that remainder just sat at
/// feeWallet as whatever token it was taxed in — spendable only by manually
/// swapping it out later, on no particular schedule. This gives that slice
/// the exact same automatic-ETH-conversion treatment
/// CreatorRewardsDistributor already gives the creator's cut, down to the
/// anti-dump per-call swap cap (see maxSwapAmount below).
///
/// Unlike CreatorRewardsDistributor — which reads a per-token creator()
/// address that can change over that token's life — every token's
/// fee-wallet slice here pays out to the exact same place: this contract's
/// own `feeWallet`, a single owner-controlled address (the platform's own
/// treasury/ops wallet), because that's the one thing every "fee wallet"
/// cut across every token has in common; there is no per-token recipient to
/// look up. Still keyed and claimed per token (claimableEth[token]) rather
/// than pooled into one running total, purely so a claim/sweep on one
/// token's balance never has to know or care about any other token's — same
/// bookkeeping shape as CreatorRewardsDistributor, different recipient rule.
///
/// Flow, per token:
///  1. In-kind fee-wallet remainder accumulates here as an ordinary ERC20
///     balance of that token — no bookkeeping needed for this step, the
///     token's own balanceOf(this) already is the ledger.
///  2. Anyone (typically an off-chain keeper — see scripts/relayer.js's
///     feeWalletPollLoop) calls triggerFeeWalletSwap(token) once the
///     accumulated balance clears that token's swapThreshold. This swaps up
///     to maxSwapAmount[token] of the current balance (the full balance, if
///     no cap is set) for ETH via the router (using the
///     fee-on-transfer-tolerant variant, since the token being sold here can
///     itself carry a live transfer tax) and credits claimableEth[token].
///  3. Anyone can call claimFeeWalletRewards(token) — it always pays out to
///     whatever this contract's feeWallet is set to AT CLAIM TIME, never a
///     stale snapshot, so a single setFeeWallet() call repoints every
///     token's next claim at once.
contract FeeWalletDistributor is Ownable2Step, ReentrancyGuard {
    IUniswapV2Router02 public immutable router;

    /// @notice The single recipient every token's fee-wallet slice
    /// ultimately pays out to. Owner-settable (see setFeeWallet) — read
    /// live at claim time, never snapshotted per token. address(0) simply
    /// leaves claimFeeWalletRewards permanently reverting until set; it
    /// never blocks triggerFeeWalletSwap, since accumulating and swapping
    /// don't depend on who the eventual recipient is.
    address public feeWallet;

    /// @notice ETH owed to feeWallet, accrued from a given token's swapped
    /// balance. Credited by triggerFeeWalletSwap and zeroed by
    /// claimFeeWalletRewards. Keyed by TOKEN — see the contract-level
    /// comment for why — not by feeWallet itself (there's only ever one).
    mapping(address => uint256) public claimableEth;

    /// @notice Minimum balance of `token` this contract must be holding
    /// before triggerFeeWalletSwap(token) will execute — identical
    /// anti-dust/anti-griefing knob as
    /// CreatorRewardsDistributor.swapThreshold, for the same reason a single
    /// global threshold wouldn't make sense (every token has its own
    /// supply/decimals scale). Defaults to 0 (any nonzero balance triggers)
    /// until the owner sets one for a given token.
    mapping(address => uint256) public swapThreshold;

    /// @notice Caps how much of `token`'s balance a single
    /// triggerFeeWalletSwap(token) call is allowed to sell — identical
    /// anti-dump knob as CreatorRewardsDistributor.maxSwapAmount, and for
    /// the same reason: without it, an infrequently-triggered token could
    /// accumulate a large balance and have its entire pile sold in one
    /// swap the moment someone finally calls triggerFeeWalletSwap, showing
    /// up as a single visible dump against that token's own pool. Defaults
    /// to 0, meaning "uncapped", until the owner sets one — once set, a
    /// balance above the cap drains across multiple separate calls instead
    /// of one, each individual swap staying small and proportional.
    mapping(address => uint256) public maxSwapAmount;

    /// @notice Protective slippage floor applied to triggerFeeWalletSwap's
    /// own router trade — see the accompanying audit report's Finding FW-1.
    /// Before this existed, triggerFeeWalletSwap accepted a purely
    /// caller-supplied minEthOut with no protocol-side floor computed from
    /// the pool's own reserves; since the function is deliberately
    /// permissionless (see its own comment), anyone could call it with
    /// minEthOut == 0 and sandwich their own call for MEV profit, reducing
    /// what the platform's own fee wallet ultimately collects. Identical
    /// fix, same fixed 5.00%-8.00% band, as the one already applied to
    /// CreatorRewardsDistributor.triggerCreatorSwap for the same reason.
    uint256 public swapSlippageBps = 600; // 6.00% default
    uint256 public constant MIN_SWAP_SLIPPAGE_BPS = 500; // 5.00%
    uint256 public constant MAX_SWAP_SLIPPAGE_BPS = 800; // 8.00%

    event FeeWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event SwapThresholdUpdated(address indexed token, uint256 newThreshold);
    event MaxSwapAmountUpdated(address indexed token, uint256 newMax);
    event SwapSlippageBpsUpdated(uint256 newBps);
    event FeeWalletSwapTriggered(address indexed token, uint256 amountIn, uint256 ethOut);
    event FeeWalletRewardsClaimed(address indexed token, address indexed feeWallet, address indexed caller, uint256 amount);

    constructor(address router_, address initialOwner_, address feeWallet_) Ownable(initialOwner_) {
        require(router_ != address(0), "FeeWalletDistributor: invalid router");
        router = IUniswapV2Router02(router_);
        feeWallet = feeWallet_;
        emit FeeWalletUpdated(address(0), feeWallet_);
    }

    /// @notice Lets this contract receive ETH — its only intended inflow is
    /// the swap output inside triggerFeeWalletSwap below, but this also
    /// covers any stray dust sent directly.
    receive() external payable {}

    /// @notice Repoints where every token's next claimFeeWalletRewards call
    /// sends its ETH. Takes effect on the next claim for every token at
    /// once — never retroactive to ETH already paid out, and never touches
    /// claimableEth balances themselves.
    function setFeeWallet(address newWallet) external onlyOwner {
        emit FeeWalletUpdated(feeWallet, newWallet);
        feeWallet = newWallet;
    }

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
    /// triggerFeeWalletSwap trade — see swapSlippageBps above and Finding
    /// FW-1. Bounded to the same 5.00%-8.00% band used everywhere else in
    /// this codebase for the identical purpose.
    function setSwapSlippageBps(uint256 newBps) external onlyOwner {
        require(newBps >= MIN_SWAP_SLIPPAGE_BPS, "FeeWalletDistributor: slippage below 5% floor");
        require(newBps <= MAX_SWAP_SLIPPAGE_BPS, "FeeWalletDistributor: slippage above 8% ceiling");
        swapSlippageBps = newBps;
        emit SwapSlippageBpsUpdated(newBps);
    }

    /// @dev Standard Uniswap V2 constant-product quote (0.30% swap fee baked
    /// into the 997/1000 constants) — used only to derive a protective
    /// slippage floor below, never to execute anything. Same helper as
    /// CreatorRewardsDistributor/CustomToken/CustomTokenFactory's identical
    /// utility.
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        return numerator / denominator;
    }

    /// @dev Quotes amountIn's expected ETH output off the token/WETH pool's
    /// own live reserves and applies swapSlippageBps — see Finding FW-1.
    /// Returns 0 if no pool is found or either reserve is empty, which
    /// triggerFeeWalletSwap treats as "can't compute a protocol floor this
    /// time," falling back to the caller's own minEthOut rather than
    /// blocking the swap outright.
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
    /// (path = [token, router.WETH()]), and credits the proceeds to
    /// claimableEth[token]. Permissionless, like every trigger in
    /// CreatorRewardsDistributor/PlatformRewardsDistributor — the
    /// destination (this contract's own feeWallet, read at claim time)
    /// never depends on who calls it.
    function triggerFeeWalletSwap(address token, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        require(token != address(0), "FeeWalletDistributor: invalid token");
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0 && balance >= swapThreshold[token], "FeeWalletDistributor: below threshold");
        uint256 cap = maxSwapAmount[token];
        uint256 amountIn = (cap > 0 && balance > cap) ? cap : balance;

        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = router.WETH();

        // Finding FW-1: minEthOut alone was a purely caller-supplied value
        // with no protocol-side floor — since this function is deliberately
        // permissionless, that let anyone call it with minEthOut == 0 and
        // sandwich their own call for MEV profit. effectiveMinOut is
        // whichever is stricter of the caller's own minEthOut and a floor
        // computed from the pool's own live reserves.
        uint256 protectiveFloor = _protectiveMinOut(token, amountIn);
        uint256 effectiveMinOut = minEthOut > protectiveFloor ? minEthOut : protectiveFloor;

        uint256 before = address(this).balance;
        IERC20(token).approve(address(router), amountIn);
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            amountIn,
            effectiveMinOut,
            path,
            address(this),
            block.timestamp + 15 minutes
        );
        ethOut = address(this).balance - before;

        claimableEth[token] += ethOut;
        emit FeeWalletSwapTriggered(token, amountIn, ethOut);
    }

    /// @notice Pays out claimableEth[token] to feeWallet, read live at call
    /// time (see setFeeWallet) — never a stale snapshot. Callable by
    /// anyone — same permissionless-but-fixed-destination pattern as
    /// triggerFeeWalletSwap above. Checks-effects-interactions (balance
    /// zeroed before the external call) plus nonReentrant besides.
    function claimFeeWalletRewards(address token) external nonReentrant returns (uint256 amount) {
        address recipient = feeWallet;
        require(recipient != address(0), "FeeWalletDistributor: fee wallet not set");
        amount = claimableEth[token];
        require(amount > 0, "FeeWalletDistributor: nothing to claim");
        claimableEth[token] = 0;
        (bool sent, ) = payable(recipient).call{value: amount}("");
        require(sent, "FeeWalletDistributor: ETH transfer failed");
        emit FeeWalletRewardsClaimed(token, recipient, msg.sender, amount);
    }
}
