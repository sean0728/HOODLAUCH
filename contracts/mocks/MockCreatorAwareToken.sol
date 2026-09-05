// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/ICreatorAware.sol";

/// @dev Test-only ERC20 that implements ICreatorAware with a mutable
/// creator, standing in for a real LaunchedToken/CustomToken clone in
/// CreatorRewardsDistributor's tests without needing a full clone+tax
/// setup. `setCreator` lets a test simulate CustomToken's
/// transferCreator/acceptCreator flow — CreatorRewardsDistributor reads
/// creator() fresh on every claimCreatorRewards() call, so this mock
/// proves the distributor never caches a stale creator.
contract MockCreatorAwareToken is ERC20, ICreatorAware {
    address public creator;

    constructor(string memory name_, string memory symbol_, uint256 initialSupply, address creator_) ERC20(name_, symbol_) {
        _mint(msg.sender, initialSupply);
        creator = creator_;
    }

    function setCreator(address newCreator) external {
        creator = newCreator;
    }
}
