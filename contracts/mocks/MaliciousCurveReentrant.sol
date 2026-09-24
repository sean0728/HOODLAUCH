// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../BondingCurveFactory.sol";

contract MaliciousCurveReentrant {
    enum Mode { Accept, Revert, ReenterSell, ReenterBuy, ReenterGraduate }

    BondingCurveFactory public factory;
    Mode public mode;
    address public targetToken;
    uint256 public reenterAmount;
    uint256 public receiveCount;

    constructor(address factory_) {
        factory = BondingCurveFactory(payable(factory_));
    }

    function setMode(Mode mode_) external { mode = mode_; }
    function setTarget(address token_, uint256 reenterAmount_) external {
        targetToken = token_;
        reenterAmount = reenterAmount_;
    }
    function buyIn(address token, uint256 minTokensOut) external payable returns (uint256 tokensOut) {
        return factory.buy{value: msg.value}(token, minTokensOut);
    }
    function approveFactory(address token, uint256 amount) external {
        IERC20(token).approve(address(factory), amount);
    }
    function sellAmount(address token, uint256 amountIn, uint256 minEthOut) external returns (uint256 ethOut) {
        return factory.sell(token, amountIn, minEthOut);
    }
    function graduateToken(address token) external {
        factory.graduate(token);
    }
    receive() external payable {
        receiveCount++;
        if (mode == Mode.Revert) {
            revert("MaliciousCurveReentrant: nope");
        } else if (mode == Mode.ReenterSell) {
            factory.sell(targetToken, reenterAmount, 0);
        } else if (mode == Mode.ReenterBuy) {
            factory.buy{value: 0.001 ether}(targetToken, 0);
        } else if (mode == Mode.ReenterGraduate) {
            factory.graduate(targetToken);
        }
    }
}
