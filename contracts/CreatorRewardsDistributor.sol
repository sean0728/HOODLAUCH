// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./interfaces/IUniswapV2Router02.sol";
import "./interfaces/ICreatorAware.sol";

/// @title CreatorRewardsDistributor
/// @notice Where the creator-reward slice of every taxed buy/sell ends up.
/// LaunchedToken/CustomToken each carve creatorRewardBps (out of their total
/// feeBps/platformFeeBps platform tax — never on top of it, and never
/// overlapping the existing rewardBps carve-out to PlatformRewardsDistributor)
/// off of every taxed transfer and send it here, in-kind, in whatever token
/// that trade was actually taxed in. See LaunchedToken._update /
/// CustomToken._update.
///
/// Unlike PlatformRewardsDistributor — which pools every token's
/// contribution into one shared PlatformToken buyback split across all
/// PlatformToken holders — this keeps every token's creator-reward stream
/// entirely separate and pays out in native ETH, per token, to that
/// specific token's own creator. Closer to how pump.fun's creator-fee-share
/// works than to this platform's own holder-airdrop mechanism.
///
/// Flow, per token:
///  1. In-kind creatorRewardBps accumulates here as an ordinary ERC20
///     balance of that token — no bookkeeping needed for this step, the
///     token's own balanceOf(this) already is the ledger.
///  2. Anyone (typically an off-chain keeper — see scripts/relayer.js's
///     pollCreatorRewardSwaps) calls triggerCreatorSwap(token) once the
///     accumulated balance clears that token's swapThreshold. This swaps
///     the FULL current balance for ETH via the router (using the
///     fee-on-transfer-tolerant variant, since the token being sold here can
///     itself carry a live transfer tax) and credits claimableEth[token].
///  3. Anyone can call claimCreatorRewards(token) — it always pays out to
///     that token's own creator(), regardless of who calls it, so a
///     creator's own "Claim" button on the site, an off-chain keeper, or a
///     direct call from a block explorer all resolve to the exact same
///     recipient.
///
/// claimableEth is keyed by TOKEN, not by creator address, deliberately —
/// per-token claiming is the explicit design here. A creator with several
/// launches gets several independent claimable balances, one per token,
/// matching how a portfolio view naturally lists them — never one pooled
/// balance across everything a wallet has ever launched.
contract CreatorRewardsDistributor is Ownable2Step, ReentrancyGuard {
    IUniswapV2Router02 public immutable router;

    /// @notice ETH owed to a token's creator, credited by
    /// triggerCreatorSwap and zeroed by claimCreatorRewards. Keyed by the
    /// TOKEN address (see contract-level comment for why), not the
    /// creator's own address.
    mapping(address => uint256) public claimableEth;

    /// @notice Minimum balance of `token` this contract must be holding
    /// before triggerCreatorSwap(token) will execute — same anti-dust/
    /// anti-griefing knob as PlatformRewardsDistributor.tokenBuybackThreshold,
    /// and for the same reason a single global threshold wouldn't make sense
    /// (every token has its own supply/decimals scale). Defaults to 0 (any
    /// nonzero balance triggers) until the owner sets one for a given token.
    mapping(address => uint256) public swapThreshold;

    event SwapThresholdUpdated(address indexed token, uint256 newThreshold);
    event CreatorSwapTriggered(address indexed token, address indexed creator, uint256 amountIn, uint256 ethOut);
    event CreatorRewardsClaimed(address indexed token, address indexed creator, address indexed caller, uint256 amount);

    constructor(address router_, address initialOwner_) Ownable(initialOwner_) {
        require(router_ != address(0), "CreatorRewardsDistributor: invalid router");
        router = IUniswapV2Router02(router_);
    }

    /// @notice Lets this contract receive ETH — its only intended inflow is
    /// the swap output inside triggerCreatorSwap below, but this also covers
    /// any stray dust sent directly.
    receive() external payable {}

    function setSwapThreshold(address token, uint256 newThreshold) external onlyOwner {
        swapThreshold[token] = newThreshold;
        emit SwapThresholdUpdated(token, newThreshold);
    }

    /// @notice Swaps this contract's entire balance of `token` for ETH
    /// (routed straight through WETH — path = [token, router.WETH()]) and
    /// credits the proceeds to that token's own creator via
    /// claimableEth[token]. Permissionless, like every trigger in
    /// PlatformRewardsDistributor — the destination (this exact token's own
    /// creator) never depends on who calls it. Reads creator() off the
    /// token itself at call time (ICreatorAware — both LaunchedToken and
    /// CustomToken expose it as a plain public getter), so a creator
    /// transfer on CustomToken (transferCreator/acceptCreator) is always
    /// reflected in whatever swap happens after it goes through, never a
    /// stale snapshot taken here.
    function triggerCreatorSwap(address token, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        require(token != address(0), "CreatorRewardsDistributor: invalid token");
        uint256 amountIn = IERC20(token).balanceOf(address(this));
        require(amountIn > 0 && amountIn >= swapThreshold[token], "CreatorRewardsDistributor: below threshold");

        address creator = ICreatorAware(token).creator();
        require(creator != address(0), "CreatorRewardsDistributor: token has no creator");

        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = router.WETH();

        uint256 before = address(this).balance;
        IERC20(token).approve(address(router), amountIn);
        router.swapExactTokensForETHSupportingFeeOnTransferTokens(
            amountIn,
            minEthOut,
            path,
            address(this),
            block.timestamp + 15 minutes
        );
        ethOut = address(this).balance - before;

        claimableEth[token] += ethOut;
        emit CreatorSwapTriggered(token, creator, amountIn, ethOut);
    }

    /// @notice Pays out claimableEth[token] to that token's own creator().
    /// Callable by anyone — same permissionless-but-fixed-destination
    /// pattern as triggerCreatorSwap above — so a creator's own claim
    /// button, an off-chain keeper, or a direct block-explorer call all pay
    /// the exact same recipient. Checks-effects-interactions (balance
    /// zeroed before the external call) plus nonReentrant besides.
    function claimCreatorRewards(address token) external nonReentrant returns (uint256 amount) {
        address creator = ICreatorAware(token).creator();
        require(creator != address(0), "CreatorRewardsDistributor: token has no creator");
        amount = claimableEth[token];
        require(amount > 0, "CreatorRewardsDistributor: nothing to claim");
        claimableEth[token] = 0;
        (bool sent, ) = payable(creator).call{value: amount}("");
        require(sent, "CreatorRewardsDistributor: ETH transfer failed");
        emit CreatorRewardsClaimed(token, creator, msg.sender, amount);
    }
}
