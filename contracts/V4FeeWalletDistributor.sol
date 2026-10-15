// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import "./V4PlatformTokenRewards.sol";

/// @title V4FeeWalletDistributor
/// @notice V4 counterpart of FeeWalletDistributor: receives the platform's own
/// remainder of the trading tax and pays it to the fee wallet. Today that
/// remainder is ETH: V4TaxHook's flush() (and V4CurveFactory's per-trade fee)
/// call depositFee(). With a buyback configured, half of it is earmarked for
/// buying PlatformToken and half is owed to the fee wallet; with none, all of it
/// is owed to the fee wallet. The older in-kind path is kept for fee tokens that
/// still arrive (an older pool's fees, or tokens sent by hand): they are
/// converted to ETH in each token's own V4 pool and booked the same way.
///
/// Once platformToken is set (and a V2 buyback router was provided), half of
/// the ETH is used to buy PlatformToken instead, split 50/50 burn / holder
/// airdrop, exactly the net effect of the V2 contract: of every unit of tax
/// reaching here, 50% is ETH for the fee wallet, 25% worth is burned and 25%
/// worth is airdropped. Differences from V2: one V4 sale per call instead of
/// two swaps, and the PlatformToken leg buys with ETH on the platform token's
/// own (V2) pool. The ETH arriving through depositFee is NOT bought back inside
/// the deposit (that would put a V2 swap with no price floor in every trade);
/// an owner or keeper runs triggerPendingBuyback with a floor.
///
/// Audit changes: only the owner and approved keepers (the relayer) may start a
/// conversion, so an outsider cannot bundle a price-manipulation sandwich around
/// it (claiming stays permissionless); the payout is gas-capped; ETH owed to the
/// fee wallet is tracked so stray ETH can be recovered; and a failed platform-
/// token buy no longer blocks the sale (that ETH is kept for the fee wallet).
///
/// Changes from the second audit pass (ETH fee flow):
///  FW-7 (Low, fixed): the permissionless claim copied whatever the fee wallet
///   answered with. The 100,000-gas cap limits what the wallet can burn, not the
///   cost of copying a large reply, so a wallet contract that answered with one
///   made each claim cost about three times the normal gas (191k against 63k
///   measured). The payout now ignores the reply, so the most a wallet can cost
///   its caller is the 100,000-gas allowance itself. (The wallet is chosen by the
///   owner, so this is a robustness fix, the same one made in
///   V4CreatorRewardsDistributor.)
///
/// Gas budget of depositFee, which V4TaxHook calls with at most 150,000 gas
/// (V4CurveFactory: 300,000): the costliest call is the first one, when every
/// counter is still zero and the buyback is on, about 116,000 gas inside the
/// call; later deposits cost about 50,000. A failed deposit is re-booked by the
/// hook and retried, so anything that pushes this near the cap must be re-measured.
///
/// Wiring: set as the factory's feeWalletDistributor. The exemption from the hook
/// tax (V4TokenFactory.setTaxExempt(this, true)) is only needed for the in-kind
/// conversion, which refuses to run without it.
contract V4FeeWalletDistributor is V4PlatformTokenRewards {
    address public feeWallet;

    /// @dev Gas forwarded to the fee wallet on payout.
    uint256 public constant CLAIM_CALL_GAS = 100_000;

    mapping(address => uint256) public claimableEth;
    /// @notice Sum of claimableEth over all tokens (ETH the fee wallet is owed).
    uint256 public totalClaimableEth;
    mapping(address => uint256) public swapThreshold;
    mapping(address => uint256) public maxSwapAmount;

    /// @notice ETH from curve-phase fees (see depositFee) earmarked for the
    /// platform-token buyback, run by an owner or keeper with a price floor.
    uint256 public pendingBuybackEth;

    // ---------------------------------------------------------------
    // Accounting: running totals of where every unit of fee went. Nothing
    // here moves money or gates anything; it only counts, so the books can be
    // read straight from the chain (accounting()) and checked against events.
    // ---------------------------------------------------------------

    /// @notice All-time totals. ETH in wei, tokens in PlatformToken units.
    struct Accounting {
        uint256 ethReceived;            // ETH deposited through depositFee (the hook's platform-fee payouts and curve fees)
        uint256 ethFromConversions;     // ETH produced by selling in-kind fee tokens (older pools)
        uint256 ethCreditedToFeeWallet; // ETH that became owed to the fee wallet (claimable)
        uint256 ethPaidToFeeWallet;     // ETH actually sent to the fee wallet by claims
        uint256 ethSpentOnBuyback;      // ETH spent buying PlatformToken
        uint256 ethBuybackFallback;     // memo, already inside ethCreditedToFeeWallet: ETH meant for the buyback that went to the fee wallet instead (buy failed or buyback off)
        uint256 platformTokensAcquired; // PlatformToken bought, plus fee tokens that already were PlatformToken
        uint256 platformTokensBurned;
        uint256 platformTokensQueuedForAirdrop;
    }
    Accounting private _acct;

    /// @notice The all-time totals plus the live balances that are still to be settled.
    /// `ethClaimable` is owed to the fee wallet now; `ethPendingBuyback` is earmarked for the next buyback run.
    function accounting()
        external
        view
        returns (Accounting memory totals, uint256 ethClaimable, uint256 ethPendingBuyback, uint256 platformTokensPendingAirdrop)
    {
        return (_acct, totalClaimableEth, pendingBuybackEth, pendingAirdropTokens);
    }

    /// @dev Splits and processes PlatformToken (50% burn / 50% airdrop queue) and books it.
    function _processPlatformTokens(uint256 amount) private {
        if (amount == 0) return;
        (uint256 burned, uint256 toAirdrop) = _splitAndProcess(amount);
        _acct.platformTokensBurned += burned;
        _acct.platformTokensQueuedForAirdrop += toAirdrop;
    }

    event FeeWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event SwapThresholdUpdated(address indexed token, uint256 newThreshold);
    event MaxSwapAmountUpdated(address indexed token, uint256 newMax);
    event FeeWalletSwapTriggered(address indexed token, uint256 amountIn, uint256 ethOut);
    event FeeWalletRewardsClaimed(address indexed token, address indexed feeWallet, address indexed caller, uint256 amount);
    event PlatformTokenBuybackTriggered(address indexed token, uint256 ethIn, uint256 tokensOut);
    event PlatformTokenBuybackFailed(address indexed token, uint256 ethKept);
    event StrayEthRescued(address indexed to, uint256 amount);
    event CurveFeeReceived(address indexed from, uint256 amount, uint256 creditedToFeeWallet, uint256 earmarkedForBuyback);
    event PendingBuybackRun(uint256 ethIn, uint256 platformTokensOut);
    event PendingBuybackFailed(uint256 ethKept);

    constructor(IPoolManager poolManager_, address hook_, address initialOwner_, address buybackRouter_, address feeWallet_)
        V4PlatformTokenRewards(poolManager_, hook_, initialOwner_, buybackRouter_)
    {
        feeWallet = feeWallet_;
        emit FeeWalletUpdated(address(0), feeWallet_);
    }

    function setFeeWallet(address newWallet) external onlyOwner {
        require(newWallet != address(this), "V4FeeWalletDistributor: invalid fee wallet");
        emit FeeWalletUpdated(feeWallet, newWallet);
        feeWallet = newWallet;
    }

    function setSwapThreshold(address token, uint256 newThreshold) external onlyOwner {
        swapThreshold[token] = newThreshold;
        emit SwapThresholdUpdated(token, newThreshold);
    }

    function setMaxSwapAmount(address token, uint256 newMax) external onlyOwner {
        maxSwapAmount[token] = newMax;
        emit MaxSwapAmountUpdated(token, newMax);
    }

    /// @notice Converts up to maxSwapAmount[token] of the fee token to ETH. Owner
    /// and approved keepers only (claiming is open to everyone).
    function triggerFeeWalletSwap(address token, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        return _trigger(token, minEthOut, 0);
    }

    /// @notice Same, with a caller-side minimum for the PlatformToken leg.
    function triggerFeeWalletSwap(address token, uint256 minEthOut, uint256 minPlatformTokensOut)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        return _trigger(token, minEthOut, minPlatformTokensOut);
    }

    /// @dev `minEthOut` applies to the whole V4 sale (before the ETH is split
    /// between the fee wallet and the buyback). Returns the ETH credited to the
    /// fee wallet's claimable balance. If the platform-token buy fails and the
    /// caller set no minimum for it, that half stays with the fee wallet.
    function _trigger(address token, uint256 minEthOut, uint256 minPlatformTokensOut) private returns (uint256 credited) {
        require(_isKeeper(msg.sender), "V4FeeWalletDistributor: not authorized to convert");
        require(token != address(0), "V4FeeWalletDistributor: invalid token");
        // PlatformToken already earmarked for holders is not income.
        uint256 balance = _availableBalance(token);
        require(balance > 0 && balance >= swapThreshold[token], "V4FeeWalletDistributor: below threshold");
        uint256 cap = maxSwapAmount[token];
        uint256 amountIn = (cap > 0 && balance > cap) ? cap : balance;

        bool buyback = _buybackEnabled();
        bool isPlatform = buyback && token == address(platformToken);
        if (isPlatform) {
            // The fee token IS PlatformToken: half goes straight to burn/airdrop.
            uint256 directAmount = amountIn / 2;
            amountIn -= directAmount;
            _acct.platformTokensAcquired += directAmount;
            _processPlatformTokens(directAmount);
        }

        if (amountIn > 0) {
            (uint256 spent, uint256 ethOut) = _sellForEth(token, amountIn, minEthOut);
            _acct.ethFromConversions += ethOut;
            uint256 toBuyback = (buyback && !isPlatform) ? ethOut / 2 : 0;
            credited = ethOut - toBuyback;
            if (toBuyback > 0) {
                bool ok;
                uint256 tokensOut;
                if (minPlatformTokensOut > 0) {
                    // The caller asked for a floor: honour it with a revert.
                    tokensOut = _buyPlatformToken(toBuyback, minPlatformTokensOut);
                    ok = true;
                } else {
                    (ok, tokensOut) = _tryBuyPlatformToken(toBuyback, 0);
                }
                if (ok) {
                    _acct.ethSpentOnBuyback += toBuyback;
                    _acct.platformTokensAcquired += tokensOut;
                    _processPlatformTokens(tokensOut);
                    emit PlatformTokenBuybackTriggered(token, toBuyback, tokensOut);
                } else {
                    credited += toBuyback; // keep the ETH for the fee wallet
                    _acct.ethBuybackFallback += toBuyback;
                    emit PlatformTokenBuybackFailed(token, toBuyback);
                }
            }
            claimableEth[token] += credited;
            totalClaimableEth += credited;
            _acct.ethCreditedToFeeWallet += credited;
            emit FeeWalletSwapTriggered(token, spent, credited);
        }
    }

    /// @notice Intake for fees that arrive as ETH rather than in kind: the
    /// bonding curve's per-trade fee. Same split as the in-kind fee: half is
    /// owed to the fee wallet (claimableEth[address(0)], paid by
    /// claimFeeWalletRewards(address(0))), half is earmarked for buying
    /// PlatformToken (burn / holder airdrop). The buyback is NOT run here: it
    /// would put a V2 swap, with no price floor, inside every curve trade.
    /// An owner or keeper runs it with triggerPendingBuyback. With no buyback
    /// configured the whole amount is owed to the fee wallet. Anyone may send ETH
    /// here; it is only ever distributed this way.
    function depositFee() external payable {
        require(msg.value > 0, "V4FeeWalletDistributor: no ETH");
        uint256 toBuyback = _buybackEnabled() ? msg.value / 2 : 0;
        uint256 credited = msg.value - toBuyback;
        pendingBuybackEth += toBuyback;
        claimableEth[address(0)] += credited;
        totalClaimableEth += credited;
        _acct.ethReceived += msg.value;
        _acct.ethCreditedToFeeWallet += credited;
        emit CurveFeeReceived(msg.sender, msg.value, credited, toBuyback);
    }

    /// @notice Owner and approved keepers: spends up to `ethIn` (0 = all) of the
    /// earmarked ETH on PlatformToken, 50% burned and 50% queued for holders. If
    /// buying back has since been switched off, or the buy fails and the caller
    /// set no floor, the ETH is owed to the fee wallet instead.
    function triggerPendingBuyback(uint256 ethIn, uint256 minPlatformTokensOut)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        require(_isKeeper(msg.sender), "V4FeeWalletDistributor: not authorized to convert");
        uint256 amount = (ethIn == 0 || ethIn > pendingBuybackEth) ? pendingBuybackEth : ethIn;
        require(amount > 0, "V4FeeWalletDistributor: nothing earmarked");
        pendingBuybackEth -= amount;
        bool ok;
        if (!_buybackEnabled()) {
            ok = false;
        } else if (minPlatformTokensOut > 0) {
            tokensOut = _buyPlatformToken(amount, minPlatformTokensOut);
            ok = true;
        } else {
            (ok, tokensOut) = _tryBuyPlatformToken(amount, 0);
        }
        if (ok) {
            _acct.ethSpentOnBuyback += amount;
            _acct.platformTokensAcquired += tokensOut;
            _processPlatformTokens(tokensOut);
            emit PendingBuybackRun(amount, tokensOut);
        } else {
            claimableEth[address(0)] += amount;
            totalClaimableEth += amount;
            _acct.ethCreditedToFeeWallet += amount;
            _acct.ethBuybackFallback += amount;
            emit PendingBuybackFailed(amount);
        }
    }

    /// @notice Pays claimableEth[token] to the fee wallet as set at call time.
    /// token == address(0) is the ETH-sourced (curve fee) balance.
    function claimFeeWalletRewards(address token) external nonReentrant returns (uint256 amount) {
        address recipient = feeWallet;
        require(recipient != address(0), "V4FeeWalletDistributor: fee wallet not set");
        amount = claimableEth[token];
        require(amount > 0, "V4FeeWalletDistributor: nothing to claim");
        claimableEth[token] = 0;
        totalClaimableEth -= amount;
        _acct.ethPaidToFeeWallet += amount;
        // FW-7: a bare call that never copies the reply (a wallet contract could otherwise make the caller pay to
        // copy a large one, which the gas cap does not bound).
        uint256 callGas = CLAIM_CALL_GAS;
        bool sent;
        assembly {
            sent := call(callGas, recipient, amount, 0, 0, 0, 0)
        }
        require(sent, "V4FeeWalletDistributor: ETH transfer failed");
        emit FeeWalletRewardsClaimed(token, recipient, msg.sender, amount);
    }

    /// @notice Sends ETH that is not owed to the fee wallet (sent here by mistake,
    /// or forced in) to `to`. Never touches claimableEth.
    function rescueStrayEth(address to) external onlyOwner nonReentrant returns (uint256 amount) {
        require(to != address(0), "V4FeeWalletDistributor: invalid recipient");
        uint256 bal = address(this).balance;
        uint256 owed = totalClaimableEth + pendingBuybackEth;
        amount = bal > owed ? bal - owed : 0;
        require(amount > 0, "V4FeeWalletDistributor: no stray ETH");
        (bool sent,) = payable(to).call{value: amount}("");
        require(sent, "V4FeeWalletDistributor: ETH rescue failed");
        emit StrayEthRescued(to, amount);
    }
}
