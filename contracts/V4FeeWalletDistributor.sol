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
/// Wiring: set as the factory's feeWalletDistributor, then exempt it from the
/// hook tax with V4TokenFactory.setTaxExempt(this, true).
contract V4FeeWalletDistributor is V4PlatformTokenRewards {
    address public feeWallet;

    mapping(address => uint256) public claimableEth;
    mapping(address => uint256) public swapThreshold;
    mapping(address => uint256) public maxSwapAmount;

    event FeeWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event SwapThresholdUpdated(address indexed token, uint256 newThreshold);
    event MaxSwapAmountUpdated(address indexed token, uint256 newMax);
    event FeeWalletSwapTriggered(address indexed token, uint256 amountIn, uint256 ethOut);
    event FeeWalletRewardsClaimed(address indexed token, address indexed feeWallet, address indexed caller, uint256 amount);
    event PlatformTokenBuybackTriggered(address indexed token, uint256 ethIn, uint256 tokensOut);

    constructor(IPoolManager poolManager_, address hook_, address initialOwner_, address buybackRouter_, address feeWallet_)
        V4PlatformTokenRewards(poolManager_, hook_, initialOwner_, buybackRouter_)
    {
        feeWallet = feeWallet_;
        emit FeeWalletUpdated(address(0), feeWallet_);
    }

    function setFeeWallet(address newWallet) external onlyOwner {
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
    /// fee wallet's claimable balance.
    function _trigger(address token, uint256 minEthOut, uint256 minPlatformTokensOut) private returns (uint256 credited) {
        require(token != address(0), "V4FeeWalletDistributor: invalid token");
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0 && balance >= swapThreshold[token], "V4FeeWalletDistributor: below threshold");
        uint256 cap = maxSwapAmount[token];
        uint256 amountIn = (cap > 0 && balance > cap) ? cap : balance;

        bool buyback = _buybackEnabled();
        uint256 directAmount;
        if (buyback && token == address(platformToken)) {
            // The fee token IS PlatformToken: half goes straight to burn/airdrop.
            directAmount = amountIn / 2;
            amountIn -= directAmount;
            _splitAndProcess(directAmount);
        }

        if (amountIn > 0) {
            (uint256 spent, uint256 ethOut) = _sellForEth(token, amountIn, minEthOut);
            uint256 toBuyback = (buyback && directAmount == 0) ? ethOut / 2 : 0;
            credited = ethOut - toBuyback;
            claimableEth[token] += credited;
            emit FeeWalletSwapTriggered(token, spent, credited);
            if (toBuyback > 0) {
                uint256 tokensOut = _buyPlatformToken(toBuyback, minPlatformTokensOut);
                _splitAndProcess(tokensOut);
                emit PlatformTokenBuybackTriggered(token, toBuyback, tokensOut);
            }
        }
    }

    /// @notice Pays claimableEth[token] to the fee wallet as set at call time.
    function claimFeeWalletRewards(address token) external nonReentrant returns (uint256 amount) {
        address recipient = feeWallet;
        require(recipient != address(0), "V4FeeWalletDistributor: fee wallet not set");
        amount = claimableEth[token];
        require(amount > 0, "V4FeeWalletDistributor: nothing to claim");
        claimableEth[token] = 0;
        (bool sent,) = payable(recipient).call{value: amount}("");
        require(sent, "V4FeeWalletDistributor: ETH transfer failed");
        emit FeeWalletRewardsClaimed(token, recipient, msg.sender, amount);
    }
}
