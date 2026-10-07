// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./interfaces/V4IPlatformToken.sol";
import "./interfaces/V4IUniswapV2Router.sol";

/// @title V4PlatformTaxDistributor
/// @notice V4 counterpart of PlatformTaxDistributor. Same job, same economics:
/// it collects the flat 0.30% trade tax the front end sends as a plain ETH
/// transfer on every buy / sell (V2 pools, V4 pools and both bonding curves),
/// and once its balance reaches disburseThreshold it splits it 50/50, half
/// in ETH to feeWallet, half swapped for the platform token and paid out
/// pro rata to every platform-token holder in batches.
///
/// Nothing about the INPUT side depends on V2 or V4: the tax arrives as ETH
/// whichever pool the trade went through, so the same deployed distributor
/// can serve both. This file exists so the V4 set has no hidden dependency on
/// V2-prefixed interfaces and so the holder-payout machinery matches the
/// hardened one in V4PlatformTokenRewards (PR-5 generation guard, own balance
/// excluded from the snapshot). Like the V4 distributors, the platform token's
/// own pool is Uniswap V2, so the buyback goes through a V2 router passed at
/// construction.
///
/// Fully standalone: no PoolManager, hook or factory dependency, and not
/// controlled by the platform's own owner wallet; whoever deploys it owns it.
///
/// --- Changes from PlatformTaxDistributor (V2) ---
/// V4TD-1 (Low, fixed): the payout snapshot divided by the platform token's
/// FULL totalSupply(), which includes the tokens this contract itself holds
/// for the round. That diluted every holder's share (the sum paid out was less
/// than roundAmount, the rest stranded) and the contract was also a "holder"
/// of its own tokens, paying part of the round to itself. The snapshot is now
/// totalSupply() less this contract's own balance and this contract is
/// skipped, as in V4PlatformTokenRewards.
/// V4TD-2 (Low, fixed): no holder-generation guard. The holder registry
/// swap-and-pops, so a holder who exits and re-enters mid-round (or a tail
/// holder moved into an already-paid slot) could be paid twice or skipped.
/// Rounds now record holderCount and holderGenerationCounter at start and only
/// pay holders that were already in place; late arrivals are skipped (their
/// share is not lost: it simply stays in the contract and is rescuable above
/// the committed amount).
/// V4TD-3 (Medium, disclosed, mitigated): the "protocol floor" the V2 file
/// computes from getAmountsOut() is read from the SAME pool in the SAME
/// transaction, so it reflects whatever price an attacker has just pushed it
/// to and gives no protection against a sandwich. Because receive() runs the
/// buyback automatically, anyone who can move the platform token's price can
/// make the next tax payment (or their own top-up that crosses the threshold)
/// execute at a bad price. Mitigations added: autoDistribute (turn the
/// automatic buyback in receive() off and let a keeper call
/// triggerDistribution(minOut) with a floor computed off-chain), and
/// maxBuybackPerDistribution (caps the ETH exposed per swap). The on-chain
/// floor is kept as a sanity bound, not as sandwich protection.
/// V4TD-4 (Low, fixed): rescueToken used a raw transfer; now SafeERC20.
/// V4TD-5 (design change): works before a platform token exists. While
/// platformToken is address(0), a distribution sends the WHOLE balance to
/// feeWallet in ETH (no buyback, no holder round), so the tax is usable from
/// day one. Once the owner calls setRouter + setPlatformToken, it switches to
/// the normal 50/50 split. The router is therefore a normal setting here, not
/// an immutable, and may be address(0) at construction.
///
/// --- Changes from the standalone security audit of this file ---
/// TA-1 (Medium, fixed): a round pays from holders' balances AT THE MOMENT IT
/// RUNS against a supply snapshot taken at its start, so anyone who borrowed
/// tokens (a flash loan, a V2 pair's liquidity) could start or process a round
/// while holding them and take other holders' share, and a holder hopping
/// tokens to a wallet later in the list was paid twice out of the NEXT round's
/// tokens (no per-round cap). startDisburseRound / processDisburseRound are now
/// limited to the owner, approved keepers and this contract's own heartbeat;
/// runDisburseRound starts and pays a round in one transaction; and a round can
/// never pay beyond its own pot (roundUsed).
/// TA-2 (Medium, fixed): triggerDistribution / triggerDistributionAuto were
/// permissionless, so anyone could pick the moment of the buyback (V4TD-3). They
/// are now owner / keeper only, and a fresh deployment starts with
/// autoDistribute = false and autoProcessBatchSize = 0 so a trade never runs a
/// swap inside the tax transfer. The owner can switch either back on.
/// TA-3 (Medium/Low, fixed): with maxBuybackPerDistribution binding, the fee
/// wallet still received half the whole balance while only the cap was bought
/// back, and the leftover was re-split 50/50 next time, so the fee wallet ended
/// up with far more than half. When the cap binds the fee wallet now gets
/// exactly what is bought back and the rest stays whole.
/// TA-4 (Low, fixed): pools and other non-holders (the V2 pair, PoolManager, the
/// other distributors) were paid like holders. setAirdropExcluded leaves up to
/// 16 addresses out and removes their balances from the round snapshot.
/// TA-5 (Low, fixed): fee wallet payouts forwarded all gas (a hostile or broken
/// fee wallet burned the caller's whole gas limit) and the fee wallet could be
/// this contract; payouts are capped at 100,000 gas, and the router and
/// platform token must be contracts.
/// TA-6 (Low, fixed): DisburseRoundFinished reported the whole pot instead of
/// what was paid, the committed amount used by rescueToken ignored what a
/// running round had already paid, and renounceOwnership could orphan the
/// contract. Now accurate, and renounce is disabled.
contract V4PlatformTaxDistributor is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice V2 router used for the buyback. address(0) is allowed while there
    /// is no platform token (owner can set it later with setRouter).
    V4IUniswapV2Router public router;

    /// @notice The token bought back and disbursed to holders. Can only change
    /// when no round is active and nothing is pending.
    V4IPlatformToken public platformToken;

    /// @notice Half of every distribution goes here, in plain ETH.
    address public feeWallet;

    /// @notice Balance that must be reached before a distribution runs.
    uint256 public disburseThreshold = 0.25 ether;

    /// @notice Tolerance under the router's own quote (see V4TD-3: a sanity
    /// bound, not sandwich protection). 500 = 5%.
    uint256 public buybackSlippageBps = 500;

    /// @notice If true, receive() itself runs a distribution when the threshold
    /// is reached. Default false (TA-2): a keeper calls
    /// triggerDistribution(minOut) with an off-chain floor instead.
    bool public autoDistribute = false;

    /// @notice Max ETH put into one buyback swap; 0 = uncapped. Any excess
    /// stays in the balance for the next distribution.
    uint256 public maxBuybackPerDistribution;

    /// @notice How many holders receive() pays out of an active round per
    /// incoming transfer (the "heartbeat"); 0 (default) disables it. See TA-1:
    /// payouts are balance-based, so leave this off unless that is acceptable.
    uint256 public autoProcessBatchSize = 0;

    /// @notice Gas forwarded to feeWallet when paying it (TA-5).
    uint256 public constant FEE_WALLET_CALL_GAS = 100_000;

    /// @notice Addresses left out of payouts (V2 pair, PoolManager, other
    /// distributors, burn address...), TA-4.
    uint256 public constant MAX_AIRDROP_EXCLUDED = 16;
    mapping(address => bool) public airdropExcluded;
    address[] private _airdropExcludedList;

    /// @notice Accounts besides the owner allowed to convert and run rounds.
    mapping(address => bool) public keepers;

    uint256 public totalEthCollected;
    uint256 public totalDistributedToFeeWallet;
    uint256 public totalDistributedToBuyback;

    uint256 public pendingDisburseTokens;
    bool public roundActive;
    uint256 public roundAmount;
    uint256 public roundSupplyAtStart; // eligible supply: totalSupply less this contract's own balance
    uint256 public roundCursor;
    uint256 public roundHolderCountAtStart;
    uint256 public roundGenerationAtStart;
    /// @notice Part of roundAmount already paid out or re-queued this round.
    uint256 public roundUsed;
    /// @notice Part of roundAmount actually transferred to holders this round.
    uint256 public roundDistributed;

    event TaxReceived(address indexed from, uint256 amount, uint256 totalEthCollected);
    event PlatformTokenUpdated(address indexed newPlatformToken);
    event RouterUpdated(address indexed newRouter);
    event FeeWalletUpdated(address indexed newFeeWallet);
    event DisburseThresholdUpdated(uint256 newThreshold);
    event BuybackSlippageBpsUpdated(uint256 newBps);
    event AutoDistributeUpdated(bool enabled);
    event MaxBuybackPerDistributionUpdated(uint256 newMax);
    event AutoProcessBatchSizeUpdated(uint256 newBatchSize);
    event DistributionTriggered(uint256 totalAmount, uint256 toFeeWallet, uint256 toBuyback, uint256 platformTokensBought);
    event DisburseRoundStarted(uint256 amount, uint256 supplyAtStart, uint256 holderCountAtStart);
    event DisburseRoundProgress(uint256 nextCursor, uint256 paidThisBatch);
    event DisburseRoundFinished(uint256 totalAmount);
    event DisbursePayoutSkipped(address indexed holder, uint256 amount);
    event DisburseHolderIneligibleThisRound(address indexed holder, uint256 holderGeneration, uint256 roundGeneration);
    event EthRescued(address indexed to, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event KeeperSet(address indexed keeper, bool enabled);
    event AirdropExclusionSet(address indexed account, bool excluded);

    constructor(address router_, address platformToken_, address feeWallet_) Ownable(msg.sender) {
        require(
            platformToken_ == address(0) || router_ != address(0),
            "V4PlatformTaxDistributor: a platform token needs a router"
        );
        require(router_ == address(0) || router_.code.length > 0, "V4PlatformTaxDistributor: router is not a contract");
        require(
            platformToken_ == address(0) || platformToken_.code.length > 0,
            "V4PlatformTaxDistributor: platform token is not a contract"
        );
        require(feeWallet_ != address(this), "V4PlatformTaxDistributor: invalid fee wallet");
        router = V4IUniswapV2Router(router_);
        platformToken = V4IPlatformToken(platformToken_);
        feeWallet = feeWallet_;
    }

    /// @notice Every trade's tax lands here as a plain ETH transfer. Never
    /// reverts because of what it does with the ETH: both automatic attempts
    /// are wrapped in try/catch so a misconfigured setting or misbehaving
    /// dependency here can never make a trade on the platform fail.
    receive() external payable {
        totalEthCollected += msg.value;
        emit TaxReceived(msg.sender, msg.value, totalEthCollected);

        if (roundActive && autoProcessBatchSize > 0) {
            try this.processDisburseRound(autoProcessBatchSize) {} catch {}
        }
        if (autoDistribute && address(this).balance >= disburseThreshold) {
            try this.triggerDistributionAuto() {} catch {}
        }
    }

    // ---------------------------------------------------------------
    // Owner settings
    // ---------------------------------------------------------------

    function setRouter(address newRouter) external onlyOwner {
        require(
            newRouter != address(0) || address(platformToken) == address(0),
            "V4PlatformTaxDistributor: router needed while a platform token is set"
        );
        require(newRouter == address(0) || newRouter.code.length > 0, "V4PlatformTaxDistributor: router is not a contract");
        router = V4IUniswapV2Router(newRouter);
        emit RouterUpdated(newRouter);
    }

    function setPlatformToken(address newPlatformToken) external onlyOwner {
        require(
            newPlatformToken == address(0) || address(router) != address(0),
            "V4PlatformTaxDistributor: set a router first"
        );
        require(
            newPlatformToken == address(0) || newPlatformToken.code.length > 0,
            "V4PlatformTaxDistributor: platform token is not a contract"
        );
        require(!roundActive, "V4PlatformTaxDistributor: a disburse round is active");
        require(pendingDisburseTokens == 0, "V4PlatformTaxDistributor: tokens pending under the current platform token");
        platformToken = V4IPlatformToken(newPlatformToken);
        emit PlatformTokenUpdated(newPlatformToken);
    }

    function setFeeWallet(address newFeeWallet) external onlyOwner {
        require(newFeeWallet != address(this), "V4PlatformTaxDistributor: invalid fee wallet");
        feeWallet = newFeeWallet;
        emit FeeWalletUpdated(newFeeWallet);
    }

    function setDisburseThreshold(uint256 newThreshold) external onlyOwner {
        require(newThreshold > 0, "V4PlatformTaxDistributor: threshold must be > 0");
        disburseThreshold = newThreshold;
        emit DisburseThresholdUpdated(newThreshold);
    }

    function setBuybackSlippageBps(uint256 newBps) external onlyOwner {
        require(newBps <= 2_000, "V4PlatformTaxDistributor: slippage above 20% ceiling");
        buybackSlippageBps = newBps;
        emit BuybackSlippageBpsUpdated(newBps);
    }

    function setAutoDistribute(bool enabled) external onlyOwner {
        autoDistribute = enabled;
        emit AutoDistributeUpdated(enabled);
    }

    function setMaxBuybackPerDistribution(uint256 newMax) external onlyOwner {
        maxBuybackPerDistribution = newMax;
        emit MaxBuybackPerDistributionUpdated(newMax);
    }

    function setAutoProcessBatchSize(uint256 newBatchSize) external onlyOwner {
        require(newBatchSize <= 50, "V4PlatformTaxDistributor: batch size above 50 ceiling");
        autoProcessBatchSize = newBatchSize;
        emit AutoProcessBatchSizeUpdated(newBatchSize);
    }

    /// @notice Allow (or stop allowing) an account to convert the tax and run
    /// rounds. The relayer wallet goes here.
    function setKeeper(address keeper, bool enabled) external onlyOwner {
        require(keeper != address(0), "V4PlatformTaxDistributor: invalid keeper");
        keepers[keeper] = enabled;
        emit KeeperSet(keeper, enabled);
    }

    function isKeeper(address account) public view returns (bool) {
        return account == owner() || keepers[account];
    }

    /// @dev Renouncing would strand rescue and every setting.
    function renounceOwnership() public view override onlyOwner {
        revert("V4PlatformTaxDistributor: renounce disabled");
    }

    /// @notice Leave `account` out of payouts (or put it back). Owner only, at
    /// most MAX_AIRDROP_EXCLUDED entries, and not while a round is running (the
    /// round's supply snapshot depends on it).
    function setAirdropExcluded(address account, bool excluded) external onlyOwner {
        require(!roundActive, "V4PlatformTaxDistributor: round in progress");
        require(account != address(0) && account != address(this), "V4PlatformTaxDistributor: invalid account");
        if (airdropExcluded[account] == excluded) return;
        airdropExcluded[account] = excluded;
        if (excluded) {
            require(_airdropExcludedList.length < MAX_AIRDROP_EXCLUDED, "V4PlatformTaxDistributor: too many exclusions");
            _airdropExcludedList.push(account);
        } else {
            uint256 n = _airdropExcludedList.length;
            for (uint256 i = 0; i < n; i++) {
                if (_airdropExcludedList[i] == account) {
                    _airdropExcludedList[i] = _airdropExcludedList[n - 1];
                    _airdropExcludedList.pop();
                    break;
                }
            }
        }
        emit AirdropExclusionSet(account, excluded);
    }

    function airdropExcludedCount() external view returns (uint256) {
        return _airdropExcludedList.length;
    }

    function airdropExcludedAt(uint256 index) external view returns (address) {
        return _airdropExcludedList[index];
    }

    // ---------------------------------------------------------------
    // Distribution
    // ---------------------------------------------------------------

    /// @dev Owner, approved keepers, and this contract's own receive() heartbeat.
    modifier onlyConverter() {
        require(
            msg.sender == address(this) || isKeeper(msg.sender), "V4PlatformTaxDistributor: not authorized to convert"
        );
        _;
    }

    modifier onlyRoundRunner() {
        require(
            msg.sender == address(this) || isKeeper(msg.sender), "V4PlatformTaxDistributor: not authorized to run rounds"
        );
        _;
    }

    /// @notice Owner / keeper (or the automatic path in receive()); floor = live
    /// router quote less buybackSlippageBps. See V4TD-3: a sanity bound, not
    /// sandwich protection, which is why outsiders cannot choose the moment.
    function triggerDistributionAuto() external nonReentrant onlyConverter {
        _distribute(0);
    }

    /// @notice Owner / keeper, with a floor computed off-chain from a trusted
    /// price. The stricter of that and the on-chain floor applies.
    function triggerDistribution(uint256 minPlatformTokenOut) external nonReentrant onlyConverter {
        _distribute(minPlatformTokenOut);
    }

    function _distribute(uint256 callerMinOut) private {
        uint256 balance = address(this).balance;
        require(balance >= disburseThreshold, "V4PlatformTaxDistributor: balance below disburseThreshold");
        require(feeWallet != address(0), "V4PlatformTaxDistributor: feeWallet not set");

        // No platform token yet: everything goes to the fee wallet in ETH.
        if (address(platformToken) == address(0)) {
            (bool sentAll,) = feeWallet.call{value: balance, gas: FEE_WALLET_CALL_GAS}("");
            require(sentAll, "V4PlatformTaxDistributor: feeWallet transfer failed");
            totalDistributedToFeeWallet += balance;
            emit DistributionTriggered(balance, balance, 0, 0);
            return;
        }
        require(address(router) != address(0), "V4PlatformTaxDistributor: router not set");

        uint256 toFeeWallet = balance / 2;
        uint256 toBuyback = balance - toFeeWallet;
        uint256 cap = maxBuybackPerDistribution;
        if (cap > 0 && toBuyback > cap) {
            // TA-3: keep the split even when the cap binds; the rest stays whole.
            toBuyback = cap;
            toFeeWallet = cap;
        }

        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = address(platformToken);
        uint256[] memory amountsOut = router.getAmountsOut(toBuyback, path);
        uint256 quoted = amountsOut[amountsOut.length - 1];
        uint256 floor = (quoted * (10_000 - buybackSlippageBps)) / 10_000;
        uint256 minOut = callerMinOut > floor ? callerMinOut : floor;

        (bool sent,) = feeWallet.call{value: toFeeWallet, gas: FEE_WALLET_CALL_GAS}("");
        require(sent, "V4PlatformTaxDistributor: feeWallet transfer failed");
        totalDistributedToFeeWallet += toFeeWallet;

        uint256 boughtBefore = platformToken.balanceOf(address(this));
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: toBuyback}(
            minOut, path, address(this), block.timestamp + 15 minutes
        );
        uint256 bought = platformToken.balanceOf(address(this)) - boughtBefore;
        pendingDisburseTokens += bought;
        totalDistributedToBuyback += toBuyback;

        emit DistributionTriggered(balance, toFeeWallet, toBuyback, bought);

        _startRoundIfNeeded();
    }

    /// @dev Starts a round over whatever is pending when none is active.
    /// Silent no-op if there are no eligible holders (never reverts the
    /// distribution that just bought the tokens).
    function _startRoundIfNeeded() private {
        if (roundActive || pendingDisburseTokens == 0) return;

        uint256 ineligible = platformToken.balanceOf(address(this));
        uint256 n = _airdropExcludedList.length;
        for (uint256 i = 0; i < n; i++) ineligible += platformToken.balanceOf(_airdropExcludedList[i]);
        uint256 supply = platformToken.totalSupply();
        uint256 eligibleSupply = supply > ineligible ? supply - ineligible : 0;
        if (eligibleSupply == 0) return;

        roundActive = true;
        roundAmount = pendingDisburseTokens;
        roundSupplyAtStart = eligibleSupply;
        roundCursor = 0;
        roundUsed = 0;
        roundDistributed = 0;
        pendingDisburseTokens = 0;
        roundHolderCountAtStart = platformToken.holderCount();
        roundGenerationAtStart = platformToken.holderGenerationCounter();
        emit DisburseRoundStarted(roundAmount, eligibleSupply, roundHolderCountAtStart);
    }

    /// @notice Owner / keeper only: a round is paid from balances at the moment
    /// it runs, so an outsider could borrow tokens to inflate theirs (TA-1).
    /// Manual fallback: start a round over pending tokens (e.g. after skipped
    /// shares were re-queued, or tokens sent in directly).
    function startDisburseRound() external nonReentrant onlyRoundRunner {
        _startDisburseRound();
    }

    function _startDisburseRound() private {
        require(!roundActive, "V4PlatformTaxDistributor: a disburse round is already active");
        require(pendingDisburseTokens > 0, "V4PlatformTaxDistributor: nothing pending to disburse");
        require(address(platformToken) != address(0), "V4PlatformTaxDistributor: platformToken not set");
        _startRoundIfNeeded();
        require(roundActive, "V4PlatformTaxDistributor: no eligible holders");
    }

    /// @notice Pays up to `batchSize` more holders of the active round. Owner /
    /// keeper only (receive() calls it on itself when the heartbeat is on).
    /// A zero balance, zero share, holder that joined after the round started,
    /// or a transfer that reverts is skipped, never reverting the batch.
    /// A transfer that fails is re-queued into pendingDisburseTokens.
    function processDisburseRound(uint256 batchSize) external nonReentrant onlyRoundRunner {
        _processDisburseRound(batchSize);
    }

    /// @notice Starts a round if none is running and pays the first
    /// `batchSize` holders, all in one transaction (no gap between snapshot and
    /// payment).
    function runDisburseRound(uint256 batchSize) external nonReentrant onlyRoundRunner {
        if (!roundActive) _startDisburseRound();
        _processDisburseRound(batchSize);
    }

    function _processDisburseRound(uint256 batchSize) private {
        require(roundActive, "V4PlatformTaxDistributor: no disburse round is active");
        require(batchSize > 0, "V4PlatformTaxDistributor: batchSize must be > 0");

        uint256 liveCount = platformToken.holderCount();
        uint256 total = liveCount < roundHolderCountAtStart ? liveCount : roundHolderCountAtStart;
        uint256 from = roundCursor;
        uint256 to = from + batchSize;
        if (to > total) to = total;

        uint256 paidThisBatch;
        uint256 remaining = roundAmount - roundUsed;
        for (uint256 i = from; i < to; i++) {
            address holder = platformToken.holderAt(i);
            if (holder == address(this) || airdropExcluded[holder]) continue;
            uint256 holderGen = platformToken.holderGeneration(holder);
            if (holderGen > roundGenerationAtStart) {
                emit DisburseHolderIneligibleThisRound(holder, holderGen, roundGenerationAtStart);
                continue;
            }
            uint256 bal = platformToken.balanceOf(holder);
            if (bal == 0) continue;
            uint256 share = (roundAmount * bal) / roundSupplyAtStart;
            // Never beyond the round's own pot, whatever balances did mid-round.
            if (share > remaining) share = remaining;
            if (share == 0) continue;
            remaining -= share;
            roundUsed += share;
            if (_sendPlatformToken(holder, share)) {
                paidThisBatch += share;
            } else {
                pendingDisburseTokens += share;
                emit DisbursePayoutSkipped(holder, share);
            }
        }

        roundCursor = to;
        roundDistributed += paidThisBatch;
        emit DisburseRoundProgress(to, paidThisBatch);

        if (to >= total) {
            roundActive = false;
            emit DisburseRoundFinished(roundDistributed);
        }
    }

    function _sendPlatformToken(address to, uint256 amount) private returns (bool) {
        try platformToken.transfer(to, amount) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------------
    // Rescue (same scoping as the V2 file's PTD-4 fix)
    // ---------------------------------------------------------------

    function rescueEth(address to) external onlyOwner nonReentrant returns (uint256 amount) {
        require(to != address(0), "V4PlatformTaxDistributor: invalid recipient");
        amount = address(this).balance;
        require(amount > 0, "V4PlatformTaxDistributor: nothing to rescue");
        (bool sent,) = payable(to).call{value: amount}("");
        require(sent, "V4PlatformTaxDistributor: ETH rescue failed");
        emit EthRescued(to, amount);
    }

    /// @notice platformToken already earmarked for holders (pending + the
    /// unpaid rest of the active round) can never be rescued; anything above that,
    /// and any other token, can.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "V4PlatformTaxDistributor: invalid recipient");
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (token == address(platformToken)) {
            uint256 committed = pendingDisburseTokens + (roundActive ? roundAmount - roundUsed : 0);
            uint256 rescuable = balance > committed ? balance - committed : 0;
            require(amount <= rescuable, "V4PlatformTaxDistributor: exceeds rescuable balance");
        } else {
            require(amount <= balance, "V4PlatformTaxDistributor: exceeds balance");
        }
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }
}
