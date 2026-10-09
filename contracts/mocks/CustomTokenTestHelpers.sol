// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/proxy/Clones.sol";
contract CTCloner { function make(address impl) external returns (address) { return Clones.clone(impl); } }
contract CTMockFeed {
    function decimals() external pure returns (uint8) { return 8; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (1, 2000e8, block.timestamp, block.timestamp, 1); }
}

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
contract CTMockFactory { function getPair(address, address) external pure returns (address) { return address(0); } }
/// Fixed-rate V2 router stand-in: `rate` platform tokens per 1 ETH.
contract CTMockRouter {
    address public immutable platformToken;
    address public immutable factory;
    uint256 public rate;
    constructor(address platformToken_, uint256 rate_) { platformToken = platformToken_; rate = rate_; factory = address(new CTMockFactory()); }
    function WETH() external pure returns (address) { return address(0xbeef); }
    function setPlatformToken(address) external {}
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 minOut, address[] calldata, address to, uint256) external payable {
        uint256 out = (msg.value * rate) / 1 ether;
        require(out >= minOut, "MockRouter: INSUFFICIENT_OUTPUT_AMOUNT");
        IERC20(platformToken).transfer(to, out);
    }
}
contract CTRejector { receive() external payable { revert("no"); } fallback() external payable { revert("no"); } }
