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
/// Changed from V2 (see the audit report): the SALE is no longer open to
/// everyone. The pool's price limit is measured from the pool's current price,
/// so a caller who first pushes the price down in the same transaction, then
/// triggers the sale with minEthOut = 0, then buys back, makes the distributor
/// sell at the manipulated price and keeps the difference. Converting is
/// therefore limited to the owner, owner-approved keepers (the relayer) and the
/// token's own creator, who always pass a real minEthOut. CLAIMING stays
/// permissionless and always pays only the token's creator.
///
/// Wiring: set this as the factory's creatorRewardsDistributor, and exempt it
/// from the hook's tax with V4TokenFactory.setTaxExempt(this, true).
contract V4CreatorRewardsDistributor is V4TokenSeller {
    using SafeERC20 for IERC20;

    /// @notice ETH owed to a token's creator, keyed by TOKEN address.
    mapping(address => uint256) public claimableEth;
    /// @notice Sum of every claimableEth entry; whatever ETH the contract holds
    /// above this is stray and can be returned by the owner.
    uint256 public totalClaimableEth;
    /// @dev Gas given to a creator when the permissionless claim pays them. Enough
    /// for a smart wallet's receive hook; stops a hostile creator contract from
    /// burning the keeper's gas on every attempt.
    uint256 private constant CLAIM_CALL_GAS = 100_000;
    mapping(address => uint256) public swapThreshold;
    /// @notice Anti-dump cap per call. 0 = uncapped.
    mapping(address => uint256) public maxSwapAmount;

    event SwapThresholdUpdated(address indexed token, uint256 newThreshold);
    event MaxSwapAmountUpdated(address indexed token, uint256 newMax);
    event CreatorSwapTriggered(address indexed token, address indexed creator, uint256 amountIn, uint256 ethOut);
    event CreatorRewardsClaimed(address indexed token, address indexed creator, address indexed caller, uint256 amount);
    event OrphanedEthRescued(address indexed token, address indexed to, uint256 amount);
    event OrphanedTokensRescued(address indexed token, address indexed to, uint256 amount);
    event CreatorRewardsClaimedTo(address indexed token, address indexed creator, address indexed to, uint256 amount);
    event StrayEthRescued(address indexed to, uint256 amount);
    event CreatorFeeDeposited(address indexed token, address indexed from, uint256 amount);
    event StrayTokensRescued(address indexed token, address indexed to, uint256 amount);

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
    /// the rest stays for the next call. Callable by the owner, an approved
    /// keeper, or the token's creator.
    function triggerCreatorSwap(address token, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        require(token != address(0), "V4CreatorRewardsDistributor: invalid token");
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0 && balance >= swapThreshold[token], "V4CreatorRewardsDistributor: below threshold");
        uint256 cap = maxSwapAmount[token];
        uint256 amountIn = (cap > 0 && balance > cap) ? cap : balance;

        address creator = V4ICreatorAware(token).creator();
        require(creator != address(0), "V4CreatorRewardsDistributor: token has no creator");
        require(msg.sender == creator || _isKeeper(msg.sender), "V4CreatorRewardsDistributor: not authorized to convert");

        uint256 spent;
        (spent, ethOut) = _sellForEth(token, amountIn, minEthOut);
        claimableEth[token] += ethOut;
        totalClaimableEth += ethOut;
        emit CreatorSwapTriggered(token, creator, spent, ethOut);
    }

    /// @notice Intake for the creator's share of fees that arrive as ETH: the
    /// bonding curve's per-trade fee. Credited to `token`'s creator exactly like
    /// ETH converted from in-kind rewards, and claimed the same way. Anyone may
    /// send ETH here; it can only ever be claimed by the token's creator.
    function depositFor(address token) external payable {
        require(token != address(0), "V4CreatorRewardsDistributor: invalid token");
        require(msg.value > 0, "V4CreatorRewardsDistributor: no ETH");
        claimableEth[token] += msg.value;
        totalClaimableEth += msg.value;
        emit CreatorFeeDeposited(token, msg.sender, msg.value);
    }

    /// @notice Pays claimableEth[token] to that token's own creator(). Anyone may
    /// call it (the money only ever goes to the creator). The payout is given a
    /// bounded amount of gas so a creator contract cannot burn the caller's gas;
    /// a creator that cannot receive ETH within it uses claimCreatorRewardsTo.
    function claimCreatorRewards(address token) external nonReentrant returns (uint256 amount) {
        address creator = V4ICreatorAware(token).creator();
        require(creator != address(0), "V4CreatorRewardsDistributor: token has no creator");
        amount = _takeClaimable(token);
        (bool sent,) = payable(creator).call{value: amount, gas: CLAIM_CALL_GAS}("");
        require(sent, "V4CreatorRewardsDistributor: ETH transfer failed");
        emit CreatorRewardsClaimed(token, creator, msg.sender, amount);
    }

    /// @notice Creator-only: pays claimableEth[token] to `to` instead of the
    /// creator's own address, for a creator contract that cannot receive ETH.
    function claimCreatorRewardsTo(address token, address to) external nonReentrant returns (uint256 amount) {
        address creator = V4ICreatorAware(token).creator();
        require(creator != address(0), "V4CreatorRewardsDistributor: token has no creator");
        require(msg.sender == creator, "V4CreatorRewardsDistributor: not the creator");
        require(to != address(0) && to != address(this), "V4CreatorRewardsDistributor: invalid recipient");
        amount = _takeClaimable(token);
        (bool sent,) = payable(to).call{value: amount}("");
        require(sent, "V4CreatorRewardsDistributor: ETH transfer failed");
        emit CreatorRewardsClaimedTo(token, creator, to, amount);
    }

    function _takeClaimable(address token) private returns (uint256 amount) {
        amount = claimableEth[token];
        require(amount > 0, "V4CreatorRewardsDistributor: nothing to claim");
        claimableEth[token] = 0;
        totalClaimableEth -= amount;
    }

    /// @notice Only once the token's creator has renounced (creator() == 0).
    function rescueOrphanedEth(address token, address to) external onlyOwner nonReentrant returns (uint256 amount) {
        require(to != address(0), "V4CreatorRewardsDistributor: invalid recipient");
        require(V4ICreatorAware(token).creator() == address(0), "V4CreatorRewardsDistributor: creator has not renounced");
        amount = claimableEth[token];
        require(amount > 0, "V4CreatorRewardsDistributor: nothing to rescue");
        claimableEth[token] = 0;
        totalClaimableEth -= amount;
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

    /// @notice Returns ETH that reached this contract by mistake (anything above
    /// what creators are owed). Never touches a creator's claimable balance.
    function rescueStrayEth(address to) external onlyOwner nonReentrant returns (uint256 amount) {
        require(to != address(0), "V4CreatorRewardsDistributor: invalid recipient");
        uint256 bal = address(this).balance;
        require(bal > totalClaimableEth, "V4CreatorRewardsDistributor: no stray ETH");
        amount = bal - totalClaimableEth;
        (bool sent,) = payable(to).call{value: amount}("");
        require(sent, "V4CreatorRewardsDistributor: ETH transfer failed");
        emit StrayEthRescued(to, amount);
    }

    /// @notice Returns a token that is NOT a platform token (one with no pool on
    /// the hook) sent here by mistake. A platform token's balance here is a
    /// creator's pending reward and can never be rescued this way.
    function rescueStrayTokens(address token, address to) external onlyOwner returns (uint256 amount) {
        require(to != address(0), "V4CreatorRewardsDistributor: invalid recipient");
        require(!_hasPool(token), "V4CreatorRewardsDistributor: platform token, not stray");
        amount = IERC20(token).balanceOf(address(this));
        require(amount > 0, "V4CreatorRewardsDistributor: nothing to rescue");
        IERC20(token).safeTransfer(to, amount);
        emit StrayTokensRescued(token, to, amount);
    }
}
