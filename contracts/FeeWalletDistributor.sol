// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./interfaces/IPlatformToken.sol";

/// @title FeeWalletDistributor
/// @notice Where the platform-fee-wallet slice of every taxed buy/sell ends
/// up, once a token's feeWalletDistributor is set. LaunchedToken/CustomToken
/// each carve `toFeeWallet` (whatever's left of their feeBps/platformFeeBps
/// cut after rewardBps/creatorRewardBps are carved out) off of every taxed
/// transfer and send it here in-kind, instead of straight to a plain wallet
/// address.
///
/// --- Buyback + burn + holder-airdrop (this version) ---
/// Per the platform's confirmed design, this slice is no longer paid out to
/// feeWallet in full. Once platformToken is configured (see
/// setPlatformToken), every amount this contract pulls in `token` is split
/// 50/50 at the top of triggerFeeWalletSwap:
///  - 50% swaps to ETH exactly as this contract always did, credited to
///    claimableEth[token] and paid out via claimFeeWalletRewards — this half
///    is unchanged in every respect from the original version of this file.
///  - 50% swaps to platformToken and is immediately split again, 50/50, into
///    an outright burn and pendingAirdropTokens — the accumulate-and-batch-
///    trigger buyback/burn/push-airdrop machinery below
///    (setPlatformToken/_splitAndProcess/startAirdropRound/
///    processAirdropBatch/_sendPlatformToken) is ported directly from
///    PlatformRewardsDistributor, at the platform's explicit request, so the
///    two contracts behave identically for this piece: same fixed 50/50
///    burn/airdrop split, same push-based holder payout walking
///    PlatformToken's own holder registry in gas-bounded batches, same
///    try/catch-and-requeue protection against a single reverting holder
///    bricking a round (mirroring Finding PR-1's fix), same
///    approve-to-zero-then-approve pattern for non-standard ERC20 allowances
///    (mirroring Finding PR-3's fix).
///
/// Net effect once platformToken is configured: of every unit of platform
/// tax that reaches this contract, 50% ends up as ETH at feeWallet, 25%
/// worth of platformToken is burned, and 25% worth of platformToken is
/// pushed out to platformToken's own holders.
///
/// --- Security review (this file) ---
/// One finding from the accompanying audit report is fixed directly in this
/// version:
///  - Finding FWD-1 (Medium): the buyback leg originally had no
///    caller-supplied slippage floor of its own — only the ETH leg did — so
///    a caller wanting extra protection beyond the protocol default had no
///    way to provide it for that leg. Fixed by adding a second
///    triggerFeeWalletSwap(token, minEthOut, minPlatformTokensOut) overload;
///    the original 2-argument overload is unchanged and simply forwards
///    minPlatformTokensOut = 0.
/// Four additional informational notes (FWD-2..FWD-5) are documented in the
/// accompanying report and require no code change.
///
/// Before platformToken is configured, this contract behaves exactly as it
/// always did: the entire pulled amount converts to ETH for feeWallet, and
/// nothing is held back — same "inert until configured" pattern documented
/// on PlatformRewardsDistributor.platformToken, so enabling this later never
/// requires touching any already-launched token or factory again.
///
/// Flow, per token, once configured:
///  1. In-kind fee-wallet remainder accumulates here as an ordinary ERC20
///     balance of that token — no bookkeeping needed for this step, the
///     token's own balanceOf(this) already is the ledger.
///  2. Anyone (typically an off-chain keeper — see scripts/relayer.js's
///     feeWalletPollLoop) calls triggerFeeWalletSwap(token, minEthOut) once
///     the accumulated balance clears that token's swapThreshold. This pulls
///     up to maxSwapAmount[token] of the current balance (the full balance,
///     if no cap is set), splits it 50/50, and:
///       a. swaps the ETH-leg half for ETH via the router (fee-on-transfer-
///          tolerant, since `token` can itself carry a live transfer tax)
///          and credits claimableEth[token] — minEthOut applies only to this
///          leg, so existing callers (including scripts/relayer.js, which
///          predicts and supplies minEthOut for the historically-full
///          amount) keep working unchanged; the protocol-side protective
///          floor (see _protectiveMinOut/swapSlippageBps) is recomputed
///          against whatever the actual half-sized leg is.
///       b. swaps the buyback-leg half for platformToken (routed through
///          WETH) and splits the proceeds 50% burn / 50% into
///          pendingAirdropTokens, purely against the protocol's own
///          protective floor (no caller-supplied override for this leg,
///          since triggerFeeWalletSwap's external signature is unchanged).
///  3. Anyone can call claimFeeWalletRewards(token) — it always pays out to
///     whatever this contract's feeWallet is set to AT CLAIM TIME, never a
///     stale snapshot, so a single setFeeWallet() call repoints every
///     token's next claim at once. Unchanged from the original version.
///  4. Anyone can call startAirdropRound() once pendingAirdropTokens is
///     nonzero, and processAirdropBatch(maxHolders) to walk PlatformToken's
///     holder registry in bounded batches, paying each holder their
///     proportional share of the frozen round amount — identical mechanics
///     to PlatformRewardsDistributor's own airdrop rounds.
contract FeeWalletDistributor is Ownable2Step, ReentrancyGuard {
    IUniswapV2Router02 public immutable router;

    /// @notice The single recipient every token's fee-wallet slice
    /// ultimately pays out to. Owner-settable (see setFeeWallet) — read
    /// live at claim time, never snapshotted per token. address(0) simply
    /// leaves claimFeeWalletRewards permanently reverting until set; it
    /// never blocks triggerFeeWalletSwap, since accumulating and swapping
    /// don't depend on who the eventual recipient is.
    address public feeWallet;

    /// @notice The token every buyback leg converts into, and every airdrop
    /// pays out in. address(0) (the default) means "not configured yet" —
    /// see the contract-level comment above for how triggerFeeWalletSwap
    /// behaves in that state (100% ETH leg, no buyback, unchanged from the
    /// original version of this contract). ETH and tokens continue to
    /// accumulate normally in the meantime. See setPlatformToken.
    IPlatformToken public platformToken;

    /// @notice ETH owed to feeWallet, accrued from a given token's swapped
    /// balance. Credited by triggerFeeWalletSwap's ETH leg and zeroed by
    /// claimFeeWalletRewards. Keyed by TOKEN — see the contract-level
    /// comment for why — not by feeWallet itself (there's only ever one).
    mapping(address => uint256) public claimableEth;

    /// @notice Minimum balance of `token` this contract must be holding
    /// before triggerFeeWalletSwap(token) will execute — identical
    /// anti-dust/anti-griefing knob as
    /// CreatorRewardsDistributor.swapThreshold, for the same reason a single
    /// global threshold wouldn't make sense (every token has its own
    /// supply/decimals scale). Defaults to 0 (any nonzero balance triggers)
    /// until the owner sets one for a given token. Applies to the total
    /// amount pulled, before the 50/50 ETH-leg/buyback-leg split.
    mapping(address => uint256) public swapThreshold;

    /// @notice Caps how much of `token`'s balance a single
    /// triggerFeeWalletSwap(token) call is allowed to pull — identical
    /// anti-dump knob as CreatorRewardsDistributor.maxSwapAmount, and for
    /// the same reason: without it, an infrequently-triggered token could
    /// accumulate a large balance and have its entire pile sold in one call,
    /// showing up as a single visible dump against that token's own pool.
    /// Defaults to 0, meaning "uncapped", until the owner sets one — once
    /// set, a balance above the cap drains across multiple separate calls
    /// instead of one. Applies to the total amount pulled, before the 50/50
    /// ETH-leg/buyback-leg split — each leg trades half of whatever this cap
    /// allows through in a given call.
    mapping(address => uint256) public maxSwapAmount;

    /// @notice Protective slippage floor applied to every swap this contract
    /// executes — both triggerFeeWalletSwap's ETH leg (see the accompanying
    /// audit report's Finding FW-1) and its platformToken buyback leg.
    /// Before FW-1 was fixed, triggerFeeWalletSwap accepted a purely
    /// caller-supplied minEthOut with no protocol-side floor computed from
    /// the pool's own reserves; since the function is deliberately
    /// permissionless (see its own comment), anyone could call it with
    /// minEthOut == 0 and sandwich their own call for MEV profit, reducing
    /// what the platform's own fee wallet ultimately collects. Identical
    /// fix, same fixed 5.00%-8.00% band, as the one already applied to
    /// CreatorRewardsDistributor.triggerCreatorSwap and
    /// PlatformRewardsDistributor's own buyback triggers — reused here
    /// unchanged for the new buyback leg rather than introducing a second,
    /// separately-tunable knob for the same purpose.
    uint256 public swapSlippageBps = 600; // 6.00% default
    uint256 public constant MIN_SWAP_SLIPPAGE_BPS = 500; // 5.00%
    uint256 public constant MAX_SWAP_SLIPPAGE_BPS = 800; // 8.00%

    /// @notice PlatformToken sitting here, already bought back by the
    /// buyback leg and already split, awaiting its turn in the next airdrop
    /// round. Frozen into roundAmount the moment startAirdropRound() runs.
    /// Identical role to PlatformRewardsDistributor.pendingAirdropTokens.
    uint256 public pendingAirdropTokens;

    bool public roundActive;
    uint256 public roundAmount; // total PlatformToken being paid out this round, frozen at round start
    uint256 public roundSupplySnapshot; // denominator: eligible supply frozen at round start (see startAirdropRound)
    uint256 public roundCursor; // next holder-registry index processAirdropBatch will start from

    event FeeWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event PlatformTokenSet(address indexed newToken);
    event SwapThresholdUpdated(address indexed token, uint256 newThreshold);
    event MaxSwapAmountUpdated(address indexed token, uint256 newMax);
    event SwapSlippageBpsUpdated(uint256 newBps);
    event FeeWalletSwapTriggered(address indexed token, uint256 amountIn, uint256 ethOut);
    event FeeWalletRewardsClaimed(address indexed token, address indexed feeWallet, address indexed caller, uint256 amount);
    event PlatformTokenBuybackTriggered(address indexed token, uint256 amountIn, uint256 tokensOut, uint256 burned, uint256 toAirdrop);
    event DirectPlatformTokensProcessed(address indexed token, uint256 amountIn, uint256 burned, uint256 toAirdrop);
    event AirdropRoundStarted(uint256 amount, uint256 supplySnapshot, uint256 holderCountAtStart);
    event AirdropBatchProcessed(uint256 fromIndex, uint256 toIndex, uint256 amountDistributed);
    event AirdropPayoutSkipped(address indexed holder, uint256 amount);
    event AirdropRoundCompleted(uint256 totalDistributed);

    constructor(address router_, address initialOwner_, address feeWallet_) Ownable(initialOwner_) {
        require(router_ != address(0), "FeeWalletDistributor: invalid router");
        router = IUniswapV2Router02(router_);
        feeWallet = feeWallet_;
        emit FeeWalletUpdated(address(0), feeWallet_);
    }

    /// @notice Lets this contract receive ETH — its only intended inflow is
    /// the swap output inside triggerFeeWalletSwap's ETH leg below, but this
    /// also covers any stray dust sent directly.
    receive() external payable {}

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    /// @notice Repoints where every token's next claimFeeWalletRewards call
    /// sends its ETH. Takes effect on the next claim for every token at
    /// once — never retroactive to ETH already paid out, and never touches
    /// claimableEth balances themselves.
    function setFeeWallet(address newWallet) external onlyOwner {
        emit FeeWalletUpdated(feeWallet, newWallet);
        feeWallet = newWallet;
    }

    /// @notice Wires up the token the buyback leg converts into and every
    /// airdrop pays out in. Deliberately blocked while a round is active or
    /// while platformToken is already sitting in pendingAirdropTokens —
    /// changing the token out from under either would orphan that balance
    /// in a token nobody can query it under anymore. Same guard as
    /// PlatformRewardsDistributor.setPlatformToken, for the identical
    /// reason. Before this is called, triggerFeeWalletSwap runs exactly as
    /// it always did (100% ETH leg) — see the contract-level comment.
    function setPlatformToken(address newToken) external onlyOwner {
        require(!roundActive, "FeeWalletDistributor: round in progress");
        require(pendingAirdropTokens == 0, "FeeWalletDistributor: pending airdrop must clear first");
        platformToken = IPlatformToken(newToken);
        emit PlatformTokenSet(newToken);
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

    /// @notice Adjusts the protective slippage floor applied to every swap
    /// this contract executes — see swapSlippageBps above and Finding FW-1.
    /// Bounded to the same 5.00%-8.00% band used everywhere else in this
    /// codebase for the identical purpose.
    function setSwapSlippageBps(uint256 newBps) external onlyOwner {
        require(newBps >= MIN_SWAP_SLIPPAGE_BPS, "FeeWalletDistributor: slippage below 5% floor");
        require(newBps <= MAX_SWAP_SLIPPAGE_BPS, "FeeWalletDistributor: slippage above 8% ceiling");
        swapSlippageBps = newBps;
        emit SwapSlippageBpsUpdated(newBps);
    }

    // ---------------------------------------------------------------
    // Quoting helpers
    // ---------------------------------------------------------------

    /// @dev Standard Uniswap V2 constant-product quote (0.30% swap fee baked
    /// into the 997/1000 constants) — used only to derive a protective
    /// slippage floor below, never to execute anything. Same helper as
    /// CreatorRewardsDistributor/PlatformRewardsDistributor/CustomToken/
    /// CustomTokenFactory's identical utility.
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        return numerator / denominator;
    }

    /// @dev Quotes amountIn's expected ETH output off the token/WETH pool's
    /// own live reserves and applies swapSlippageBps — see Finding FW-1.
    /// Returns 0 if no pool is found or either reserve is empty, which the
    /// ETH leg treats as "can't compute a protocol floor this time," falling
    /// back to the caller's own minEthOut rather than blocking the swap
    /// outright. Single-hop, used only for the ETH leg (token -> WETH).
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

    /// @dev Quotes amountIn's expected output at the END of a multi-hop path
    /// off each hop's own live pool reserves, chaining the output of one hop
    /// into the input of the next, then applies swapSlippageBps to the final
    /// figure — see Finding PR-2 in the PlatformRewardsDistributor audit,
    /// whose identical helper this is ported from. Used only for the
    /// buyback leg's [token, WETH, platformToken] path. Returns 0 if any hop's
    /// pool doesn't exist or has an empty reserve, which the buyback leg
    /// treats as "can't compute a protocol floor this time" — see
    /// _executePlatformTokenBuyback below for how that's handled.
    function _protectiveMinOut(address[] memory path, uint256 amountIn) private view returns (uint256) {
        address factory = router.factory();
        uint256 amount = amountIn;
        for (uint256 i = 0; i + 1 < path.length; i++) {
            address pairAddr = IUniswapV2FactoryMinimal(factory).getPair(path[i], path[i + 1]);
            if (pairAddr == address(0)) return 0;

            (uint112 reserve0, uint112 reserve1, ) = IUniswapV2PairMinimal(pairAddr).getReserves();
            address token0 = IUniswapV2PairMinimal(pairAddr).token0();
            uint256 reserveIn = token0 == path[i] ? uint256(reserve0) : uint256(reserve1);
            uint256 reserveOut = token0 == path[i] ? uint256(reserve1) : uint256(reserve0);
            if (reserveIn == 0 || reserveOut == 0) return 0;

            amount = _getAmountOut(amount, reserveIn, reserveOut);
        }
        return amount - (amount * swapSlippageBps) / 10_000;
    }

    // ---------------------------------------------------------------
    // Main trigger — splits 50/50 between the ETH leg and the buyback leg
    // ---------------------------------------------------------------

    /// @notice Pulls up to maxSwapAmount[token] of this contract's balance
    /// of `token` (the entire balance, if no cap is set), and:
    ///   - if platformToken is NOT configured, swaps 100% of it for ETH,
    ///     credited to claimableEth[token] — byte-for-byte the original
    ///     behavior of this contract.
    ///   - if platformToken IS configured, splits it 50/50: half runs
    ///     through the same ETH-leg logic as above; half runs through the
    ///     new buyback leg (see _executePlatformTokenBuyback).
    /// Permissionless, like every trigger in
    /// CreatorRewardsDistributor/PlatformRewardsDistributor — the
    /// destination of the ETH leg (this contract's own feeWallet, read at
    /// claim time) never depends on who calls it, and neither does the
    /// buyback leg's fixed 50/50 burn/airdrop split.
    /// @param minEthOut Caller-supplied minimum-out floor for the ETH leg
    /// (unchanged meaning from the original contract) — combined with the
    /// protocol's own protective floor computed against the ETH leg's
    /// actual (possibly halved) size. The buyback leg gets no caller-
    /// supplied floor from this overload (it relies solely on the
    /// protocol's own protective floor) — this overload's signature is
    /// kept byte-for-byte unchanged from the original contract for
    /// backward compatibility with existing callers (see
    /// scripts/relayer.js's feeWalletPollLoop). Callers that also want to
    /// supply a floor for the buyback leg should use the 3-argument
    /// overload below instead — see Finding FWD-1.
    function triggerFeeWalletSwap(address token, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        return _triggerFeeWalletSwap(token, minEthOut, 0);
    }

    /// @notice Same as triggerFeeWalletSwap(token, minEthOut) above, but
    /// additionally lets the caller supply `minPlatformTokensOut` — a
    /// caller-side minimum-out floor for the buyback leg specifically,
    /// combined with the protocol's own protective floor the same
    /// "whichever is stricter" way minEthOut already is for the ETH leg,
    /// and the same way PlatformRewardsDistributor.triggerTokenBuyback's
    /// own minTokensOut already works. Added to fix Finding FWD-1: before
    /// this overload existed, the buyback leg had no way for a caller
    /// (e.g. an off-chain keeper quoting this leg's expected output in
    /// real time, the same way scripts/relayer.js already does for the
    /// ETH leg) to add protection beyond the protocol default — a real,
    /// if narrower, gap next to the ETH leg's existing caller-supplied
    /// floor. Existing callers that only know about the 2-argument
    /// overload are entirely unaffected — that overload now simply calls
    /// this one with minPlatformTokensOut = 0.
    function triggerFeeWalletSwap(address token, uint256 minEthOut, uint256 minPlatformTokensOut)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        return _triggerFeeWalletSwap(token, minEthOut, minPlatformTokensOut);
    }

    /// @dev Shared implementation for both triggerFeeWalletSwap overloads.
    /// Not itself nonReentrant (both external overloads already are) —
    /// applying the modifier here too would make one overload's call into
    /// this function revert as a false-positive reentrant call.
    function _triggerFeeWalletSwap(address token, uint256 minEthOut, uint256 minPlatformTokensOut)
        private
        returns (uint256 ethOut)
    {
        require(token != address(0), "FeeWalletDistributor: invalid token");
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0 && balance >= swapThreshold[token], "FeeWalletDistributor: below threshold");
        uint256 cap = maxSwapAmount[token];
        uint256 amountIn = (cap > 0 && balance > cap) ? cap : balance;

        uint256 buybackAmount = address(platformToken) != address(0) ? amountIn / 2 : 0;
        uint256 ethLegAmount = amountIn - buybackAmount;

        if (ethLegAmount > 0) {
            ethOut = _executeFeeWalletLeg(token, ethLegAmount, minEthOut);
        }
        if (buybackAmount > 0) {
            _executePlatformTokenBuyback(token, buybackAmount, minPlatformTokensOut);
        }
    }

    /// @dev The ETH leg: swaps `amountIn` of `token` for ETH via the router
    /// (fee-on-transfer-tolerant) and credits the proceeds to
    /// claimableEth[token]. Identical mechanics to the original contract's
    /// triggerFeeWalletSwap body, factored out so triggerFeeWalletSwap can
    /// call it on either the full balance (platformToken unset) or half of
    /// it (platformToken set). Adds the approve-to-zero-then-approve pattern
    /// (mirroring Finding PR-3's fix in PlatformRewardsDistributor) that the
    /// original version of this leg didn't have, for the same non-standard-
    /// ERC20-allowance safety.
    function _executeFeeWalletLeg(address token, uint256 amountIn, uint256 minEthOut) private returns (uint256 ethOut) {
        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = router.WETH();

        // Finding FW-1: minEthOut alone was a purely caller-supplied value
        // with no protocol-side floor — since this function is deliberately
        // permissionless, that let anyone call it with minEthOut == 0 and
        // sandwich their own call for MEV profit. effectiveMinOut is
        // whichever is stricter of the caller's own minEthOut and a floor
        // computed from the pool's own live reserves, against this leg's
        // actual amountIn.
        uint256 protectiveFloor = _protectiveMinOut(token, amountIn);
        uint256 effectiveMinOut = minEthOut > protectiveFloor ? minEthOut : protectiveFloor;

        uint256 before = address(this).balance;
        IERC20(token).approve(address(router), 0);
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

    /// @dev The buyback leg: swaps `amountIn` of `token` for platformToken
    /// (routed through WETH) and splits the proceeds 50% burned / 50% into
    /// pendingAirdropTokens via _splitAndProcess — ported directly from
    /// PlatformRewardsDistributor.triggerTokenBuyback, including its direct-
    /// token shortcut (if `token` already IS platformToken, no swap is
    /// needed) and its Finding PR-2/PR-3 fixes.
    /// @param minPlatformTokensOut Caller-supplied minimum-out floor for
    /// this leg (see Finding FWD-1) — combined with the protocol's own
    /// protective floor the same "whichever is stricter" way minEthOut
    /// already is for the ETH leg. Callers that only use the 2-argument
    /// triggerFeeWalletSwap overload pass 0 here, so this degrades to
    /// relying solely on the protocol's own protective floor for them,
    /// exactly as before FWD-1 was fixed. That protocol floor itself still
    /// degrades to 0 (no floor at all) if the [token, WETH, platformToken]
    /// path's pools can't be quoted, consistent with how every other
    /// quote-derived floor in this codebase degrades on a missing pool —
    /// callers who want a hard guarantee in that situation should supply
    /// their own minPlatformTokensOut via the 3-argument overload.
    function _executePlatformTokenBuyback(address token, uint256 amountIn, uint256 minPlatformTokensOut) private {
        if (token == address(platformToken)) {
            (uint256 burnedDirect, uint256 toAirdropDirect) = _splitAndProcess(amountIn);
            emit DirectPlatformTokensProcessed(token, amountIn, burnedDirect, toAirdropDirect);
            return;
        }

        address[] memory path = new address[](3);
        path[0] = token;
        path[1] = router.WETH();
        path[2] = address(platformToken);

        // Finding FWD-1 (fixed): effectiveMinOut is whichever is stricter of
        // the caller's own minPlatformTokensOut and the protocol's own
        // reserve-derived floor — same combination already used for the ETH
        // leg's minEthOut and for every buyback trigger in
        // PlatformRewardsDistributor.
        uint256 protectiveFloor = _protectiveMinOut(path, amountIn);
        uint256 effectiveMinOut = minPlatformTokensOut > protectiveFloor ? minPlatformTokensOut : protectiveFloor;

        // Finding PR-3 (ported): approving `amountIn` directly on top of any
        // existing allowance breaks against ERC20s (e.g. USDT and tokens
        // that copy its guard) that revert on changing a nonzero allowance
        // straight to another nonzero value. Resetting to zero first makes
        // this safe regardless of whatever allowance, if any, is already
        // outstanding.
        IERC20(token).approve(address(router), 0);
        IERC20(token).approve(address(router), amountIn);
        uint256 before = platformToken.balanceOf(address(this));
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amountIn,
            effectiveMinOut,
            path,
            address(this),
            block.timestamp + 15 minutes
        );
        uint256 tokensOut = platformToken.balanceOf(address(this)) - before;

        (uint256 burned, uint256 toAirdrop) = _splitAndProcess(tokensOut);
        emit PlatformTokenBuybackTriggered(token, amountIn, tokensOut, burned, toAirdrop);
    }

    /// @dev Fixed 50/50 split, shared by every path that produces fresh
    /// platformToken here (the buyback leg, plus its direct-token
    /// shortcut). Burns immediately; the airdrop half just accumulates
    /// until startAirdropRound() is next called. Identical to
    /// PlatformRewardsDistributor._splitAndProcess.
    function _splitAndProcess(uint256 amount) private returns (uint256 burned, uint256 toAirdrop) {
        if (amount == 0) return (0, 0);
        burned = amount / 2;
        toAirdrop = amount - burned;
        if (burned > 0) platformToken.burn(burned);
        pendingAirdropTokens += toAirdrop;
    }

    /// @notice Pays out claimableEth[token] to feeWallet, read live at call
    /// time (see setFeeWallet) — never a stale snapshot. Callable by
    /// anyone — same permissionless-but-fixed-destination pattern as
    /// triggerFeeWalletSwap above. Checks-effects-interactions (balance
    /// zeroed before the external call) plus nonReentrant besides.
    /// Unchanged from the original version of this contract.
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

    // ---------------------------------------------------------------
    // Airdrop rounds — accumulate-and-batch-trigger, ported directly from
    // PlatformRewardsDistributor's identical mechanism
    // ---------------------------------------------------------------

    /// @notice Freezes whatever's accumulated in pendingAirdropTokens into
    /// a new round: the amount being paid out, and the eligible supply
    /// (PlatformToken's total supply minus whatever this contract itself
    /// is currently holding, since this contract is never a payee of its
    /// own airdrop) it's divided by. Permissionless, like the triggers
    /// above — anyone can kick a round off once there's something to
    /// distribute. Identical to PlatformRewardsDistributor.startAirdropRound.
    function startAirdropRound() external nonReentrant {
        require(!roundActive, "FeeWalletDistributor: round already active");
        require(address(platformToken) != address(0), "FeeWalletDistributor: platform token not set");
        require(pendingAirdropTokens > 0, "FeeWalletDistributor: nothing to distribute");

        uint256 ownBalance = platformToken.balanceOf(address(this));
        uint256 supply = platformToken.totalSupply();
        uint256 supplySnapshot = supply > ownBalance ? supply - ownBalance : 0;
        require(supplySnapshot > 0, "FeeWalletDistributor: no eligible holders");

        roundAmount = pendingAirdropTokens;
        pendingAirdropTokens = 0;
        roundSupplySnapshot = supplySnapshot;
        roundCursor = 0;
        roundActive = true;

        emit AirdropRoundStarted(roundAmount, roundSupplySnapshot, platformToken.holderCount());
    }

    /// @dev Wraps the actual token transfer in try/catch so a single
    /// reverting recipient (a blocklist, a max-wallet cap on PlatformToken,
    /// or any other transfer-blocking condition) can never take down the
    /// whole batch — mirrors Finding PR-1's fix in PlatformRewardsDistributor.
    /// `platformToken.transfer(...)` is already an external call
    /// (platformToken is a separately-deployed contract), so it can be
    /// try/catched directly with no extra self-call needed.
    function _sendPlatformToken(address to, uint256 amount) private returns (bool) {
        try platformToken.transfer(to, amount) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    /// @notice Pushes up to `maxHolders` holders' proportional share of the
    /// active round, resuming from wherever the last call left off, and
    /// closes the round out once every holder's been reached. Anyone can
    /// call this (e.g. a keeper looping until the round completes) — it's
    /// the only way round funds ever actually move. Identical mechanics,
    /// including the same disclosed live-balance and shrinking-registry
    /// approximations, as PlatformRewardsDistributor.processAirdropBatch —
    /// see that contract's own comment for the full rationale.
    function processAirdropBatch(uint256 maxHolders) external nonReentrant {
        require(roundActive, "FeeWalletDistributor: no active round");
        require(maxHolders > 0, "FeeWalletDistributor: maxHolders must be > 0");

        uint256 total = platformToken.holderCount();
        uint256 from = roundCursor;
        uint256 to = from + maxHolders;
        if (to > total) to = total;

        uint256 distributed;
        for (uint256 i = from; i < to; i++) {
            address holder = platformToken.holderAt(i);
            if (holder == address(this)) continue;
            uint256 share = (roundAmount * platformToken.balanceOf(holder)) / roundSupplySnapshot;
            if (share == 0) continue;
            if (_sendPlatformToken(holder, share)) {
                distributed += share;
            } else {
                // Mirrors Finding PR-1's fix: don't lose the share — requeue
                // it for the next round instead of leaving it stranded,
                // unaccounted, in this contract's own balance forever.
                pendingAirdropTokens += share;
                emit AirdropPayoutSkipped(holder, share);
            }
        }

        roundCursor = to;
        emit AirdropBatchProcessed(from, to, distributed);

        if (roundCursor >= total) {
            roundActive = false;
            emit AirdropRoundCompleted(roundAmount);
        }
    }
}
