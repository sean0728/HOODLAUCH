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
/// Changes from the first V4 port (audit of V4FeeWalletDistributor):
///  - PlatformToken that is already earmarked for holders (queued, or the
///    unpaid rest of a running round) is never counted as fresh income by the
///    distributors' trigger functions (_availableBalance).
///  - A round can never pay out more than its own pot (roundUsed cap), so a
///    holder moving tokens between wallets mid-round cannot reach into the
///    next round's tokens.
///  - The buyback router must be a contract, and _tryBuyPlatformToken lets a
///    distributor degrade a failed buy instead of reverting its whole sale.
///
/// Changes from the standalone audit of this base:
///  - Airdrop rounds are paid from holders' balances AT THE MOMENT THEY RUN, so
///    a caller who borrows tokens (a flash loan, a V2 pair's liquidity) and
///    runs the round while holding them takes other holders' share. Only the
///    owner and approved keepers may start or process a round, and
///    runAirdropRound starts and pays a round in one transaction.
///  - Liquidity pools and other non-holders can be left out of a round
///    (setAirdropExcluded) so their share goes to real holders.
///  - AirdropRoundCompleted reports what was really paid (roundDistributed),
///    and the platform token must be a contract.
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
    /// @notice Part of roundAmount already paid out or re-queued this round.
    uint256 public roundUsed;
    /// @notice Part of roundAmount actually transferred to holders this round.
    uint256 public roundDistributed;

    /// @notice Addresses left out of airdrops (V2 pair, PoolManager, the other
    /// distributor, burn address...). Their balance is also removed from the
    /// round's supply snapshot.
    uint256 public constant MAX_AIRDROP_EXCLUDED = 16;
    mapping(address => bool) public airdropExcluded;
    address[] private _airdropExcludedList;

    event PlatformTokenSet(address indexed newToken);
    event PlatformTokensProcessed(uint256 tokensIn, uint256 burned, uint256 toAirdrop);
    event AirdropRoundStarted(uint256 amount, uint256 supplySnapshot, uint256 holderCountAtStart);
    event AirdropBatchProcessed(uint256 fromIndex, uint256 toIndex, uint256 amountDistributed);
    event AirdropPayoutSkipped(address indexed holder, uint256 amount);
    event AirdropHolderIneligibleThisRound(address indexed holder, uint256 holderGeneration, uint256 roundGeneration);
    event AirdropRoundCompleted(uint256 totalDistributed);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event AirdropExclusionSet(address indexed account, bool excluded);

    constructor(IPoolManager poolManager_, address hook_, address initialOwner_, address buybackRouter_)
        V4TokenSeller(poolManager_, hook_, initialOwner_)
    {
        require(
            buybackRouter_ == address(0) || buybackRouter_.code.length > 0, "V4PlatformTokenRewards: router is not a contract"
        );
        buybackRouter = V4IUniswapV2Router(buybackRouter_);
    }

    /// @notice Blocked while a round is active or tokens are queued: swapping
    /// the token would orphan those balances.
    function setPlatformToken(address newToken) external onlyOwner {
        require(!roundActive, "V4PlatformTokenRewards: round in progress");
        require(pendingAirdropTokens == 0, "V4PlatformTokenRewards: pending airdrop must clear first");
        require(newToken == address(0) || address(buybackRouter) != address(0), "V4PlatformTokenRewards: no buyback router");
        require(newToken == address(0) || newToken.code.length > 0, "V4PlatformTokenRewards: platform token is not a contract");
        platformToken = V4IPlatformToken(newToken);
        emit PlatformTokenSet(newToken);
    }

    /// @notice Leave `account` out of airdrops (or put it back). Owner only, at most
    /// MAX_AIRDROP_EXCLUDED entries, and not while a round is running (the round's
    /// supply snapshot depends on it).
    function setAirdropExcluded(address account, bool excluded) external onlyOwner {
        require(!roundActive, "V4PlatformTokenRewards: round in progress");
        require(account != address(0) && account != address(this), "V4PlatformTokenRewards: invalid account");
        if (airdropExcluded[account] == excluded) return;
        airdropExcluded[account] = excluded;
        if (excluded) {
            require(_airdropExcludedList.length < MAX_AIRDROP_EXCLUDED, "V4PlatformTokenRewards: too many exclusions");
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

    /// @dev True when buying back is actually possible.
    function _buybackEnabled() internal view returns (bool) {
        return address(platformToken) != address(0) && address(buybackRouter) != address(0);
    }

    /// @dev PlatformToken this contract holds that is NOT yet earmarked: the
    /// balance minus what is queued for the next round and what is still owed
    /// to the running one. For any other token it is just the balance.
    function _availableBalance(address token) internal view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (token != address(platformToken)) return bal;
        uint256 committed = _committedPlatformTokens();
        return bal > committed ? bal - committed : 0;
    }

    function _committedPlatformTokens() internal view returns (uint256) {
        return pendingAirdropTokens + (roundActive ? roundAmount - roundUsed : 0);
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

    /// @notice Only callable by this contract itself (through try/catch in
    /// _tryBuyPlatformToken, so a failed buy rolls back cleanly).
    function selfBuyPlatformToken(uint256 ethIn, uint256 callerMinOut) external returns (uint256) {
        require(msg.sender == address(this), "V4PlatformTokenRewards: self only");
        return _buyPlatformToken(ethIn, callerMinOut);
    }

    /// @dev Same as _buyPlatformToken but a router/pool failure returns
    /// (false, 0) with the ETH still held here, instead of reverting.
    function _tryBuyPlatformToken(uint256 ethIn, uint256 callerMinOut) internal returns (bool ok, uint256 tokensOut) {
        try this.selfBuyPlatformToken(ethIn, callerMinOut) returns (uint256 out) {
            return (true, out);
        } catch {
            return (false, 0);
        }
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

    modifier onlyRoundRunner() {
        require(_isKeeper(msg.sender), "V4PlatformTokenRewards: not authorized to run rounds");
        _;
    }

    /// @notice Owner and approved keepers only: a round is paid from balances at
    /// the moment it runs, so an outsider could borrow tokens to inflate theirs.
    function startAirdropRound() external nonReentrant onlyRoundRunner {
        _startAirdropRound();
    }

    function processAirdropBatch(uint256 maxHolders) external nonReentrant onlyRoundRunner {
        _processAirdropBatch(maxHolders);
    }

    /// @notice Starts a round if none is running and pays the first `maxHolders`
    /// holders, all in one transaction (no gap between snapshot and payment).
    function runAirdropRound(uint256 maxHolders) external nonReentrant onlyRoundRunner {
        if (!roundActive) _startAirdropRound();
        _processAirdropBatch(maxHolders);
    }

    function _startAirdropRound() private {
        require(!roundActive, "V4PlatformTokenRewards: round already active");
        require(address(platformToken) != address(0), "V4PlatformTokenRewards: platform token not set");
        require(pendingAirdropTokens > 0, "V4PlatformTokenRewards: nothing to distribute");

        uint256 ineligible = platformToken.balanceOf(address(this));
        uint256 n = _airdropExcludedList.length;
        for (uint256 i = 0; i < n; i++) ineligible += platformToken.balanceOf(_airdropExcludedList[i]);
        uint256 supply = platformToken.totalSupply();
        uint256 supplySnapshot = supply > ineligible ? supply - ineligible : 0;
        require(supplySnapshot > 0, "V4PlatformTokenRewards: no eligible holders");

        roundAmount = pendingAirdropTokens;
        pendingAirdropTokens = 0;
        roundSupplySnapshot = supplySnapshot;
        roundCursor = 0;
        roundUsed = 0;
        roundDistributed = 0;
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

    function _processAirdropBatch(uint256 maxHolders) private {
        require(roundActive, "V4PlatformTokenRewards: no active round");
        require(maxHolders > 0, "V4PlatformTokenRewards: maxHolders must be > 0");

        uint256 liveHolderCount = platformToken.holderCount();
        uint256 total = liveHolderCount < roundHolderCountAtStart ? liveHolderCount : roundHolderCountAtStart;
        uint256 from = roundCursor;
        uint256 to = from + maxHolders;
        if (to > total) to = total;

        uint256 distributed;
        uint256 remaining = roundAmount - roundUsed;
        for (uint256 i = from; i < to; i++) {
            address holder = platformToken.holderAt(i);
            if (holder == address(this) || airdropExcluded[holder]) continue;
            uint256 holderGen = platformToken.holderGeneration(holder);
            if (holderGen > roundGenerationAtStart) {
                emit AirdropHolderIneligibleThisRound(holder, holderGen, roundGenerationAtStart);
                continue;
            }
            uint256 share = (roundAmount * platformToken.balanceOf(holder)) / roundSupplySnapshot;
            // Never beyond the round's own pot, whatever balances did mid-round.
            if (share > remaining) share = remaining;
            if (share == 0) continue;
            remaining -= share;
            roundUsed += share;
            if (_sendPlatformToken(holder, share)) {
                distributed += share;
            } else {
                pendingAirdropTokens += share;
                emit AirdropPayoutSkipped(holder, share);
            }
        }

        roundCursor = to;
        roundDistributed += distributed;
        emit AirdropBatchProcessed(from, to, distributed);

        if (roundCursor >= total) {
            roundActive = false;
            emit AirdropRoundCompleted(roundDistributed);
        }
    }

    // ---------------------------------------------------------------
    // Rescue (PR-4): PlatformToken already earmarked for holders is protected
    // ---------------------------------------------------------------

    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "V4PlatformTokenRewards: invalid recipient");
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (token == address(platformToken)) {
            uint256 committed = _committedPlatformTokens();
            uint256 rescuable = balance > committed ? balance - committed : 0;
            require(amount <= rescuable, "V4PlatformTokenRewards: exceeds rescuable balance");
        } else {
            require(amount <= balance, "V4PlatformTokenRewards: exceeds balance");
        }
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }
}
