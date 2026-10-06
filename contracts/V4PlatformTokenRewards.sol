// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import "./V4TokenSeller.sol";
import "./interfaces/V4IPlatformToken.sol";
import "./interfaces/V4IUniswapV2Router.sol";

/// @title V4PlatformTokenRewards
/// @notice The buyback / burn / holder-airdrop machinery shared by
/// V4PlatformRewardsDistributor and V4FeeWalletDistributor. Ported from the V2
/// PlatformRewardsDistributor including its audit fixes (PR-1 try/catch
/// payouts, PR-2 slippage floor, PR-3 approve-to-zero, PR-4 rescue limits,
/// PR-5 holder-generation guard). Same fixed split: every unit of PlatformToken
/// bought back is 50% burned and 50% queued for the next airdrop round.
///
/// What changes on V4: launched tokens are converted to ETH in their own V4
/// pool (V4TokenSeller). PlatformToken itself still trades wherever it trades,
/// so ETH -> PlatformToken goes through a Uniswap V2 router that is passed in
/// at construction. address(0) disables the buyback (ETH/in-kind tokens simply
/// accumulate), which is the right setting if PlatformToken has no V2 pool.
abstract contract V4PlatformTokenRewards is V4TokenSeller {
    using SafeERC20 for IERC20;

    /// @notice Router for ETH -> PlatformToken. address(0) = buyback disabled.
    V4IUniswapV2Router public immutable buybackRouter;

    V4IPlatformToken public platformToken;

    uint256 public pendingAirdropTokens;
    bool public roundActive;
    uint256 public roundAmount;
    uint256 public roundSupplySnapshot;
    uint256 public roundCursor;
    uint256 public roundHolderCountAtStart;
    uint256 public roundGenerationAtStart;

    event PlatformTokenSet(address indexed newToken);
    event PlatformTokensProcessed(uint256 tokensIn, uint256 burned, uint256 toAirdrop);
    event AirdropRoundStarted(uint256 amount, uint256 supplySnapshot, uint256 holderCountAtStart);
    event AirdropBatchProcessed(uint256 fromIndex, uint256 toIndex, uint256 amountDistributed);
    event AirdropPayoutSkipped(address indexed holder, uint256 amount);
    event AirdropHolderIneligibleThisRound(address indexed holder, uint256 holderGeneration, uint256 roundGeneration);
    event AirdropRoundCompleted(uint256 totalDistributed);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    constructor(IPoolManager poolManager_, address hook_, address initialOwner_, address buybackRouter_)
        V4TokenSeller(poolManager_, hook_, initialOwner_)
    {
        buybackRouter = V4IUniswapV2Router(buybackRouter_);
    }

    /// @notice Blocked while a round is active or tokens are queued: swapping
    /// the token would orphan those balances.
    function setPlatformToken(address newToken) external onlyOwner {
        require(!roundActive, "V4PlatformTokenRewards: round in progress");
        require(pendingAirdropTokens == 0, "V4PlatformTokenRewards: pending airdrop must clear first");
        require(newToken == address(0) || address(buybackRouter) != address(0), "V4PlatformTokenRewards: no buyback router");
        platformToken = V4IPlatformToken(newToken);
        emit PlatformTokenSet(newToken);
    }

    /// @dev True when buying back is actually possible.
    function _buybackEnabled() internal view returns (bool) {
        return address(platformToken) != address(0) && address(buybackRouter) != address(0);
    }

    /// @dev Spends `ethIn` buying PlatformToken on the V2 pool. The floor is
    /// the router's own quote less swapSlippageBps (0 if it can't quote, same
    /// degradation as V2); the caller's minimum wins when stricter. Returns the
    /// PlatformToken received (still held here, not yet split).
    function _buyPlatformToken(uint256 ethIn, uint256 callerMinOut) internal returns (uint256 tokensOut) {
        address[] memory path = new address[](2);
        path[0] = buybackRouter.WETH();
        path[1] = address(platformToken);

        uint256 floor;
        try buybackRouter.getAmountsOut(ethIn, path) returns (uint256[] memory amounts) {
            uint256 quoted = amounts[amounts.length - 1];
            floor = quoted - (quoted * swapSlippageBps) / 10_000;
        } catch {}
        uint256 minOut = callerMinOut > floor ? callerMinOut : floor;

        uint256 before = platformToken.balanceOf(address(this));
        buybackRouter.swapExactETHForTokensSupportingFeeOnTransferTokens{value: ethIn}(
            minOut, path, address(this), block.timestamp + 15 minutes
        );
        tokensOut = platformToken.balanceOf(address(this)) - before;
    }

    /// @dev Fixed 50/50: burn now, queue the rest for the next round.
    function _splitAndProcess(uint256 amount) internal returns (uint256 burned, uint256 toAirdrop) {
        if (amount == 0) return (0, 0);
        burned = amount / 2;
        toAirdrop = amount - burned;
        if (burned > 0) platformToken.burn(burned);
        pendingAirdropTokens += toAirdrop;
        emit PlatformTokensProcessed(amount, burned, toAirdrop);
    }

    // ---------------------------------------------------------------
    // Airdrop rounds (permissionless, batch-driven)
    // ---------------------------------------------------------------

    function startAirdropRound() external nonReentrant {
        require(!roundActive, "V4PlatformTokenRewards: round already active");
        require(address(platformToken) != address(0), "V4PlatformTokenRewards: platform token not set");
        require(pendingAirdropTokens > 0, "V4PlatformTokenRewards: nothing to distribute");

        uint256 ownBalance = platformToken.balanceOf(address(this));
        uint256 supply = platformToken.totalSupply();
        uint256 supplySnapshot = supply > ownBalance ? supply - ownBalance : 0;
        require(supplySnapshot > 0, "V4PlatformTokenRewards: no eligible holders");

        roundAmount = pendingAirdropTokens;
        pendingAirdropTokens = 0;
        roundSupplySnapshot = supplySnapshot;
        roundCursor = 0;
        roundActive = true;

        uint256 holderCountAtStart = platformToken.holderCount();
        roundHolderCountAtStart = holderCountAtStart;
        roundGenerationAtStart = platformToken.holderGenerationCounter();

        emit AirdropRoundStarted(roundAmount, roundSupplySnapshot, holderCountAtStart);
    }

    function _sendPlatformToken(address to, uint256 amount) private returns (bool) {
        try platformToken.transfer(to, amount) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function processAirdropBatch(uint256 maxHolders) external nonReentrant {
        require(roundActive, "V4PlatformTokenRewards: no active round");
        require(maxHolders > 0, "V4PlatformTokenRewards: maxHolders must be > 0");

        uint256 liveHolderCount = platformToken.holderCount();
        uint256 total = liveHolderCount < roundHolderCountAtStart ? liveHolderCount : roundHolderCountAtStart;
        uint256 from = roundCursor;
        uint256 to = from + maxHolders;
        if (to > total) to = total;

        uint256 distributed;
        for (uint256 i = from; i < to; i++) {
            address holder = platformToken.holderAt(i);
            if (holder == address(this)) continue;
            uint256 holderGen = platformToken.holderGeneration(holder);
            if (holderGen > roundGenerationAtStart) {
                emit AirdropHolderIneligibleThisRound(holder, holderGen, roundGenerationAtStart);
                continue;
            }
            uint256 share = (roundAmount * platformToken.balanceOf(holder)) / roundSupplySnapshot;
            if (share == 0) continue;
            if (_sendPlatformToken(holder, share)) {
                distributed += share;
            } else {
                pendingAirdropTokens += share;
                emit AirdropPayoutSkipped(holder, share);
            }
        }

        roundCursor = to;
        emit AirdropBatchProcessed(from, to, distributed);

        if (roundCursor >= total) {
            roundActive = false;
            emit AirdropRoundCompleted(roundAmount);
        }
    }

    // ---------------------------------------------------------------
    // Rescue (PR-4): PlatformToken already earmarked for holders is protected
    // ---------------------------------------------------------------

    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "V4PlatformTokenRewards: invalid recipient");
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (token == address(platformToken)) {
            uint256 committed = pendingAirdropTokens + (roundActive ? roundAmount : 0);
            uint256 rescuable = balance > committed ? balance - committed : 0;
            require(amount <= rescuable, "V4PlatformTokenRewards: exceeds rescuable balance");
        } else {
            require(amount <= balance, "V4PlatformTokenRewards: exceeds balance");
        }
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }
}
