// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IV4HookFlush {
    function flush(bytes32 id) external;
}

/// @dev Test double: a marketing wallet that tries to re-enter the hook's flush while being paid.
contract V4MockFlushReenter {
    address public hook;
    bytes32 public poolId;
    bool public attempted;
    bool public reenterReverted;
    uint256 public received;

    function arm(address hook_, bytes32 poolId_) external {
        hook = hook_;
        poolId = poolId_;
    }

    receive() external payable {
        received += msg.value;
        if (hook != address(0)) {
            attempted = true;
            try IV4HookFlush(hook).flush(poolId) {} catch { reenterReverted = true; }
        }
    }
}
