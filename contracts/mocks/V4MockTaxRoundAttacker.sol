// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IV4TaxRounds {
    function roundActive() external view returns (bool);
    function startDisburseRound() external;
    function processDisburseRound(uint256 batchSize) external;
}

/// @notice Test-only: borrows platform tokens from a holder that approved it (a
/// stand-in for a flash loan or a V2 pair), drives a V4PlatformTaxDistributor
/// round while holding them, and hands them straight back.
contract V4MockTaxRoundAttacker {
    function run(address distributor, address token, address lender, uint256 amount, uint256 batch) external {
        IERC20(token).transferFrom(lender, address(this), amount);
        if (!IV4TaxRounds(distributor).roundActive()) IV4TaxRounds(distributor).startDisburseRound();
        IV4TaxRounds(distributor).processDisburseRound(batch);
        IERC20(token).transfer(lender, amount);
    }

    function sweep(address token, address to) external {
        IERC20 t = IERC20(token);
        t.transfer(to, t.balanceOf(address(this)));
    }
}
