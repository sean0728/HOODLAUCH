// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Test-only fixed-rate stand-in for the Uniswap V2 router the V4
/// distributors use to buy PlatformToken with ETH. `rate` = tokens per 1 ETH.
contract V4MockV2Router {
    address public immutable platformToken;
    uint256 public rate;
    uint256 public quoteDiscountBps; // makes getAmountsOut over-quote, to exercise the floor

    constructor(address platformToken_, uint256 rate_) {
        platformToken = platformToken_;
        rate = rate_;
    }

    function WETH() external pure returns (address) { return address(0xbeef); }

    function setQuoteDiscountBps(uint256 b) external { quoteDiscountBps = b; }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = (amountIn * rate) / 1 ether;
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 minOut, address[] calldata, address to, uint256)
        external
        payable
    {
        uint256 out = (msg.value * rate * (10_000 - quoteDiscountBps)) / 1 ether / 10_000;
        require(out >= minOut, "MockRouter: INSUFFICIENT_OUTPUT_AMOUNT");
        IERC20(platformToken).transfer(to, out);
    }
}
