// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import "./V4PlatformTokenRewards.sol";

/// @title V4FeeWalletDistributor
/// @notice V4 counterpart of FeeWalletDistributor: receives the platform's own
/// remainder of the trading tax in kind (V4TaxHook pushes it here), converts
/// it to ETH in each token's own V4 pool and pays it to the fee wallet.
///
/// Once platformToken is set (and a V2 buyback router was provided), half of
/// each conversion's ETH is used to buy PlatformToken instead, split 50/50
/// burn / holder airdrop, exactly the net effect of the V2 contract: of every
/// unit of tax reaching here, 50% is ETH for the fee wallet, 25% worth is
/// burned and 25% worth is airdropped. Differences from V2: one V4 sale per
/// call instead of two swaps, and the PlatformToken leg buys with ETH on the
/// platform token's own (V2) pool.
///
/// Audit changes: only the owner and approved keepers (the relayer) may start a
/// conversion, so an outsider cannot bundle a price-manipulation sandwich around
/// it (claiming stays permissionless); the payout is gas-capped; ETH owed to the
/// fee wallet is tracked so stray ETH can be recovered; and a failed platform-
/// token buy no longer blocks the sale (that ETH is kept for the fee wallet).
///
/// Wiring: set as the factory's feeWalletDistributor, then exempt it from the
/// hook tax with V4TokenFactory.setTaxExempt(this, true).
contract V4FeeWalletDistributor is V4PlatformTokenRewards {
    address public feeWallet;

    /// @dev Gas forwarded to the fee wallet on payout.
    uint256 public constant CLAIM_CALL_GAS = 100_000;

    mapping(address => uint256) public claimableEth;
    /// @notice Sum of claimableEth over all tokens (ETH the fee wallet is owed).
    uint256 public totalClaimableEth;
    mapping(address => uint256) public swapThreshold;
    mapping(address => uint256) public maxSwapAmount;

    event FeeWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event SwapThresholdUpdated(address indexed token, uint256 newThreshold);
    event MaxSwapAmountUpdated(address indexed token, uint256 newMax);
    event FeeWalletSwapTriggered(address indexed token, uint256 amountIn, uint256 ethOut);
    event FeeWalletRewardsClaimed(address indexed token, address indexed feeWallet, address indexed caller, uint256 amount);
    event PlatformTokenBuybackTriggered(address indexed token, uint256 ethIn, uint256 tokensOut);
    event PlatformTokenBuybackFailed(address indexed token, uint256 ethKept);
    event StrayEthRescued(address indexed to, uint256 amount);

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
            _splitAndProcess(directAmount);
        }

        if (amountIn > 0) {
            (uint256 spent, uint256 ethOut) = _sellForEth(token, amountIn, minEthOut);
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
                    _splitAndProcess(tokensOut);
                    emit PlatformTokenBuybackTriggered(token, toBuyback, tokensOut);
                } else {
                    credited += toBuyback; // keep the ETH for the fee wallet
                    emit PlatformTokenBuybackFailed(token, toBuyback);
                }
            }
            claimableEth[token] += credited;
            totalClaimableEth += credited;
            emit FeeWalletSwapTriggered(token, spent, credited);
        }
    }

    /// @notice Pays claimableEth[token] to the fee wallet as set at call time.
    function claimFeeWalletRewards(address token) external nonReentrant returns (uint256 amount) {
        address recipient = feeWallet;
        require(recipient != address(0), "V4FeeWalletDistributor: fee wallet not set");
        amount = claimableEth[token];
        require(amount > 0, "V4FeeWalletDistributor: nothing to claim");
        claimableEth[token] = 0;
        totalClaimableEth -= amount;
        (bool sent,) = payable(recipient).call{value: amount, gas: CLAIM_CALL_GAS}("");
        require(sent, "V4FeeWalletDistributor: ETH transfer failed");
        emit FeeWalletRewardsClaimed(token, recipient, msg.sender, amount);
    }

    /// @notice Sends ETH that is not owed to the fee wallet (sent here by mistake,
    /// or forced in) to `to`. Never touches claimableEth.
    function rescueStrayEth(address to) external onlyOwner nonReentrant returns (uint256 amount) {
        require(to != address(0), "V4FeeWalletDistributor: invalid recipient");
        uint256 bal = address(this).balance;
        amount = bal > totalClaimableEth ? bal - totalClaimableEth : 0;
        require(amount > 0, "V4FeeWalletDistributor: no stray ETH");
        (bool sent,) = payable(to).call{value: amount}("");
        require(sent, "V4FeeWalletDistributor: ETH rescue failed");
        emit StrayEthRescued(to, amount);
    }
}
