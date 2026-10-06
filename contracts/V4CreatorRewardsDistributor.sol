// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import "./V4TokenSeller.sol";
import "./interfaces/V4ICreatorAware.sol";

/// @title V4CreatorRewardsDistributor
/// @notice V4 counterpart of CreatorRewardsDistributor. Where the creator-reward
/// slice of the trading tax lands: V4TaxHook pushes it here in kind (the
/// launched token itself). Per token, anyone can convert the accumulated
/// balance to ETH (sold into that token's own V4 pool, see V4TokenSeller) and
/// anyone can pay the proceeds out to that token's creator.
///
/// Unchanged from V2: per-token (not per-creator) claimable balances, the
/// swapThreshold / maxSwapAmount knobs, the 5-8% slippage band, creator read
/// live from the token at swap and claim time, and the orphaned-balance rescue
/// once a creator has renounced.
///
/// Wiring: set this as the factory's creatorRewardsDistributor, and exempt it
/// from the hook's tax with V4TokenFactory.setTaxExempt(this, true).
contract V4CreatorRewardsDistributor is V4TokenSeller {
    using SafeERC20 for IERC20;

    /// @notice ETH owed to a token's creator, keyed by TOKEN address.
    mapping(address => uint256) public claimableEth;
    mapping(address => uint256) public swapThreshold;
    /// @notice Anti-dump cap per call. 0 = uncapped.
    mapping(address => uint256) public maxSwapAmount;

    event SwapThresholdUpdated(address indexed token, uint256 newThreshold);
    event MaxSwapAmountUpdated(address indexed token, uint256 newMax);
    event CreatorSwapTriggered(address indexed token, address indexed creator, uint256 amountIn, uint256 ethOut);
    event CreatorRewardsClaimed(address indexed token, address indexed creator, address indexed caller, uint256 amount);
    event OrphanedEthRescued(address indexed token, address indexed to, uint256 amount);
    event OrphanedTokensRescued(address indexed token, address indexed to, uint256 amount);

    constructor(IPoolManager poolManager_, address hook_, address initialOwner_)
        V4TokenSeller(poolManager_, hook_, initialOwner_)
    {}

    function setSwapThreshold(address token, uint256 newThreshold) external onlyOwner {
        swapThreshold[token] = newThreshold;
        emit SwapThresholdUpdated(token, newThreshold);
    }

    function setMaxSwapAmount(address token, uint256 newMax) external onlyOwner {
        maxSwapAmount[token] = newMax;
        emit MaxSwapAmountUpdated(token, newMax);
    }

    /// @notice Sells up to maxSwapAmount[token] (all, if uncapped) of this
    /// contract's `token` balance for ETH and credits it to that token's
    /// creator. May sell less than asked if the pool's price limit is reached;
    /// the rest stays for the next call. Permissionless.
    function triggerCreatorSwap(address token, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        require(token != address(0), "V4CreatorRewardsDistributor: invalid token");
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0 && balance >= swapThreshold[token], "V4CreatorRewardsDistributor: below threshold");
        uint256 cap = maxSwapAmount[token];
        uint256 amountIn = (cap > 0 && balance > cap) ? cap : balance;

        address creator = V4ICreatorAware(token).creator();
        require(creator != address(0), "V4CreatorRewardsDistributor: token has no creator");

        uint256 spent;
        (spent, ethOut) = _sellForEth(token, amountIn, minEthOut);
        claimableEth[token] += ethOut;
        emit CreatorSwapTriggered(token, creator, spent, ethOut);
    }

    /// @notice Pays claimableEth[token] to that token's own creator().
    function claimCreatorRewards(address token) external nonReentrant returns (uint256 amount) {
        address creator = V4ICreatorAware(token).creator();
        require(creator != address(0), "V4CreatorRewardsDistributor: token has no creator");
        amount = claimableEth[token];
        require(amount > 0, "V4CreatorRewardsDistributor: nothing to claim");
        claimableEth[token] = 0;
        (bool sent,) = payable(creator).call{value: amount}("");
        require(sent, "V4CreatorRewardsDistributor: ETH transfer failed");
        emit CreatorRewardsClaimed(token, creator, msg.sender, amount);
    }

    /// @notice Only once the token's creator has renounced (creator() == 0).
    function rescueOrphanedEth(address token, address to) external onlyOwner nonReentrant returns (uint256 amount) {
        require(to != address(0), "V4CreatorRewardsDistributor: invalid recipient");
        require(V4ICreatorAware(token).creator() == address(0), "V4CreatorRewardsDistributor: creator has not renounced");
        amount = claimableEth[token];
        require(amount > 0, "V4CreatorRewardsDistributor: nothing to rescue");
        claimableEth[token] = 0;
        (bool sent,) = payable(to).call{value: amount}("");
        require(sent, "V4CreatorRewardsDistributor: ETH transfer failed");
        emit OrphanedEthRescued(token, to, amount);
    }

    /// @notice Only once the token's creator has renounced.
    function rescueOrphanedTokens(address token, address to) external onlyOwner returns (uint256 amount) {
        require(to != address(0), "V4CreatorRewardsDistributor: invalid recipient");
        require(V4ICreatorAware(token).creator() == address(0), "V4CreatorRewardsDistributor: creator has not renounced");
        amount = IERC20(token).balanceOf(address(this));
        require(amount > 0, "V4CreatorRewardsDistributor: nothing to rescue");
        IERC20(token).safeTransfer(to, amount);
        emit OrphanedTokensRescued(token, to, amount);
    }
}
