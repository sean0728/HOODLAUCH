// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/IPlatformToken.sol";

/// @title PlatformRewardsDistributor
/// @notice Where every "kickback to holders" fee stream on Hood Launch
/// ends up, and the one place that turns it into buyback + burn + holder
/// airdrops of PlatformToken. Two completely separate flows feed it:
///
///  1. Launch-fee revenue: TokenFactory/CustomTokenFactory each send this
///     contract 50% of every deployFee/launchFee collected, in native ETH,
///     the moment a launch finalizes — see
///     TokenFactory._finalizeLaunch / CustomTokenFactory.createCustomToken.
///     The other 50% keeps going to feeTreasury exactly as before.
///  2. Ongoing trading tax: LaunchedToken/CustomToken each carve
///     rewardBps (out of their total feeBps/platformFeeBps platform tax)
///     off of every taxed buy/sell and send it here in-kind — i.e. in
///     whatever token that trade was actually taxed in, not ETH. See
///     LaunchedToken._update / CustomToken._update.
///
/// Both flows are inert until platformToken is configured (see
/// setPlatformToken) — before that, ETH and tokens simply accumulate on
/// this contract's own balance, exactly as documented on every factory's
/// rewardsDistributor field: "prior to that it will be the original
/// system." Nothing about enabling this feature later requires touching
/// any already-launched token or factory again.
///
/// Buyback execution is accumulate-and-batch-trigger, not live-per-trade —
/// the same pattern CustomToken already uses for its own liquidity/
/// marketing/reflection fees (see CustomToken._maybeSwapAndProcess). Both
/// trigger functions are permissionless: anyone (typically an off-chain
/// keeper) can fire one once its threshold is met, but nothing about who
/// calls it changes where the funds go — the split is always the same
/// fixed 50% burn / 50% holder-airdrop-pool.
///
/// Holder payouts are pushed, not claimed: PlatformToken tracks its own
/// live holder set on-chain (see PlatformToken.holderCount/holderAt), and
/// startAirdropRound()/processAirdropBatch() walk it in gas-bounded
/// batches so it stays permissionless and affordable no matter how many
/// holders PlatformToken eventually has.
contract PlatformRewardsDistributor is Ownable2Step, ReentrancyGuard {
    IUniswapV2Router02 public immutable router;

    /// @notice The token every buyback converts into, and every airdrop
    /// pays out in. address(0) (the default) means "not configured yet" —
    /// every trigger/round function below refuses to run until this is
    /// set, but ETH and tokens can still accumulate here harmlessly in the
    /// meantime. See setPlatformToken.
    IPlatformToken public platformToken;

    /// @notice Minimum ETH balance this contract must be holding before
    /// triggerEthBuyback will execute. Purely an anti-dust/anti-griefing
    /// knob (a buyback below this just isn't worth the gas) — owner-tunable,
    /// defaults to 0 (any nonzero balance triggers) until set otherwise.
    uint256 public ethBuybackThreshold;

    /// @notice Same idea as ethBuybackThreshold, but per input token, for
    /// triggerTokenBuyback. Defaults to 0 for every token until the owner
    /// sets one.
    mapping(address => uint256) public tokenBuybackThreshold;

    /// @notice PlatformToken sitting here, already bought back and already
    /// split, awaiting its turn in the next airdrop round. Frozen into
    /// roundAmount the moment startAirdropRound() runs.
    uint256 public pendingAirdropTokens;

    bool public roundActive;
    uint256 public roundAmount; // total PlatformToken being paid out this round, frozen at round start
    uint256 public roundSupplySnapshot; // denominator: eligible supply frozen at round start (see startAirdropRound)
    uint256 public roundCursor; // next holder-registry index processAirdropBatch will start from

    event PlatformTokenSet(address indexed newToken);
    event EthBuybackThresholdUpdated(uint256 newThreshold);
    event TokenBuybackThresholdUpdated(address indexed token, uint256 newThreshold);
    event EthBuybackTriggered(uint256 ethIn, uint256 tokensOut, uint256 burned, uint256 toAirdrop);
    event TokenBuybackTriggered(address indexed token, uint256 amountIn, uint256 tokensOut, uint256 burned, uint256 toAirdrop);
    event DirectPlatformTokensProcessed(uint256 amountIn, uint256 burned, uint256 toAirdrop);
    event AirdropRoundStarted(uint256 amount, uint256 supplySnapshot, uint256 holderCountAtStart);
    event AirdropBatchProcessed(uint256 fromIndex, uint256 toIndex, uint256 amountDistributed);
    event AirdropRoundCompleted(uint256 totalDistributed);

    constructor(address router_, address initialOwner_) Ownable(initialOwner_) {
        require(router_ != address(0), "PlatformRewardsDistributor: invalid router");
        router = IUniswapV2Router02(router_);
    }

    /// @notice Where TokenFactory/CustomTokenFactory send their 50% launch-
    /// fee share, and the only way ETH ever lands here.
    receive() external payable {}

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    /// @notice Wires up the token every buyback/burn/airdrop from here on
    /// operates on. Deliberately blocked while a round is active or while
    /// PlatformToken is already sitting in pendingAirdropTokens — changing
    /// the token out from under either would orphan that balance in a
    /// token nobody can query it under anymore. Safe to call exactly once,
    /// right when PlatformToken itself launches, per the owner's own plan
    /// ("i would launch the token in conjunction with the launch of the
    /// platform... prior to that it will be the original system").
    function setPlatformToken(address newToken) external onlyOwner {
        require(!roundActive, "PlatformRewardsDistributor: round in progress");
        require(pendingAirdropTokens == 0, "PlatformRewardsDistributor: pending airdrop must clear first");
        platformToken = IPlatformToken(newToken);
        emit PlatformTokenSet(newToken);
    }

    function setEthBuybackThreshold(uint256 newThreshold) external onlyOwner {
        ethBuybackThreshold = newThreshold;
        emit EthBuybackThresholdUpdated(newThreshold);
    }

    function setTokenBuybackThreshold(address token, uint256 newThreshold) external onlyOwner {
        tokenBuybackThreshold[token] = newThreshold;
        emit TokenBuybackThresholdUpdated(token, newThreshold);
    }

    // ---------------------------------------------------------------
    // Buyback triggers — permissionless once the relevant threshold is met
    // ---------------------------------------------------------------

    /// @notice Swaps this contract's entire ETH balance for platformToken
    /// and splits the result 50% burned / 50% into the airdrop pool.
    /// Anyone can call this (e.g. a scheduled keeper) — the destination of
    /// the funds never depends on who calls it.
    function triggerEthBuyback(uint256 minTokensOut) external nonReentrant returns (uint256 tokensOut) {
        require(address(platformToken) != address(0), "PlatformRewardsDistributor: platform token not set");
        uint256 ethIn = address(this).balance;
        require(ethIn > 0 && ethIn >= ethBuybackThreshold, "PlatformRewardsDistributor: below threshold");

        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = address(platformToken);

        uint256 before = platformToken.balanceOf(address(this));
        router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: ethIn}(
            minTokensOut,
            path,
            address(this),
            block.timestamp + 15 minutes
        );
        tokensOut = platformToken.balanceOf(address(this)) - before;

        (uint256 burned, uint256 toAirdrop) = _splitAndProcess(tokensOut);
        emit EthBuybackTriggered(ethIn, tokensOut, burned, toAirdrop);
    }

    /// @notice Swaps this contract's entire balance of `token` for
    /// platformToken (routed through WETH — see
    /// IUniswapV2Router02.swapExactTokensForTokensSupportingFeeOnTransferTokens)
    /// and splits the result 50/50, same as triggerEthBuyback. If `token`
    /// happens to already be platformToken itself, no swap is needed —
    /// it's processed directly. Anyone can call this once the token's
    /// balance clears its configured threshold.
    function triggerTokenBuyback(address token, uint256 minTokensOut) external nonReentrant returns (uint256 tokensOut) {
        require(address(platformToken) != address(0), "PlatformRewardsDistributor: platform token not set");
        require(token != address(0), "PlatformRewardsDistributor: invalid token");

        uint256 amountIn = IERC20(token).balanceOf(address(this));
        require(amountIn > 0 && amountIn >= tokenBuybackThreshold[token], "PlatformRewardsDistributor: below threshold");

        if (token == address(platformToken)) {
            (uint256 burnedDirect, uint256 toAirdropDirect) = _splitAndProcess(amountIn);
            emit DirectPlatformTokensProcessed(amountIn, burnedDirect, toAirdropDirect);
            return amountIn;
        }

        address[] memory path = new address[](3);
        path[0] = token;
        path[1] = router.WETH();
        path[2] = address(platformToken);

        IERC20(token).approve(address(router), amountIn);
        uint256 before = platformToken.balanceOf(address(this));
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amountIn,
            minTokensOut,
            path,
            address(this),
            block.timestamp + 15 minutes
        );
        tokensOut = platformToken.balanceOf(address(this)) - before;

        (uint256 burned, uint256 toAirdrop) = _splitAndProcess(tokensOut);
        emit TokenBuybackTriggered(token, amountIn, tokensOut, burned, toAirdrop);
    }

    /// @dev Fixed 50/50 split, shared by every path that produces fresh
    /// platformToken here (both buyback triggers, plus the direct-token
    /// shortcut above). Burns immediately; the airdrop half just
    /// accumulates until startAirdropRound() is next called.
    function _splitAndProcess(uint256 amount) private returns (uint256 burned, uint256 toAirdrop) {
        if (amount == 0) return (0, 0);
        burned = amount / 2;
        toAirdrop = amount - burned;
        if (burned > 0) platformToken.burn(burned);
        pendingAirdropTokens += toAirdrop;
    }

    // ---------------------------------------------------------------
    // Airdrop rounds — accumulate-and-batch-trigger, mirroring
    // CustomToken's own swapThreshold/_maybeSwapAndProcess pattern
    // ---------------------------------------------------------------

    /// @notice Freezes whatever's accumulated in pendingAirdropTokens into
    /// a new round: the amount being paid out, and the eligible supply
    /// (PlatformToken's total supply minus whatever this contract itself
    /// is currently holding, since this contract is never a payee of its
    /// own airdrop) it's divided by. Permissionless, like the triggers
    /// above — anyone can kick a round off once there's something to
    /// distribute.
    function startAirdropRound() external nonReentrant {
        require(!roundActive, "PlatformRewardsDistributor: round already active");
        require(address(platformToken) != address(0), "PlatformRewardsDistributor: platform token not set");
        require(pendingAirdropTokens > 0, "PlatformRewardsDistributor: nothing to distribute");

        uint256 ownBalance = platformToken.balanceOf(address(this));
        uint256 supply = platformToken.totalSupply();
        uint256 supplySnapshot = supply > ownBalance ? supply - ownBalance : 0;
        require(supplySnapshot > 0, "PlatformRewardsDistributor: no eligible holders");

        roundAmount = pendingAirdropTokens;
        pendingAirdropTokens = 0;
        roundSupplySnapshot = supplySnapshot;
        roundCursor = 0;
        roundActive = true;

        emit AirdropRoundStarted(roundAmount, roundSupplySnapshot, platformToken.holderCount());
    }

    /// @notice Pushes up to `maxHolders` holders' proportional share of the
    /// active round, resuming from wherever the last call left off, and
    /// closes the round out once every holder's been reached. Anyone can
    /// call this (e.g. a keeper looping until the round completes) — it's
    /// the only way round funds ever actually move.
    ///
    /// Two disclosed, deliberate approximations keep this affordable and
    /// gas-bounded rather than paying for a fully-frozen per-holder
    /// snapshot:
    ///  - Each holder's share is computed from their LIVE balance at the
    ///    moment they're processed, not a balance frozen at round start —
    ///    someone who buys or sells between startAirdropRound() and their
    ///    turn in the loop is paid on whatever they're holding right then.
    ///  - PlatformToken's holder registry can itself shrink mid-round (a
    ///    holder's balance hits zero elsewhere and they're removed via the
    ///    registry's swap-and-pop set), which can shift which address sits
    ///    at a given index for the remainder of the round. In the rare
    ///    case this causes an address to be skipped, their share simply
    ///    stays unpaid this round rather than the whole round reverting.
    function processAirdropBatch(uint256 maxHolders) external nonReentrant {
        require(roundActive, "PlatformRewardsDistributor: no active round");
        require(maxHolders > 0, "PlatformRewardsDistributor: maxHolders must be > 0");

        uint256 total = platformToken.holderCount();
        uint256 from = roundCursor;
        uint256 to = from + maxHolders;
        if (to > total) to = total;

        uint256 distributed;
        for (uint256 i = from; i < to; i++) {
            address holder = platformToken.holderAt(i);
            if (holder == address(this)) continue;
            uint256 share = (roundAmount * platformToken.balanceOf(holder)) / roundSupplySnapshot;
            if (share == 0) continue;
            platformToken.transfer(holder, share);
            distributed += share;
        }

        roundCursor = to;
        emit AirdropBatchProcessed(from, to, distributed);

        if (roundCursor >= total) {
            roundActive = false;
            emit AirdropRoundCompleted(roundAmount);
        }
    }
}
