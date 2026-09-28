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
/// platform token holder. No keeper, relayer, or manual call is needed for
/// this step — it happens as a side effect of whatever transfer happened to
/// cross the threshold. The one piece that genuinely cannot be automatic is
/// paying out a potentially large holder list: that's still done in
/// explicit batches via processDisburseRound() (anyone can call it, as many
/// times as it takes), since looping over an unbounded number of holders in
/// a single transaction risks running out of gas — see that function's own
/// comment.
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

    constructor(address router_, address platformToken_, address feeWallet_) Ownable(msg.sender) {
        require(router_ != address(0), "PlatformTaxDistributor: invalid router");
        router = IRouterMinimal(router_);
        platformToken = IPlatformTokenMinimal(platformToken_);
        feeWallet = feeWallet_;
    }

    /// @notice Every trade's 0.30% tax lands here as a plain ETH transfer —
    /// see HoodLaunch's own public/index.html, the only piece of that
    /// platform that knows this address exists. Logs the transfer, adds it
    /// to the all-time totalEthCollected counter, and — this is the
    /// automation this contract runs on — if that pushes the balance to
    /// disburseThreshold or beyond, immediately attempts a full
    /// distribution (see triggerDistributionAuto()) with NO extra call
    /// from anyone required.
    ///
    /// That attempt is wrapped in try/catch specifically so it can NEVER
    /// cause this function to revert: if feeWallet/platformToken aren't
    /// configured yet, if the router can't quote or swap right now, or if
    /// anything else about the automatic attempt fails, the ETH is simply
    /// accepted and sits in this contract's balance for the next transfer
    /// (or a manual triggerDistribution/triggerDistributionAuto call) to
    /// try again — a misconfigured setting on THIS contract must never be
    /// able to cause a trade on HoodLaunch's own platform to fail.
    receive() external payable {
        totalEthCollected += msg.value;
        emit TaxReceived(msg.sender, msg.value, totalEthCollected);
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
    /// slippage floor instead of an automatic on-chain quote — for anyone
    /// who wants tighter control over the buyback leg (e.g. someone who
    /// suspects the pool is being manipulated right now and doesn't trust
    /// an automatic quote taken at this exact moment).
    function triggerDistribution(uint256 minPlatformTokenOut) external nonReentrant {
        uint256 balance = address(this).balance;
        require(balance >= disburseThreshold, "PlatformTaxDistributor: balance below disburseThreshold");
        require(feeWallet != address(0), "PlatformTaxDistributor: feeWallet not set");
        require(address(platformToken) != address(0), "PlatformTaxDistributor: platformToken not set");

        _distribute(minPlatformTokenOut);
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
    /// false). This is the one part of the whole pipeline that genuinely
    /// cannot be fully automatic: HoodLaunch's platform token can have an
    /// unbounded number of holders, and looping over all of them in a
    /// single transaction risks running out of gas, so this must be called
    /// (by anyone — the owner, a holder waiting on their share, or a
    /// script/cron the owner sets up entirely outside this contract) as
    /// many times as it takes to reach the end of the holder list.
    ///
    /// A holder with a zero balance, a zero computed share, or a transfer
    /// that reverts (e.g. a blocklist-style token) is simply skipped rather
    /// than reverting the whole batch — see _sendPlatformToken. Any tokens
    /// skipped this way are never swept or retried automatically; they
    /// stay in this contract's own platformToken balance, available to
    /// whatever the NEXT distribution adds to pendingDisburseTokens for the
    /// round after this one.
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
