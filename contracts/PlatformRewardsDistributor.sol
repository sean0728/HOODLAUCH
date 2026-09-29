// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./interfaces/IPlatformToken.sol";

/// @title PlatformRewardsDistributor
/// @notice Where every "kickback to holders" fee stream on Hood Launch
/// ends up, and the one place that turns it into buyback + burn + holder
/// airdrops of PlatformToken. Two completely separate flows feed it:
///
///  1. Launch-fee revenue: TokenFactory/CustomTokenFactory each send this
///     contract 50% of every deployFee/launchFee collected, in native ETH,
///     the moment a launch finalizes — see
///     TokenFactory._finalizeLaunch / CustomTokenFactory.createCustomToken.
///     The other 50% keeps going to feeTreasury exactly as before.
///  2. Ongoing trading tax: LaunchedToken/CustomToken each carve
///     rewardBps (out of their total feeBps/platformFeeBps platform tax)
///     off of every taxed buy/sell and send it here in-kind — i.e. in
///     whatever token that trade was actually taxed in, not ETH. See
///     LaunchedToken._update / CustomToken._update.
///
/// Both flows are inert until platformToken is configured (see
/// setPlatformToken) — before that, ETH and tokens simply accumulate on
/// this contract's own balance, exactly as documented on every factory's
/// rewardsDistributor field: "prior to that it will be the original
/// system." Nothing about enabling this feature later requires touching
/// any already-launched token or factory again.
///
/// Buyback execution is accumulate-and-batch-trigger, not live-per-trade —
/// the same pattern CustomToken already uses for its own liquidity/
/// marketing/reflection fees (see CustomToken._maybeSwapAndProcess). Both
/// trigger functions are permissionless: anyone (typically an off-chain
/// keeper) can fire one once its threshold is met, but nothing about who
/// calls it changes where the funds go — the split is always the same
/// fixed 50% burn / 50% holder-airdrop-pool.
///
/// Holder payouts are pushed, not claimed: PlatformToken tracks its own
/// live holder set on-chain (see PlatformToken.holderCount/holderAt), and
/// startAirdropRound()/processAirdropBatch() walk it in gas-bounded
/// batches so it stays permissionless and affordable no matter how many
/// holders PlatformToken eventually has.
///
/// --- Security review (this file) ---
/// Two findings from the accompanying audit report are fixed directly in
/// this version — see the inline comments at each site for the mechanics:
///  - Finding PR-1 (Critical): processAirdropBatch could be permanently
///    bricked by a single reverting holder payout.
///  - Finding PR-2 (High): triggerEthBuyback/triggerTokenBuyback had no
///    protocol-side slippage floor, making every permissionless call
///    sandwich-able for MEV profit at the community's expense.
///  - Finding PR-3 (Medium): triggerTokenBuyback's approve() call could
///    permanently revert against non-standard ERC20s (USDT-style) that
///    reject changing a nonzero allowance directly to another nonzero
///    value.
/// A fourth, lower-severity finding (PR-4 — no rescue path for a token
/// balance that never clears) is discussed in the report but deliberately
/// NOT fixed here — see that finding for why an unrestricted rescue
/// function would trade a minor availability gap for a worse
/// centralization risk.
contract PlatformRewardsDistributor is Ownable2Step, ReentrancyGuard {
    IUniswapV2Router02 public immutable router;

    /// @notice The token every buyback converts into, and every airdrop
    /// pays out in. address(0) (the default) means "not configured yet" —
    /// every trigger/round function below refuses to run until this is
    /// set, but ETH and tokens can still accumulate here harmlessly in the
    /// meantime. See setPlatformToken.
    IPlatformToken public platformToken;

    /// @notice Minimum ETH balance this contract must be holding before
    /// triggerEthBuyback will execute. Purely an anti-dust/anti-griefing
    /// knob (a buyback below this just isn't worth the gas) — owner-tunable,
    /// defaults to 0 (any nonzero balance triggers) until set otherwise.
    uint256 public ethBuybackThreshold;

    /// @notice Same idea as ethBuybackThreshold, but per input token, for
    /// triggerTokenBuyback. Defaults to 0 for every token until the owner
    /// sets one.
    mapping(address => uint256) public tokenBuybackThreshold;

    /// @notice Caps how much of this contract's ETH balance a single
    /// triggerEthBuyback call is allowed to spend — same anti-dump purpose
    /// as CreatorRewardsDistributor.maxSwapAmount, applied to the buy side
    /// here (a large single buy is a visible pump on platformToken's own
    /// chart, the mirror image of a large single sell dumping a launched
    /// token's chart). Defaults to 0, meaning "uncapped" (the original
    /// spend-it-all behavior). Once set, a balance above the cap is spent
    /// down across multiple separate calls instead of one.
    uint256 public maxEthBuybackAmount;

    /// @notice Same as maxEthBuybackAmount, but per input token, for
    /// triggerTokenBuyback — the sell-side counterpart (selling `token` for
    /// platformToken is a sell against `token`'s own pool, same dump risk
    /// CreatorRewardsDistributor.maxSwapAmount exists to bound). Defaults to
    /// 0 (uncapped) per token until the owner sets one.
    mapping(address => uint256) public maxTokenBuybackAmount;

    /// @notice Protective slippage floor applied to every buyback swap in
    /// this contract — see Finding PR-2 in the accompanying audit report.
    /// Before this existed, triggerEthBuyback/triggerTokenBuyback accepted
    /// a purely caller-supplied minTokensOut with no protocol-side floor
    /// computed from the pool(s)' own reserves; since both functions are
    /// deliberately permissionless, that let anyone call them with
    /// minTokensOut == 0 and sandwich their own call for MEV profit at the
    /// expense of the burn/airdrop pool. Same fixed 5.00%-8.00% band, and
    /// the same "whichever is stricter" combination with the caller's own
    /// minTokensOut, already used for CreatorRewardsDistributor's and
    /// FeeWalletDistributor's own swap triggers.
    uint256 public swapSlippageBps = 600; // 6.00% default
    uint256 public constant MIN_SWAP_SLIPPAGE_BPS = 500; // 5.00%
    uint256 public constant MAX_SWAP_SLIPPAGE_BPS = 800; // 8.00%

    /// @notice PlatformToken sitting here, already bought back and already
    /// split, awaiting its turn in the next airdrop round. Frozen into
    /// roundAmount the moment startAirdropRound() runs.
    uint256 public pendingAirdropTokens;

    bool public roundActive;
    uint256 public roundAmount; // total PlatformToken being paid out this round, frozen at round start
    uint256 public roundSupplySnapshot; // denominator: eligible supply frozen at round start (see startAirdropRound)
    uint256 public roundCursor; // next holder-registry index processAirdropBatch will start from

    event PlatformTokenSet(address indexed newToken);
    event EthBuybackThresholdUpdated(uint256 newThreshold);
    event TokenBuybackThresholdUpdated(address indexed token, uint256 newThreshold);
    event MaxEthBuybackAmountUpdated(uint256 newMax);
    event MaxTokenBuybackAmountUpdated(address indexed token, uint256 newMax);
    event SwapSlippageBpsUpdated(uint256 newBps);
    event EthBuybackTriggered(uint256 ethIn, uint256 tokensOut, uint256 burned, uint256 toAirdrop);
    event TokenBuybackTriggered(address indexed token, uint256 amountIn, uint256 tokensOut, uint256 burned, uint256 toAirdrop);
    event DirectPlatformTokensProcessed(uint256 amountIn, uint256 burned, uint256 toAirdrop);
    event AirdropRoundStarted(uint256 amount, uint256 supplySnapshot, uint256 holderCountAtStart);
    event AirdropBatchProcessed(uint256 fromIndex, uint256 toIndex, uint256 amountDistributed);
    event AirdropPayoutSkipped(address indexed holder, uint256 amount);
    event AirdropRoundCompleted(uint256 totalDistributed);

    constructor(address router_, address initialOwner_) Ownable(initialOwner_) {
        require(router_ != address(0), "PlatformRewardsDistributor: invalid router");
        router = IUniswapV2Router02(router_);
    }

    /// @notice Where TokenFactory/CustomTokenFactory send their 50% launch-
    /// fee share, and the only way ETH ever lands here.
    receive() external payable {}

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    /// @notice Wires up the token every buyback/burn/airdrop from here on
    /// operates on. Deliberately blocked while a round is active or while
    /// PlatformToken is already sitting in pendingAirdropTokens — changing
    /// the token out from under either would orphan that balance in a
    /// token nobody can query it under anymore. Safe to call exactly once,
    /// right when PlatformToken itself launches, per the owner's own plan
    /// ("i would launch the token in conjunction with the launch of the
    /// platform... prior to that it will be the original system").
    function setPlatformToken(address newToken) external onlyOwner {
        require(!roundActive, "PlatformRewardsDistributor: round in progress");
        require(pendingAirdropTokens == 0, "PlatformRewardsDistributor: pending airdrop must clear first");
        platformToken = IPlatformToken(newToken);
        emit PlatformTokenSet(newToken);
    }

    function setEthBuybackThreshold(uint256 newThreshold) external onlyOwner {
        ethBuybackThreshold = newThreshold;
        emit EthBuybackThresholdUpdated(newThreshold);
    }

    function setTokenBuybackThreshold(address token, uint256 newThreshold) external onlyOwner {
        tokenBuybackThreshold[token] = newThreshold;
        emit TokenBuybackThresholdUpdated(token, newThreshold);
    }

    /// @notice See maxEthBuybackAmount's own comment above. 0 means uncapped.
    function setMaxEthBuybackAmount(uint256 newMax) external onlyOwner {
        maxEthBuybackAmount = newMax;
        emit MaxEthBuybackAmountUpdated(newMax);
    }

    /// @notice See maxTokenBuybackAmount's own comment above. 0 means uncapped.
    function setMaxTokenBuybackAmount(address token, uint256 newMax) external onlyOwner {
        maxTokenBuybackAmount[token] = newMax;
        emit MaxTokenBuybackAmountUpdated(token, newMax);
    }

    /// @notice Adjusts the protective slippage floor applied to every
    /// buyback trade — see swapSlippageBps above and Finding PR-2. Bounded
    /// to the same 5.00%-8.00% band used everywhere else in this codebase
    /// for the identical purpose.
    function setSwapSlippageBps(uint256 newBps) external onlyOwner {
        require(newBps >= MIN_SWAP_SLIPPAGE_BPS, "PlatformRewardsDistributor: slippage below 5% floor");
        require(newBps <= MAX_SWAP_SLIPPAGE_BPS, "PlatformRewardsDistributor: slippage above 8% ceiling");
        swapSlippageBps = newBps;
        emit SwapSlippageBpsUpdated(newBps);
    }

    // ---------------------------------------------------------------
    // Buyback triggers — permissionless once the relevant threshold is met
    // ---------------------------------------------------------------

    /// @dev Standard Uniswap V2 constant-product quote (0.30% swap fee baked
    /// into the 997/1000 constants) — used only to derive a protective
    /// slippage floor below, never to execute anything. Same helper as
    /// CreatorRewardsDistributor/FeeWalletDistributor/CustomToken/
    /// CustomTokenFactory's identical utility.
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        return numerator / denominator;
    }

    /// @dev Quotes amountIn's expected output at the END of a (possibly
    /// multi-hop) path off each hop's own live pool reserves, chaining the
    /// output of one hop into the input of the next, then applies
    /// swapSlippageBps to the final figure — see Finding PR-2. Generalizes
    /// CreatorRewardsDistributor's/FeeWalletDistributor's single-hop
    /// _protectiveMinOut to the two-hop [token, WETH, platformToken] path
    /// triggerTokenBuyback needs (triggerEthBuyback's own
    /// [WETH, platformToken] path is just the one-hop case of the same
    /// loop). Returns 0 if any hop's pool doesn't exist or has an empty
    /// reserve, which callers treat as "can't compute a protocol floor this
    /// time," falling back to the caller's own minTokensOut rather than
    /// blocking the swap outright — consistent with how every other
    /// quote-derived floor in this codebase degrades on a missing pool.
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

    /// @notice Swaps up to maxEthBuybackAmount of this contract's ETH
    /// balance for platformToken (the entire balance, if no cap is set) and
    /// splits the result 50% burned / 50% into the airdrop pool. Anyone can
    /// call this (e.g. a scheduled keeper) — the destination of the funds
    /// never depends on who calls it.
    function triggerEthBuyback(uint256 minTokensOut) external nonReentrant returns (uint256 tokensOut) {
        require(address(platformToken) != address(0), "PlatformRewardsDistributor: platform token not set");
        uint256 balance = address(this).balance;
        require(balance > 0 && balance >= ethBuybackThreshold, "PlatformRewardsDistributor: below threshold");
        uint256 cap = maxEthBuybackAmount;
        uint256 ethIn = (cap > 0 && balance > cap) ? cap : balance;

        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = address(platformToken);

        // Finding PR-2: minTokensOut alone was a purely caller-supplied
        // value with no protocol-side floor — since this function is
        // deliberately permissionless, that let anyone call it with
        // minTokensOut == 0 and sandwich their own call for MEV profit at
        // the burn/airdrop pool's expense. effectiveMinOut is whichever is
        // stricter of the caller's own minTokensOut and a floor computed
        // from the pool's own live reserves.
        uint256 protectiveFloor = _protectiveMinOut(path, ethIn);
        uint256 effectiveMinOut = minTokensOut > protectiveFloor ? minTokensOut : protectiveFloor;

        uint256 before = platformToken.balanceOf(address(this));
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: ethIn}(
            effectiveMinOut,
            path,
            address(this),
            block.timestamp + 15 minutes
        );
        tokensOut = platformToken.balanceOf(address(this)) - before;

        (uint256 burned, uint256 toAirdrop) = _splitAndProcess(tokensOut);
        emit EthBuybackTriggered(ethIn, tokensOut, burned, toAirdrop);
    }

    /// @notice Swaps up to maxTokenBuybackAmount[token] of this contract's
    /// balance of `token` for platformToken (the entire balance, if no cap
    /// is set — routed through WETH, see
    /// IUniswapV2Router02.swapExactTokensForTokensSupportingFeeOnTransferTokens)
    /// and splits the result 50/50, same as triggerEthBuyback. If `token`
    /// happens to already be platformToken itself, no swap is needed — it's
    /// processed directly, uncapped (a burn/airdrop-pool credit isn't a
    /// trade, so it carries none of the price-impact risk the cap exists
    /// for). Anyone can call this once the token's balance clears its
    /// configured threshold.
    function triggerTokenBuyback(address token, uint256 minTokensOut) external nonReentrant returns (uint256 tokensOut) {
        require(address(platformToken) != address(0), "PlatformRewardsDistributor: platform token not set");
        require(token != address(0), "PlatformRewardsDistributor: invalid token");

        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0 && balance >= tokenBuybackThreshold[token], "PlatformRewardsDistributor: below threshold");

        if (token == address(platformToken)) {
            (uint256 burnedDirect, uint256 toAirdropDirect) = _splitAndProcess(balance);
            emit DirectPlatformTokensProcessed(balance, burnedDirect, toAirdropDirect);
            return balance;
        }

        uint256 cap = maxTokenBuybackAmount[token];
        uint256 amountIn = (cap > 0 && balance > cap) ? cap : balance;

        address[] memory path = new address[](3);
        path[0] = token;
        path[1] = router.WETH();
        path[2] = address(platformToken);

        // Finding PR-2 (see triggerEthBuyback above for the full
        // rationale) — applied here via the same _protectiveMinOut helper,
        // generalized to walk both hops of this path.
        uint256 protectiveFloor = _protectiveMinOut(path, amountIn);
        uint256 effectiveMinOut = minTokensOut > protectiveFloor ? minTokensOut : protectiveFloor;

        // Finding PR-3: approving `amountIn` directly on top of any
        // existing allowance breaks against ERC20s (e.g. USDT and tokens
        // that copy its guard) that revert on changing a nonzero allowance
        // straight to another nonzero value. Resetting to zero first makes
        // this safe regardless of whatever allowance, if any, is already
        // outstanding — including the case where a prior call here left a
        // residual allowance because `token` took a transfer fee and the
        // router pulled less than the full approved amount.
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
        tokensOut = platformToken.balanceOf(address(this)) - before;

        (uint256 burned, uint256 toAirdrop) = _splitAndProcess(tokensOut);
        emit TokenBuybackTriggered(token, amountIn, tokensOut, burned, toAirdrop);
    }

    /// @dev Fixed 50/50 split, shared by every path that produces fresh
    /// platformToken here (both buyback triggers, plus the direct-token
    /// shortcut above). Burns immediately; the airdrop half just
    /// accumulates until startAirdropRound() is next called.
    function _splitAndProcess(uint256 amount) private returns (uint256 burned, uint256 toAirdrop) {
        if (amount == 0) return (0, 0);
        burned = amount / 2;
        toAirdrop = amount - burned;
        if (burned > 0) platformToken.burn(burned);
        pendingAirdropTokens += toAirdrop;
    }

    // ---------------------------------------------------------------
    // Airdrop rounds — accumulate-and-batch-trigger, mirroring
    // CustomToken's own swapThreshold/_maybeSwapAndProcess pattern
    // ---------------------------------------------------------------

    /// @notice Freezes whatever's accumulated in pendingAirdropTokens into
    /// a new round: the amount being paid out, and the eligible supply
    /// (PlatformToken's total supply minus whatever this contract itself
    /// is currently holding, since this contract is never a payee of its
    /// own airdrop) it's divided by. Permissionless, like the triggers
    /// above — anyone can kick a round off once there's something to
    /// distribute.
    function startAirdropRound() external nonReentrant {
        require(!roundActive, "PlatformRewardsDistributor: round already active");
        require(address(platformToken) != address(0), "PlatformRewardsDistributor: platform token not set");
        require(pendingAirdropTokens > 0, "PlatformRewardsDistributor: nothing to distribute");

        uint256 ownBalance = platformToken.balanceOf(address(this));
        uint256 supply = platformToken.totalSupply();
        uint256 supplySnapshot = supply > ownBalance ? supply - ownBalance : 0;
        require(supplySnapshot > 0, "PlatformRewardsDistributor: no eligible holders");

        roundAmount = pendingAirdropTokens;
        pendingAirdropTokens = 0;
        roundSupplySnapshot = supplySnapshot;
        roundCursor = 0;
        roundActive = true;

        emit AirdropRoundStarted(roundAmount, roundSupplySnapshot, platformToken.holderCount());
    }

    /// @dev Finding PR-1 fix: wraps the actual token transfer in try/catch
    /// so a single reverting recipient (a blocklist, a max-wallet cap on
    /// PlatformToken, or any other transfer-blocking condition) can never
    /// take down the whole batch. `platformToken.transfer(...)` is already
    /// an external call (platformToken is a separately-deployed contract),
    /// so it can be try/catched directly with no extra self-call needed.
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
    /// the only way round funds ever actually move.
    ///
    /// Finding PR-1 (fixed here): before this fix, a single holder whose
    /// transfer reverted — for example because PlatformToken itself
    /// enforces a blocklist, a max-wallet cap that this payout would cross,
    /// or any other transfer-blocking condition — would revert this whole
    /// call. Since `from` always starts at `roundCursor`, which only
    /// advances on a SUCCESSFUL call, every subsequent call would begin at
    /// that exact same holder and revert identically, permanently freezing
    /// the round (and, with it, roundAmount of PlatformToken, and every
    /// future round behind it, since startAirdropRound() refuses to run
    /// while roundActive is true). _sendPlatformToken now catches a failed
    /// transfer instead of letting it propagate: the batch keeps moving,
    /// the failed share is added back to pendingAirdropTokens so it isn't
    /// silently lost (it simply becomes eligible for the NEXT round,
    /// recomputed against balances at that time), and an
    /// AirdropPayoutSkipped event records exactly which holder and how
    /// much, for anyone auditing a round afterward.
    ///
    /// Two other, disclosed and deliberate approximations keep this
    /// affordable and gas-bounded rather than paying for a fully-frozen
    /// per-holder snapshot:
    ///  - Each holder's share is computed from their LIVE balance at the
    ///    moment they're processed, not a balance frozen at round start —
    ///    someone who buys or sells between startAirdropRound() and their
    ///    turn in the loop is paid on whatever they're holding right then.
    ///  - PlatformToken's holder registry can itself shrink mid-round (a
    ///    holder's balance hits zero elsewhere and they're removed via the
    ///    registry's swap-and-pop set), which can shift which address sits
    ///    at a given index for the remainder of the round. In the rare
    ///    case this causes an address to be skipped, their share simply
    ///    stays unpaid this round rather than the whole round reverting.
    function processAirdropBatch(uint256 maxHolders) external nonReentrant {
        require(roundActive, "PlatformRewardsDistributor: no active round");
        require(maxHolders > 0, "PlatformRewardsDistributor: maxHolders must be > 0");

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
                // Finding PR-1: don't lose the share — requeue it for the
                // next round instead of leaving it stranded, unaccounted,
                // in this contract's own balance forever.
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
