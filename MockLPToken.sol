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
contract MockLPToken is ERC20 {
    address public immutable token0; // the launched token
    address public immutable token1; // WETH stand-in
    address public immutable minter; // the MockRouter that deployed this pair

    constructor(address launchedToken_, address weth_) ERC20("Mock LP Token", "mLP") {
        token0 = launchedToken_;
        token1 = weth_;
        minter = msg.sender;
    }

    receive() external payable {}

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "MockLPToken: not minter");
        _mint(to, amount);
    }

    /// @notice Live reserves: token0's reserve is this contract's actual
    /// token balance, token1's (WETH-equivalent) reserve is this contract's
    /// actual ETH balance. A real V2 pair caches reserves and only updates
    /// them at the end of mint/burn/swap; this mock just reads live
    /// balances, which is simpler and sufficient here since nothing in
    /// this mock does mid-transaction reserve manipulation.
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast) {
        reserve0 = uint112(IERC20(token0).balanceOf(address(this)));
        reserve1 = uint112(address(this).balance);
        blockTimestampLast = uint32(block.timestamp);
    }

    function withdrawToken(address to, uint256 amount) external {
        require(msg.sender == minter, "MockLPToken: not minter");
        bool sent = IERC20(token0).transfer(to, amount);
        require(sent, "MockLPToken: token transfer failed");
    }

    function withdrawEth(address payable to, uint256 amount) external {
        require(msg.sender == minter, "MockLPToken: not minter");
        (bool sent, ) = to.call{value: amount}("");
        require(sent, "MockLPToken: ETH transfer failed");
    }
}
