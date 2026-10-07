// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import "./V4PlatformTokenRewards.sol";

/// @title V4PlatformRewardsDistributor
/// @notice V4 counterpart of PlatformRewardsDistributor. Everything it
/// receives ends up as PlatformToken that is 50% burned and 50% airdropped to
/// PlatformToken holders:
///  - ETH (the V4 factory's 50% launch-fee share, plain transfers) is spent on
///    PlatformToken by triggerEthBuyback;
///  - launched tokens (its reward-diversion cut of the trading tax, pushed in
///    kind by V4TaxHook) are sold into their own V4 pool by
///    triggerTokenBuyback and the ETH is spent on PlatformToken in the same
///    call.
/// ETH -> PlatformToken uses the Uniswap V2 router passed at construction (the
/// pool PlatformToken trades on). With no router (address(0)) nothing is
/// bought back and funds simply accumulate.
///
/// Audit changes: only the owner and approved keepers (the relayer) may start a
/// buyback, so an outsider cannot bundle a price-manipulation sandwich around
/// it (airdrop rounds stay permissionless); and a failed PlatformToken buy no
/// longer blocks the conversion of a launched token (the ETH waits here for the
/// next triggerEthBuyback) unless the caller asked for a minimum.
///
/// Wiring: set as the factory's rewardsDistributor, then exempt it from the hook
/// tax with V4TokenFactory.setTaxExempt(this, true).
contract V4PlatformRewardsDistributor is V4PlatformTokenRewards {
    uint256 public ethBuybackThreshold;
    mapping(address => uint256) public tokenBuybackThreshold;
    /// @notice Anti-pump cap per call on the ETH side. 0 = uncapped.
    uint256 public maxEthBuybackAmount;
    /// @notice Anti-dump cap per call per input token. 0 = uncapped.
    mapping(address => uint256) public maxTokenBuybackAmount;

    event EthBuybackThresholdUpdated(uint256 newThreshold);
    event TokenBuybackThresholdUpdated(address indexed token, uint256 newThreshold);
    event MaxEthBuybackAmountUpdated(uint256 newMax);
    event MaxTokenBuybackAmountUpdated(address indexed token, uint256 newMax);
    event EthBuybackTriggered(uint256 ethIn, uint256 tokensOut);
    event TokenBuybackTriggered(address indexed token, uint256 amountIn, uint256 ethOut, uint256 tokensOut);
    event EthRescued(address indexed to, uint256 amount);
    event PlatformTokenBuybackFailed(address indexed token, uint256 ethKept);

    constructor(IPoolManager poolManager_, address hook_, address initialOwner_, address buybackRouter_)
        V4PlatformTokenRewards(poolManager_, hook_, initialOwner_, buybackRouter_)
    {}

    function setEthBuybackThreshold(uint256 newThreshold) external onlyOwner {
        ethBuybackThreshold = newThreshold;
        emit EthBuybackThresholdUpdated(newThreshold);
    }

    function setTokenBuybackThreshold(address token, uint256 newThreshold) external onlyOwner {
        tokenBuybackThreshold[token] = newThreshold;
        emit TokenBuybackThresholdUpdated(token, newThreshold);
    }

    function setMaxEthBuybackAmount(uint256 newMax) external onlyOwner {
        maxEthBuybackAmount = newMax;
        emit MaxEthBuybackAmountUpdated(newMax);
    }

    function setMaxTokenBuybackAmount(address token, uint256 newMax) external onlyOwner {
        maxTokenBuybackAmount[token] = newMax;
        emit MaxTokenBuybackAmountUpdated(token, newMax);
    }

    /// @notice Spends up to maxEthBuybackAmount of this contract's ETH on
    /// PlatformToken and splits the result 50/50 burn / airdrop. Owner and
    /// approved keepers only.
    function triggerEthBuyback(uint256 minTokensOut) external nonReentrant returns (uint256 tokensOut) {
        require(_isKeeper(msg.sender), "V4PlatformRewardsDistributor: not authorized to convert");
        require(_buybackEnabled(), "V4PlatformRewardsDistributor: buyback not available");
        uint256 balance = address(this).balance;
        require(balance > 0 && balance >= ethBuybackThreshold, "V4PlatformRewardsDistributor: below threshold");
        uint256 cap = maxEthBuybackAmount;
        uint256 ethIn = (cap > 0 && balance > cap) ? cap : balance;

        tokensOut = _buyPlatformToken(ethIn, minTokensOut);
        _splitAndProcess(tokensOut);
        emit EthBuybackTriggered(ethIn, tokensOut);
    }

    /// @notice Sells up to maxTokenBuybackAmount[token] of `token` into its V4
    /// pool and spends the ETH on PlatformToken, split 50/50. If `token` is
    /// PlatformToken itself it is processed directly (no swap, uncapped). Owner
    /// and approved keepers only. `minTokensOut` floors the PlatformToken received
    /// for the whole sale-and-buy; if the buy fails and it is 0, the sale's ETH
    /// stays here for the next triggerEthBuyback instead of reverting.
    function triggerTokenBuyback(address token, uint256 minTokensOut) external nonReentrant returns (uint256 tokensOut) {
        require(_isKeeper(msg.sender), "V4PlatformRewardsDistributor: not authorized to convert");
        require(_buybackEnabled(), "V4PlatformRewardsDistributor: buyback not available");
        require(token != address(0), "V4PlatformRewardsDistributor: invalid token");

        // Platform tokens already earmarked for holders are not income.
        uint256 balance = _availableBalance(token);
        require(balance > 0 && balance >= tokenBuybackThreshold[token], "V4PlatformRewardsDistributor: below threshold");

        if (token == address(platformToken)) {
            _splitAndProcess(balance);
            return balance;
        }

        uint256 cap = maxTokenBuybackAmount[token];
        uint256 amountIn = (cap > 0 && balance > cap) ? cap : balance;

        (uint256 spent, uint256 ethOut) = _sellForEth(token, amountIn, 0);
        bool ok = true;
        if (minTokensOut > 0) {
            tokensOut = _buyPlatformToken(ethOut, minTokensOut); // caller's floor: revert on failure
        } else {
            (ok, tokensOut) = _tryBuyPlatformToken(ethOut, 0);
        }
        if (ok) {
            _splitAndProcess(tokensOut);
            emit TokenBuybackTriggered(token, spent, ethOut, tokensOut);
        } else {
            emit PlatformTokenBuybackFailed(token, ethOut); // the ETH stays for triggerEthBuyback
        }
    }

    /// @notice Sweeps ETH (always plain platform revenue here).
    function rescueEth(address to) external onlyOwner nonReentrant returns (uint256 amount) {
        require(to != address(0), "V4PlatformRewardsDistributor: invalid recipient");
        amount = address(this).balance;
        require(amount > 0, "V4PlatformRewardsDistributor: nothing to rescue");
        (bool sent,) = payable(to).call{value: amount}("");
        require(sent, "V4PlatformRewardsDistributor: ETH rescue failed");
        emit EthRescued(to, amount);
    }
}
