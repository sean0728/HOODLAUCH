// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only: a buyer contract that tries to re-enter the curve factory from the callback that returns the part of
/// its buy past the graduation target (a sell, a graduate() and a second buy), and records whether each attempt was refused.
contract V4MockCurveBuyer {
    address public factory;
    address public token;
    bool public sellRefused;
    bool public graduateRefused;
    bool public buyRefused;
    uint256 public refundReceived;

    function buyOn(address factory_, address token_) external payable {
        factory = factory_;
        token = token_;
        (bool ok,) = factory_.call{value: msg.value}(abi.encodeWithSignature("buy(address,uint256)", token_, 0));
        require(ok, "buy failed");
    }

    function sellAll(uint256 amount) external {
        (bool a,) = token.call(abi.encodeWithSignature("approve(address,uint256)", factory, amount));
        require(a, "approve failed");
        (bool ok,) = factory.call(abi.encodeWithSignature("sell(address,uint256,uint256)", token, amount, 0));
        require(ok, "sell failed");
    }

    receive() external payable {
        if (msg.sender != factory) return; // proceeds of a sell, not the refund
        refundReceived += msg.value;
        (bool s,) = factory.call(abi.encodeWithSignature("sell(address,uint256,uint256)", token, 1, 0));
        sellRefused = !s;
        (bool g,) = factory.call(abi.encodeWithSignature("graduate(address)", token));
        graduateRefused = !g;
        (bool b,) = factory.call{value: 1}(abi.encodeWithSignature("buy(address,uint256)", token, 0));
        buyRefused = !b;
    }
}
