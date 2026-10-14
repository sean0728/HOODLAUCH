// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMockMovableToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
    function claimReflections() external returns (uint256);
    function claimReflectionsTo(address to) external returns (uint256);
    function burn(uint256 amount) external;
}

/// @dev Test-only: a reflection HOLDER that misbehaves when it is paid ETH. Used to prove how the holder list and the
/// batch payout cope with a holder that moves its whole balance away from inside the payment callback (which shrinks the
/// list the batch is walking), and (mode 2) one that tries to claim again.
contract V4MockHostileHolder {
    IMockMovableToken public token;
    address public sink;
    uint8 public mode; // 0 = idle, 1 = move whole balance to sink, 2 = re-enter claimReflections, 3 = burn the whole balance

    function arm(address token_, address sink_, uint8 mode_) external {
        token = IMockMovableToken(token_);
        sink = sink_;
        mode = mode_;
    }

    function claimTo(address to) external returns (uint256) {
        return token.claimReflectionsTo(to);
    }

    receive() external payable {
        if (mode == 1) {
            token.transfer(sink, token.balanceOf(address(this)));
        } else if (mode == 2) {
            try token.claimReflections() returns (uint256) {} catch {}
        } else if (mode == 3) {
            token.burn(token.balanceOf(address(this)));
        }
    }
}
