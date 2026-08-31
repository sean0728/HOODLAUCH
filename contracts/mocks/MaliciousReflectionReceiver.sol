// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../CustomToken.sol";
import "../interfaces/IUniswapV2Router02.sol";

/// @dev Test-only holder contract used to exercise CustomToken's
/// pushReflections()/claimReflections() against a deliberately hostile
/// recipient: reentrancy attempts, an outright revert, and a gas-guzzling
/// receive(). Buys itself into a real holder position via MockRouter (so
/// it accrues a genuine reflection entitlement, not a hand-set one) and
/// switches behavior via `mode`.
contract MaliciousReflectionReceiver {
    enum Mode {
        Accept, // plain, well-behaved recipient — the control case
        Revert, // reverts unconditionally on receiving ETH
        ReenterPush, // calls token.pushReflections() from inside receive()
        ReenterClaim, // calls token.claimReflections() from inside receive()
        GasGuzzle // burns gas in a storage-writing loop, deliberately never returning cleanly
    }

    CustomToken public token;
    Mode public mode;
    uint256 public receiveCount;
    uint256 private _sink; // written to in GasGuzzle mode purely to burn gas

    constructor(address token_) {
        token = CustomToken(payable(token_));
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function buy(address router, uint256 minOut) external payable {
        address[] memory path = new address[](2);
        path[0] = IUniswapV2Router02(router).WETH();
        path[1] = address(token);
        IUniswapV2Router02(router).swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(
            minOut, path, address(this), block.timestamp + 900
        );
    }

    function sell(address router, uint256 amountIn, uint256 minOut) external {
        token.approve(router, amountIn);
        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = IUniswapV2Router02(router).WETH();
        IUniswapV2Router02(router).swapExactTokensForETHSupportingFeeOnTransferTokens(
            amountIn, minOut, path, address(this), block.timestamp + 900
        );
    }

    function claim() external returns (uint256) {
        return token.claimReflections();
    }

    receive() external payable {
        receiveCount++;
        if (mode == Mode.Revert) {
            revert("MaliciousReflectionReceiver: nope");
        } else if (mode == Mode.ReenterPush) {
            // Deliberately does not wrap this in try/catch — if the
            // reentrancy guard is doing its job this call reverts, and
            // that revert should make the *outer* low-level call (the one
            // that sent us this ETH) report failure, not blow up the
            // whole batch transaction.
            token.pushReflections(10);
        } else if (mode == Mode.ReenterClaim) {
            token.claimReflections();
        } else if (mode == Mode.GasGuzzle) {
            // Spins until it runs out of whatever gas stipend it was
            // forwarded — proves a stingy/hostile receiver can't be made
            // to succeed just by burning gas, without reverting the
            // caller's whole batch either.
            while (true) {
                _sink += 1;
            }
        }
        // Mode.Accept: do nothing further, plain successful receipt.
    }
}
