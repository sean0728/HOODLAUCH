// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only copy of the PREVIOUS PlatformToken's holder registry: a swap-and-pop set that drops an address when
/// its balance reaches zero, and no balance snapshots (no snapshot / isSnapshotter / balanceOfAt). The distributors
/// must refuse it, and the tests use it to reproduce what that registry did to a round that spans several transactions.
contract V4MockLegacyPlatformToken is ERC20 {
    address[] private _holderList;
    mapping(address => uint256) private _holderIndex; // 1-based; 0 = not currently a holder

    constructor(uint256 supply) ERC20("Legacy", "LEG") {
        _mint(msg.sender, supply);
    }

    function holderCount() external view returns (uint256) {
        return _holderList.length;
    }

    function holderAt(uint256 index) external view returns (address) {
        return _holderList[index];
    }

    function holderGenerationCounter() external view returns (uint256) {
        return _holderList.length;
    }

    function holderGeneration(address account) external view returns (uint256) {
        return _holderIndex[account];
    }

    function _update(address from, address to, uint256 value) internal override(ERC20) {
        super._update(from, to, value);
        if (from != address(0) && balanceOf(from) == 0) _removeHolder(from);
        if (to != address(0) && balanceOf(to) > 0) _addHolder(to);
    }

    function _addHolder(address account) private {
        if (_holderIndex[account] != 0) return;
        _holderList.push(account);
        _holderIndex[account] = _holderList.length;
    }

    function _removeHolder(address account) private {
        uint256 idx = _holderIndex[account];
        if (idx == 0) return;
        uint256 lastIndex = _holderList.length;
        if (idx != lastIndex) {
            address lastAccount = _holderList[lastIndex - 1];
            _holderList[idx - 1] = lastAccount;
            _holderIndex[lastAccount] = idx;
        }
        _holderList.pop();
        delete _holderIndex[account];
    }
}
