// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only, ordinary constructor-initialized ERC20. Used in tests and
/// local deployment purely as a stand-in for WETH (MockRouter only stores
/// its address and never actually wraps/unwraps it, so any ERC20 works).
/// This is deliberately NOT LaunchedToken — LaunchedToken's implementation
/// contract is intentionally inert (its constructor locks it so it can
/// never be initialize()'d directly, only via a clone), so it can't be
/// reused this way.
contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 initialSupply) ERC20(name_, symbol_) {
        _mint(msg.sender, initialSupply);
    }
}
