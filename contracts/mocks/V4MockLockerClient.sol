// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

interface IV4LockerForMock {
    function seedAndLock(PoolKey calldata key, address owner_, uint256 unlockTime, uint256 tokenAmount, address refundTo)
        external
        payable
        returns (uint256 lockId, uint128 liquidity, uint256 ethUsed, uint256 tokenUsed);
    function withdraw(uint256 lockId) external;
}

/// @dev Test helper: a plain mintable ERC20 to seed unhooked pools with.
contract V4MockLockerToken is ERC20 {
    constructor() ERC20("Mock", "MCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Test helper: stands in for a launcher. Exposes locker() the way the real launchers do, delivers the tokens, and
/// calls seedAndLock. Also usable as a lock OWNER whose ETH receive hook tries to re-enter the locker.
contract V4MockLockerClient {
    address public locker;
    uint256 public reenterTarget = type(uint256).max;
    bool public reentryRan;
    bool public reentryBlocked;

    constructor(address locker_) {
        locker = locker_;
    }

    function setReenterTarget(uint256 id) external {
        reenterTarget = id;
    }

    function seed(PoolKey calldata key, address owner_, uint256 unlockTime, uint256 tokenAmount, address refundTo)
        external
        payable
        returns (uint256 lockId, uint128 liquidity, uint256 ethUsed, uint256 tokenUsed)
    {
        IERC20(Currency.unwrap(key.currency1)).transfer(locker, tokenAmount);
        return IV4LockerForMock(locker).seedAndLock{value: msg.value}(key, owner_, unlockTime, tokenAmount, refundTo);
    }

    function withdrawLock(uint256 id) external {
        IV4LockerForMock(locker).withdraw(id);
    }

    receive() external payable {
        if (reenterTarget != type(uint256).max) {
            reentryRan = true;
            try IV4LockerForMock(locker).withdraw(reenterTarget) {}
            catch {
                reentryBlocked = true;
            }
        }
    }
}
