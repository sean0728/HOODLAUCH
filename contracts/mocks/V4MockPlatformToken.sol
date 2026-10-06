// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @dev Test-only stand-in for PlatformToken: ERC20Burnable plus the same
/// swap-and-pop holder registry with generation stamps the V4 distributors read.
contract V4MockPlatformToken is ERC20, ERC20Burnable {
    address[] private _holderList;
    mapping(address => uint256) private _holderIndex; // 1-based
    uint256 public holderGenerationCounter;
    mapping(address => uint256) public holderGeneration;

    constructor(uint256 supply) ERC20("Platform", "PLAT") {
        _mint(msg.sender, supply);
    }

    function holderCount() external view returns (uint256) { return _holderList.length; }
    function holderAt(uint256 i) external view returns (address) { return _holderList[i]; }

    function _update(address from, address to, uint256 value) internal override(ERC20) {
        super._update(from, to, value);
        if (from != address(0) && balanceOf(from) == 0) _removeHolder(from);
        if (to != address(0) && balanceOf(to) > 0) _addHolder(to);
    }

    function _addHolder(address a) private {
        if (_holderIndex[a] != 0) return;
        _holderList.push(a);
        _holderIndex[a] = _holderList.length;
        holderGenerationCounter += 1;
        holderGeneration[a] = holderGenerationCounter;
    }

    function _removeHolder(address a) private {
        uint256 idx = _holderIndex[a];
        if (idx == 0) return;
        uint256 last = _holderList.length;
        if (idx != last) {
            address lastAcc = _holderList[last - 1];
            _holderList[idx - 1] = lastAcc;
            _holderIndex[lastAcc] = idx;
        }
        _holderList.pop();
        delete _holderIndex[a];
    }
}
