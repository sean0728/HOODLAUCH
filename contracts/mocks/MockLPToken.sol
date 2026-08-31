// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Test-only stand-in for a real Uniswap V2 pair contract. Real V2
/// pairs are simultaneously the LP token AND the contract that physically
/// holds a pool's reserves — this mirrors that shape (rather than the
/// router holding balances globally, as an earlier version of this mock
/// did) because LaunchedToken's transfer tax needs `from == pair` /
/// `to == pair` to mean something real, and its market-cap check needs a
/// pair contract whose reserves reflect an actual token/ETH balance.
///
/// This is NOT production DEX logic — no swap fee accounting, no minimum
/// liquidity burn, no sync/skim, no flash swaps. MockRouter is the only
/// contract allowed to move funds through this pair (it's the "minter").
///
/// Reserves are cached and only synced at the END of mint/withdrawToken/
/// withdrawEth — deliberately mirroring a real UniswapV2Pair's own timing
/// (its swap() optimistically transfers output tokens first, and only
/// calls its internal reserve-sync afterward, right before returning). An
/// earlier version of this mock read live balances instead, which meant a
/// token's own tax-disable check (triggered synchronously by the very
/// transfer this mock is in the middle of) could see that transfer's own
/// not-yet-final impact on reserves — something a real Uniswap V2 pair
/// never allows, since getReserves() there returns the last-synced
/// (pre-trade) values until swap()'s own bookkeeping runs at the very end.
/// Getting this right here matters for LaunchedToken/CustomToken's
/// graduation checks to be exercised against realistic timing.
contract MockLPToken is ERC20 {
    address public immutable token0; // the launched token
    address public immutable token1; // WETH stand-in
    address public immutable minter; // the MockRouter that deployed this pair

    uint112 private _reserve0;
    uint112 private _reserve1;

    constructor(address launchedToken_, address weth_) ERC20("Mock LP Token", "mLP") {
        token0 = launchedToken_;
        token1 = weth_;
        minter = msg.sender;
    }

    receive() external payable {}

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "MockLPToken: not minter");
        _mint(to, amount);
        _sync();
    }

    /// @notice Cached reserves as of the end of the last mint/withdrawToken/
    /// withdrawEth call — NOT live balances. See the contract-level comment
    /// above for why that distinction matters.
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) {
        reserve0 = _reserve0;
        reserve1 = _reserve1;
        blockTimestampLast = uint32(block.timestamp);
    }

    /// @dev Snapshots this contract's real balances into the cached
    /// reserves. Called at the END of every function that moves funds
    /// through this pair, after any nested calls (e.g. the token transfer
    /// below can trigger the token's own _update/tax-disable logic, which
    /// must see the PRE-this-call cached reserves, not the post-transfer
    /// balance) — exactly mirroring a real pair's swap()/mint() ordering.
    function _sync() private {
        _reserve0 = uint112(IERC20(token0).balanceOf(address(this)));
        _reserve1 = uint112(address(this).balance);
    }

    function withdrawToken(address to, uint256 amount) external {
        require(msg.sender == minter, "MockLPToken: not minter");
        bool sent = IERC20(token0).transfer(to, amount);
        require(sent, "MockLPToken: token transfer failed");
        _sync();
    }

    function withdrawEth(address payable to, uint256 amount) external {
        require(msg.sender == minter, "MockLPToken: not minter");
        (bool sent, ) = to.call{value: amount}("");
        require(sent, "MockLPToken: ETH transfer failed");
        _sync();
    }
}
