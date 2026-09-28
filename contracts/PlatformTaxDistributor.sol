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
/// Mechanics: every ETH transfer this contract receives (see receive()
/// below) simply accumulates in its own balance — there is no per-sender
/// bookkeeping, since the tax has no notion of "whose" it is once paid.
/// Once that balance reaches disburseThreshold, ANYONE (not just the owner
/// — a deliberately permissionless trigger, the same convention HoodLaunch's
/// own buy()/sell() functions use, since running it benefits the whole
/// system rather than whoever happens to call it) can call
/// triggerDistribution() to split the current balance 50/50: half straight
/// to feeWallet in plain ETH, half swapped for platformToken and queued for
/// pro-rata disbursement to every platform token holder via
/// startDisburseRound()/processDisburseRound() — an accumulate-then-batch
/// pattern that avoids ever looping over an unbounded holder list in a
/// single transaction.
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

    /// @notice ETH balance this contract must reach before
    /// triggerDistribution() will do anything. Owner-adjustable, with no
    /// externally enforced ceiling or floor beyond > 0 — this is the
    /// deployer's own contract to tune as they see fit.
    uint256 public disburseThreshold = 1 ether;

    /// @notice Slippage floor applied to the ETH -> platformToken buyback
    /// leg of triggerDistribution(), in bps of the router's own current
    /// quote for that leg (e.g. 500 = 5.00% tolerance). There is no
    /// on-chain reserve/quote data cached by this contract to derive a
    /// floor from automatically (unlike HoodLaunch's own FeeWalletDistributor,
    /// which reads its target pool's live reserves directly) — instead,
    /// whoever calls triggerDistribution() supplies minPlatformTokenOut
    /// directly, computed off the router's own getAmountsOut, exactly like
    /// HoodLaunch's own front end already does for its trades. This bps
    /// value is purely informational / a suggested tolerance for callers to
    /// use when computing that floor off-chain; it is never read on-chain
    /// by this contract itself.
    uint256 public suggestedBuybackSlippageBps = 500; // 5.00%

    // ---- disburse-round bookkeeping: an accumulate-then-batch pattern so
    // paying out every platform token holder never risks looping over an
    // unbounded list in one transaction. Tokens bought back by
    // triggerDistribution() accumulate in pendingDisburseTokens until
    // startDisburseRound() snapshots the current pending amount and total
    // supply, and processDisburseRound() pays batches of holders out of
    // that snapshot, proportional to their holdings AT THE TIME EACH BATCH
    // ACTUALLY RUNS (not a true historical snapshot of every balance — see
    // startDisburseRound's own comment for why that tradeoff is deliberate
    // and disclosed, the same running-total approach reflection/dividend
    // mechanisms elsewhere use rather than a per-block snapshot of every
    // holder). ----
    uint256 public pendingDisburseTokens;
    bool public roundActive;
    uint256 public roundAmount; // total platformToken being paid out this round
    uint256 public roundSupplyAtStart; // totalSupply() read once, at startDisburseRound() — the denominator every batch divides against
    uint256 public roundCursor; // holderAt() index the next processDisburseRound() batch resumes from

    event TaxReceived(address indexed from, uint256 amount);
    event PlatformTokenUpdated(address indexed newPlatformToken);
    event FeeWalletUpdated(address indexed newFeeWallet);
    event DisburseThresholdUpdated(uint256 newThreshold);
    event SuggestedBuybackSlippageBpsUpdated(uint256 newBps);
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
    /// platform that knows this address exists. Deliberately does nothing
    /// but accept the ETH and log it: no swap, no bookkeeping beyond the
    /// event below, and — critically — this can never revert, so a
    /// misconfigured setting elsewhere on THIS contract can never cause a
    /// trade on that platform to fail. (Fail-open on receipt, independent
    /// of whatever fail-open conventions that platform's own contracts do
    /// or don't follow — this contract owes them nothing beyond not
    /// breaking their trades.)
    receive() external payable {
        emit TaxReceived(msg.sender, msg.value);
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

    function setSuggestedBuybackSlippageBps(uint256 newBps) external onlyOwner {
        require(newBps <= 2_000, "PlatformTaxDistributor: slippage suggestion above 20% ceiling");
        suggestedBuybackSlippageBps = newBps;
        emit SuggestedBuybackSlippageBpsUpdated(newBps);
    }

    /// @notice Splits the CURRENT ETH balance 50/50 the moment it's at
    /// least disburseThreshold: half straight to feeWallet, half swapped
    /// for platformToken (added to pendingDisburseTokens for a later
    /// startDisburseRound()/processDisburseRound() to pay out). Callable by
    /// anyone — see the contract-level comment above for why — since
    /// nothing about running it benefits the caller over anyone else; it
    /// just needs SOMEONE to pay the gas once enough has accumulated.
    /// minPlatformTokenOut is the caller's own slippage floor for the
    /// buyback leg, computed off-chain against the router's own
    /// getAmountsOut (see suggestedBuybackSlippageBps above) — there is no
    /// automatic on-chain quote here to derive one from.
    function triggerDistribution(uint256 minPlatformTokenOut) external nonReentrant {
        uint256 balance = address(this).balance;
        require(balance >= disburseThreshold, "PlatformTaxDistributor: balance below disburseThreshold");
        require(feeWallet != address(0), "PlatformTaxDistributor: feeWallet not set");
        require(address(platformToken) != address(0), "PlatformTaxDistributor: platformToken not set");

        uint256 toFeeWallet = balance / 2;
        uint256 toBuyback = balance - toFeeWallet;

        (bool sent, ) = feeWallet.call{value: toFeeWallet}("");
        require(sent, "PlatformTaxDistributor: feeWallet transfer failed");

        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = address(platformToken);
        uint256 boughtBefore = platformToken.balanceOf(address(this));
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: toBuyback}(
            minPlatformTokenOut, path, address(this), block.timestamp + 15 minutes
        );
        uint256 bought = platformToken.balanceOf(address(this)) - boughtBefore;
        pendingDisburseTokens += bought;

        emit DistributionTriggered(balance, toFeeWallet, toBuyback, bought);
    }

    /// @notice Starts a new disburse round over the CURRENT
    /// pendingDisburseTokens balance and the CURRENT totalSupply() —
    /// snapshotting both once so a token minted/burned mid-round, or more
    /// tax bought back mid-round, doesn't retroactively change what's
    /// already being paid out. Reverts if a round is already active (finish
    /// it via processDisburseRound() first) or if there's nothing pending.
    ///
    /// Every holder's share is computed as
    /// balanceOf(holder) * roundAmount / roundSupplyAtStart at the moment
    /// their own batch actually runs — not a true point-in-time snapshot of
    /// every balance (looping to snapshot every holder up front would
    /// itself be unbounded). A holder who moves tokens between
    /// startDisburseRound() and their own batch is paid against their
    /// balance AT THAT LATER MOMENT, not at round start — a deliberate,
    /// disclosed tradeoff.
    function startDisburseRound() external {
        require(!roundActive, "PlatformTaxDistributor: a disburse round is already active");
        require(pendingDisburseTokens > 0, "PlatformTaxDistributor: nothing pending to disburse");
        require(address(platformToken) != address(0), "PlatformTaxDistributor: platformToken not set");
        roundActive = true;
        roundAmount = pendingDisburseTokens;
        roundSupplyAtStart = platformToken.totalSupply();
        roundCursor = 0;
        pendingDisburseTokens = 0;
        emit DisburseRoundStarted(roundAmount, roundSupplyAtStart);
    }

    /// @notice Pays out up to `batchSize` more holders from the active
    /// round, resuming from roundCursor — callable repeatedly by anyone
    /// until it reports the round finished (roundActive flips back to
    /// false). A holder with a zero balance, a zero computed share, or a
    /// transfer that reverts (e.g. a blocklist-style token) is simply
    /// skipped rather than reverting the whole batch — see
    /// _sendPlatformToken. Any tokens skipped this way are never swept or
    /// retried automatically; they stay in this contract's own
    /// platformToken balance, available to whatever the NEXT
    /// triggerDistribution() adds to pendingDisburseTokens for the round
    /// after this one.
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
