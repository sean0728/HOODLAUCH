// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IV4RouterLike {
    function buy(address token, uint256 minTokensOut, uint256 deadline) external payable returns (uint256);
    function sell(address token, uint256 amountIn, uint256 minEthOut, uint256 deadline) external returns (uint256);
}

/// @notice Test-only: a smart-contract trader for V4SwapRouter. Its ETH receive hook
/// can accept (0), try to re-enter the router with a buy (1), or try a sell (2).
contract V4MockRouterTrader {
    uint256 public mode;
    address public routerAddr;
    address public tokenAddr;

    function setMode(uint256 m, address router_, address token_) external {
        mode = m;
        routerAddr = router_;
        tokenAddr = token_;
    }

    function doBuy(address router_, address token_, uint256 minOut) external payable returns (uint256) {
        return IV4RouterLike(router_).buy{value: msg.value}(token_, minOut, block.timestamp + 1 hours);
    }

    function doSell(address router_, address token_, uint256 amount) external returns (uint256) {
        IERC20(token_).approve(router_, amount);
        return IV4RouterLike(router_).sell(token_, amount, 0, block.timestamp + 1 hours);
    }

    receive() external payable {
        if (mode == 1) {
            IV4RouterLike(routerAddr).buy{value: 1}(tokenAddr, 0, block.timestamp + 1 hours);
        } else if (mode == 2) {
            IERC20(tokenAddr).approve(routerAddr, 1);
            IV4RouterLike(routerAddr).sell(tokenAddr, 1, 0, block.timestamp + 1 hours);
        }
    }
}
