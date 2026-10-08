// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IV4CurveRescue {
    function rescueStrayEth(address to) external returns (uint256);
    function acceptOwnership() external;
}

/// @notice Test-only: a contract that owns a V4CurveFactory and, used as a fee
/// recipient, tries to call rescueStrayEth() from inside the factory's ETH
/// fee transfer (mid-trade reentrancy). Used by the V4CurveFactory audit tests.
contract V4MockRescueReenter {
    address public target;
    address public sink;
    bool public armed;
    uint256 public stolen;
    bool public reentryBlocked;

    function accept(address t) external {
        target = t;
        IV4CurveRescue(t).acceptOwnership();
    }

    function arm(address sink_) external {
        sink = sink_;
        armed = true;
    }

    receive() external payable {
        _reenter();
    }

    /// @dev A distributor's deposit call carries data, so it lands here.
    fallback() external payable {
        _reenter();
    }

    function _reenter() private {
        if (armed) {
            armed = false;
            try IV4CurveRescue(target).rescueStrayEth(sink) returns (uint256 a) {
                stolen = a;
            } catch {
                reentryBlocked = true;
            }
        }
    }
}
