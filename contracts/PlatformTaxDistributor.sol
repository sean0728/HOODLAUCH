// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Minimal Uniswap V2-style router surface this contract needs —
/// declared locally rather than imported from HoodLaunch's own contracts,
/// since this contract is intentionally standalone (see the contract-level
/// comment below): it has no dependency on anything else in that codebase.
interface IRouterMinimal {
    function WETH() external pure returns (address);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;
}

/// @notice The minimal slice of the platform token this contract needs to
/// disburse proportionally to every holder — an enumerable ERC20
/// (holderCount/holderAt on top of the ordinary ERC20 surface). Declared
/// locally, not imported, for the same standalone reason as IRouterMinimal
/// above.
interface IPlatformTokenMinimal {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function holderCount() external view returns (uint256);
    function holderAt(uint256 index) external view returns (address);
}

/// @title PlatformTaxDistributor
/// @notice A fully standalone contract: it is NOT part of HoodLaunch's own
/// deployment, is never read or written by that platform's relayer or admin
/// panel, and is not controlled by that platform's own owner/admin wallet in
/// any way. It is deployed and owned independently by whoever deploys it —
/// see Ownable2Step below, where the deploying wallet becomes the initial
/// owner exactly like any other Ownable contract, with no special tie-in to
/// HoodLaunch's own access control.
///
/// HoodLaunch's own front end (public/index.html) only ever needs this
/// contract's ADDRESS: it sends this contract a flat 0.30% of every buy,
/// sell, curve buy, and curve sell it executes, as an ordinary extra ETH
/// transfer alongside the trade itself (see PLATFORM_TAX_DISTRIBUTOR in that
/// file). Nothing about what happens to that ETH once it arrives here is
/// visible to or controlled by HoodLaunch's own contracts, its relayer, or
/// its admin wallet — this contract's owner is the only one who can change
/// any setting below.
///
/// Automation: every ETH transfer this contract receives (see receive()
/// below) simply accumulates in its own balance — there is no per-sender
/// bookkeeping, since the tax has no notion of "whose" it is once paid. The
/// moment that balance reaches disburseThreshold, receive() itself
/// automatically triggers the split: half straight to feeWallet in plain
/// ETH, half swapped for platformToken (using a live on-chain quote — see
/// triggerDistributionAuto()) and queued for pro-rata disbursement to every
/// platform token holder, which then starts paying itself out too — see
/// autoProcessBatchSize below. No keeper, relayer, or manual call is needed
/// for any of this — it all happens as a side effect of ordinary trade-tax
/// transfers arriving. A smart contract can never run code on its own
/// timer, only when some transaction calls it, so this contract uses the
/// one thing that reliably calls it on an ongoing basis — HoodLaunch's own
/// traders paying their 0.30% tax — as its "heartbeat": each such transfer
/// also nudges an in-progress holder-payout round forward by a small,
/// bounded batch. The tradeoff is real and disclosed: whoever's transfer
/// happens to trigger a batch pays that batch's extra gas alongside their
/// own transaction. autoProcessBatchSize is kept small by default and can
/// be set to 0 to disable this piggybacking, falling back to
/// processDisburseRound() only ever being called manually or by an
/// external script the owner runs entirely outside this contract.
contract PlatformTaxDistributor is Ownable2Step, ReentrancyGuard {
    IRouterMinimal public immutable router;

    /// @notice The token bought back and disbursed to holders. Changeable
    /// by the owner (see setPlatformToken) as long as no disburse round is
    /// currently in progress and no bought-back tokens are still waiting
    /// to be disbursed under the OLD token — never lets a swap-out happen
    /// out from under an in-flight round or a pending balance.
    IPlatformTokenMinimal public platformToken;

    /// @notice Where half of every collected tax goes, in plain ETH.
    address public feeWallet;

    /// @notice ETH balance this contract must reach before it automatically
    /// (or manually, via triggerDistribution/triggerDistributionAuto) splits
    /// and disburses. Owner-adjustable, with no externally enforced ceiling
    /// beyond > 0 — this is the deployer's own contract to tune as they see
    /// fit. Starts at 0.25 ETH.
    uint256 public disburseThreshold = 0.25 ether;

    /// @notice Slippage floor applied to the ETH -> platformToken buyback
    /// leg whenever it's computed automatically from a live on-chain quote
    /// (see triggerDistributionAuto() and receive() below) — e.g. 500 =
    /// 5.00% tolerance under the router's own getAmountsOut() quote at the
    /// moment the trade executes. Has no effect on triggerDistribution(),
    /// which takes its own caller-supplied floor instead.
    uint256 public buybackSlippageBps = 500; // 5.00%

    /// @notice Running, all-time total of every wei this contract has ever
    /// received (see receive() below) — never decremented, purely a
    /// transparency counter. Independent of the current balance, which
    /// drops back toward zero every time a distribution runs.
    uint256 public totalEthCollected;

    /// @notice All-time totals of what's actually been done with the ETH
    /// collected above, split the same way every distribution is split —
    /// plain running counters, same purpose as totalEthCollected.
    uint256 public totalDistributedToFeeWallet;
    uint256 public totalDistributedToBuyback;

    /// @notice How many holders receive() automatically pays out (see
    /// below) on top of whatever else it does, whenever a disburse round is
    /// already active — the only way to make holder payout fully
    /// self-driving with no external keeper: a smart contract can't run on
    /// its own timer, so ongoing trade-tax payments are used as the
    /// "heartbeat" that nudges an in-progress round forward. Kept
    /// deliberately small and owner-adjustable, since whoever's incoming
    /// transfer happens to trigger a batch pays that batch's extra gas on
    /// top of their own transaction — a real cost shifted onto an
    /// unrelated trader, not free automation. Set to 0 to disable this
    /// piggybacking entirely and rely only on manual/external
    /// processDisburseRound() calls instead.
    uint256 public autoProcessBatchSize = 5;

    // ---- disburse-round bookkeeping: an accumulate-then-batch pattern so
    // paying out every platform token holder never risks looping over an
    // unbounded list in one transaction. Tokens bought back by a
    // distribution accumulate in pendingDisburseTokens; the moment that's
    // nonzero and no round is already active, a new round auto-starts
    // (see _startRoundIfNeeded, called right after every successful
    // buyback) — snapshotting both the amount and the CURRENT
    // totalSupply() so a token minted/burned mid-round, or more tax bought
    // back mid-round, doesn't retroactively change what's already being
    // paid out. processDisburseRound() then pays batches of holders out of
    // that snapshot, proportional to their holdings AT THE TIME EACH BATCH
    // ACTUALLY RUNS (not a true historical snapshot of every balance — see
    // that function's own comment for why that tradeoff is deliberate and
    // disclosed, the same running-total approach reflection/dividend
    // mechanisms elsewhere use rather than a per-block snapshot of every
    // holder). ----
    uint256 public pendingDisburseTokens;
    bool public roundActive;
    uint256 public roundAmount; // total platformToken being paid out this round
    uint256 public roundSupplyAtStart; // totalSupply() read once, at round start — the denominator every batch divides against
    uint256 public roundCursor; // holderAt() index the next processDisburseRound() batch resumes from

    event TaxReceived(address indexed from, uint256 amount, uint256 totalEthCollected);
    event PlatformTokenUpdated(address indexed newPlatformToken);
    event FeeWalletUpdated(address indexed newFeeWallet);
    event DisburseThresholdUpdated(uint256 newThreshold);
    event BuybackSlippageBpsUpdated(uint256 newBps);
    event DistributionTriggered(uint256 totalAmount, uint256 toFeeWallet, uint256 toBuyback, uint256 platformTokensBought);
    event DisburseRoundStarted(uint256 amount, uint256 supplyAtStart);
    event DisburseRoundProgress(uint256 nextCursor, uint256 paidThisBatch);
    event DisburseRoundFinished(uint256 totalAmount);
    event AutoProcessBatchSizeUpdated(uint256 newBatchSize);
    event DisbursePayoutSkipped(address indexed holder, uint256 amount);

    constructor(address router_, address platformToken_, address feeWallet_) Ownable(msg.sender) {
        require(router_ != address(0), "PlatformTaxDistributor: invalid router");
        router = IRouterMinimal(router_);
        platformToken = IPlatformTokenMinimal(platformToken_);
        feeWallet = feeWallet_;
    }

    /// @notice Every trade's 0.30% tax lands here as a plain ETH transfer —
    /// see HoodLaunch's own public/index.html, the only piece of that
    /// platform that knows this address exists. Logs the transfer, adds it
    /// to the all-time totalEthCollected counter, and drives BOTH pieces of
    /// this contract's automation as side effects:
    ///
    ///  1. If a disburse round is already active, piggybacks a small,
    ///     bounded batch of holder payouts onto THIS transfer (see
    ///     autoProcessBatchSize above) — the only way to make holder payout
    ///     fully self-driving without an external keeper, since ongoing
    ///     trade-tax payments are the only thing that calls this contract
    ///     on any regular cadence.
    ///  2. If the balance is now at or above disburseThreshold, immediately
    ///     attempts a full distribution (see triggerDistributionAuto()).
    ///
    /// Both attempts are wrapped in try/catch specifically so NEITHER can
    /// ever cause this function to revert: if feeWallet/platformToken
    /// aren't configured yet, if the router can't quote or swap right now,
    /// if a holder's token transfer reverts, or if anything else about
    /// either automatic attempt fails, this transfer still succeeds — a
    /// misconfigured setting or misbehaving dependency on THIS contract
    /// must never be able to cause a trade on HoodLaunch's own platform to
    /// fail.
    receive() external payable {
        totalEthCollected += msg.value;
        emit TaxReceived(msg.sender, msg.value, totalEthCollected);

        if (roundActive && autoProcessBatchSize > 0) {
            try this.processDisburseRound(autoProcessBatchSize) {} catch {}
        }
        if (address(this).balance >= disburseThreshold) {
            try this.triggerDistributionAuto() {} catch {}
        }
    }

    function setPlatformToken(address newPlatformToken) external onlyOwner {
        require(!roundActive, "PlatformTaxDistributor: a disburse round is active");
        require(pendingDisburseTokens == 0, "PlatformTaxDistributor: tokens are pending disbursement under the current platform token");
        platformToken = IPlatformTokenMinimal(newPlatformToken);
        emit PlatformTokenUpdated(newPlatformToken);
    }

    function setFeeWallet(address newFeeWallet) external onlyOwner {
        feeWallet = newFeeWallet;
        emit FeeWalletUpdated(newFeeWallet);
    }

    function setDisburseThreshold(uint256 newThreshold) external onlyOwner {
        require(newThreshold > 0, "PlatformTaxDistributor: threshold must be > 0");
        disburseThreshold = newThreshold;
        emit DisburseThresholdUpdated(newThreshold);
    }

    function setBuybackSlippageBps(uint256 newBps) external onlyOwner {
        require(newBps <= 2_000, "PlatformTaxDistributor: slippage above 20% ceiling");
        buybackSlippageBps = newBps;
        emit BuybackSlippageBpsUpdated(newBps);
    }

    /// @notice Tunes how many holders each incoming tax payment automatically
    /// pays out of an in-progress round (see receive() and
    /// autoProcessBatchSize above). Capped at 50 — this runs inside an
    /// ordinary trader's own transaction, so it must stay small enough that
    /// it can never plausibly push that transaction over a block's gas
    /// limit on its own. 0 disables the piggyback entirely.
    function setAutoProcessBatchSize(uint256 newBatchSize) external onlyOwner {
        require(newBatchSize <= 50, "PlatformTaxDistributor: batch size above 50 ceiling");
        autoProcessBatchSize = newBatchSize;
        emit AutoProcessBatchSizeUpdated(newBatchSize);
    }

    /// @notice Manual, permissionless fallback for whenever the balance is
    /// already at or above disburseThreshold but, for whatever reason, no
    /// distribution has happened yet (e.g. the automatic attempt inside
    /// receive() failed and was silently swallowed — see that function's
    /// own comment). Uses a live on-chain quote off the router's own
    /// getAmountsOut(), same as the fully automatic path, with
    /// buybackSlippageBps as the tolerance — exactly what receive() itself
    /// calls, just also directly callable by anyone at any time.
    function triggerDistributionAuto() external nonReentrant {
        uint256 balance = address(this).balance;
        require(balance >= disburseThreshold, "PlatformTaxDistributor: balance below disburseThreshold");
        require(feeWallet != address(0), "PlatformTaxDistributor: feeWallet not set");
        require(address(platformToken) != address(0), "PlatformTaxDistributor: platformToken not set");

        uint256 toBuyback = balance - balance / 2;
        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = address(platformToken);
        uint256[] memory amountsOut = router.getAmountsOut(toBuyback, path);
        uint256 quoted = amountsOut[amountsOut.length - 1];
        uint256 minOut = (quoted * (10_000 - buybackSlippageBps)) / 10_000;

        _distribute(minOut);
    }

    /// @notice Same as triggerDistributionAuto(), but with a caller-supplied
    /// slippage floor — for anyone who wants TIGHTER control over the
    /// buyback leg than the automatic quote (e.g. someone who suspects the
    /// pool is being manipulated right now and wants a stricter floor than
    /// buybackSlippageBps would compute).
    ///
    /// FIX (this review): this function used to take minPlatformTokenOut
    /// straight from the caller with no protocol-side floor at all — unlike
    /// triggerDistributionAuto(), which always computes one from a live
    /// quote. Since this function is just as permissionless as that one,
    /// anyone could call this instead with minPlatformTokenOut = 0 to get
    /// the exact unprotected swap the automatic path exists specifically to
    /// prevent — sandwich the buyback, extract the difference, at the direct
    /// expense of the burn/holder-disbursement split. Now computes the same
    /// live-quote floor triggerDistributionAuto() does and takes whichever
    /// of that floor or the caller's own value is stricter (higher), so the
    /// caller-supplied value can only ever tighten the protection, never
    /// remove it.
    function triggerDistribution(uint256 minPlatformTokenOut) external nonReentrant {
        uint256 balance = address(this).balance;
        require(balance >= disburseThreshold, "PlatformTaxDistributor: balance below disburseThreshold");
        require(feeWallet != address(0), "PlatformTaxDistributor: feeWallet not set");
        require(address(platformToken) != address(0), "PlatformTaxDistributor: platformToken not set");

        uint256 toBuyback = balance - balance / 2;
        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = address(platformToken);
        uint256[] memory amountsOut = router.getAmountsOut(toBuyback, path);
        uint256 quoted = amountsOut[amountsOut.length - 1];
        uint256 protocolFloor = (quoted * (10_000 - buybackSlippageBps)) / 10_000;
        uint256 effectiveMinOut = minPlatformTokenOut > protocolFloor ? minPlatformTokenOut : protocolFloor;

        _distribute(effectiveMinOut);
    }

    /// @dev Shared core of both trigger paths above: splits the CURRENT ETH
    /// balance 50/50 — half straight to feeWallet, half swapped for
    /// platformToken and added to pendingDisburseTokens — then auto-starts
    /// a disburse round over that pending balance if none is already
    /// active (see _startRoundIfNeeded). Both callers have already checked
    /// disburseThreshold/feeWallet/platformToken before reaching here.
    function _distribute(uint256 minPlatformTokenOut) private {
        uint256 balance = address(this).balance;
        uint256 toFeeWallet = balance / 2;
        uint256 toBuyback = balance - toFeeWallet;

        (bool sent, ) = feeWallet.call{value: toFeeWallet}("");
        require(sent, "PlatformTaxDistributor: feeWallet transfer failed");
        totalDistributedToFeeWallet += toFeeWallet;

        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = address(platformToken);
        uint256 boughtBefore = platformToken.balanceOf(address(this));
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: toBuyback}(
            minPlatformTokenOut, path, address(this), block.timestamp + 15 minutes
        );
        uint256 bought = platformToken.balanceOf(address(this)) - boughtBefore;
        pendingDisburseTokens += bought;
        totalDistributedToBuyback += toBuyback;

        emit DistributionTriggered(balance, toFeeWallet, toBuyback, bought);

        _startRoundIfNeeded();
    }

    /// @dev Auto-starts a new disburse round the moment there's something
    /// pending and no round is already active — called right after every
    /// successful buyback above, so in the common case nobody ever needs to
    /// call startDisburseRound() manually at all. Snapshots
    /// pendingDisburseTokens and platformToken.totalSupply() once, for the
    /// same reasons documented on the contract-level comment above.
    function _startRoundIfNeeded() private {
        if (roundActive || pendingDisburseTokens == 0) return;
        roundActive = true;
        roundAmount = pendingDisburseTokens;
        roundSupplyAtStart = platformToken.totalSupply();
        roundCursor = 0;
        pendingDisburseTokens = 0;
        emit DisburseRoundStarted(roundAmount, roundSupplyAtStart);
    }

    /// @notice Manual fallback for _startRoundIfNeeded() above — covers the
    /// rare case where pendingDisburseTokens is nonzero but no round is
    /// active and nothing has triggered a new distribution since (e.g. the
    /// owner sent platformToken to this contract directly, outside the
    /// normal buyback path). Reverts if a round is already active or if
    /// there's nothing pending; ordinarily unnecessary, since every
    /// successful distribution starts a round on its own.
    function startDisburseRound() external {
        require(!roundActive, "PlatformTaxDistributor: a disburse round is already active");
        require(pendingDisburseTokens > 0, "PlatformTaxDistributor: nothing pending to disburse");
        require(address(platformToken) != address(0), "PlatformTaxDistributor: platformToken not set");
        _startRoundIfNeeded();
    }

    /// @notice Pays out up to `batchSize` more holders from the active
    /// round, resuming from roundCursor — callable repeatedly by anyone
    /// until it reports the round finished (roundActive flips back to
    /// false). Looping over ALL holders in one transaction risks running
    /// out of gas, which is why this is batched at all — receive() already
    /// calls this automatically, in small pieces, every time a new tax
    /// payment arrives (see autoProcessBatchSize), so in ordinary operation
    /// with regular trading activity nobody needs to call this directly.
    /// It remains callable by anyone at any time regardless — the owner, a
    /// holder impatient for their share, or a script/cron the owner sets up
    /// entirely outside this contract — as a faster or more reliable way to
    /// finish a round than waiting on trading activity alone.
    ///
    /// A holder with a zero balance, a zero computed share, or a transfer
    /// that reverts (e.g. a blocklist-style token) is simply skipped rather
    /// than reverting the whole batch — see _sendPlatformToken.
    ///
    /// FIX (this review, same class as the already-fixed PlatformRewards-
    /// Distributor Finding PR-1): a skipped holder's share used to be
    /// silently dropped — never added back to pendingDisburseTokens, never
    /// reflected in roundAmount, and no code path ever revisited it, despite
    /// this function's own comment previously (incorrectly) claiming it
    /// would become "available to whatever the NEXT distribution adds to
    /// pendingDisburseTokens." In reality, since pendingDisburseTokens is
    /// only ever incremented by a fresh buyback's own `bought` amount (see
    /// _distribute), a skipped share just sat in this contract's raw
    /// platformToken balance forever, uncounted by any tracking variable.
    /// Skipped shares are now re-added to pendingDisburseTokens so they
    /// actually get folded into the NEXT round once one starts, and a
    /// DisbursePayoutSkipped event makes every skip independently
    /// auditable.
    function processDisburseRound(uint256 batchSize) external nonReentrant {
        require(roundActive, "PlatformTaxDistributor: no disburse round is active");
        require(batchSize > 0, "PlatformTaxDistributor: batchSize must be > 0");

        uint256 holders = platformToken.holderCount();
        uint256 cursor = roundCursor;
        uint256 end = cursor + batchSize;
        if (end > holders) end = holders;

        uint256 paidThisBatch;
        for (uint256 i = cursor; i < end; i++) {
            address holder = platformToken.holderAt(i);
            uint256 bal = platformToken.balanceOf(holder);
            if (bal == 0) continue;
            uint256 share = (roundAmount * bal) / roundSupplyAtStart;
            if (share == 0) continue;
            if (_sendPlatformToken(holder, share)) {
                paidThisBatch += share;
            } else {
                pendingDisburseTokens += share;
                emit DisbursePayoutSkipped(holder, share);
            }
        }

        roundCursor = end;
        emit DisburseRoundProgress(end, paidThisBatch);

        if (end >= holders) {
            roundActive = false;
            emit DisburseRoundFinished(roundAmount);
        }
    }

    /// @dev Isolated purely so a misbehaving platformToken (e.g. a
    /// blocklist-style token that reverts transfers to certain addresses)
    /// can't brick the entire batch — a failed send to one holder is
    /// skipped, never retried automatically and never a reason to revert
    /// everyone else's already-successful payouts in the same batch. See
    /// processDisburseRound's own doc comment.
    function _sendPlatformToken(address to, uint256 amount) private returns (bool) {
        try platformToken.transfer(to, amount) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }
}
