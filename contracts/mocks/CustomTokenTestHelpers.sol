// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/proxy/Clones.sol";
contract CTCloner { function make(address impl) external returns (address) { return Clones.clone(impl); } }
contract CTMockFeed {
    function decimals() external pure returns (uint8) { return 8; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return (1, 2000e8, block.timestamp, block.timestamp, 1); }
}
