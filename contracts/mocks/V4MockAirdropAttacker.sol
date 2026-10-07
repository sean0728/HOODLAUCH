// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IV4Rounds {
    function roundActive() external view returns (bool);
    function startAirdropRound() external;
    function processAirdropBatch(uint256 maxHolders) external;
}

/// @notice Test-only: borrows platform tokens from a holder that approved it (a
/// stand-in for a flash loan or a V2 pair), drives an airdrop round while
/// holding them, and hands them straight back. Used by the V4PlatformTokenRewards audit.
contract V4MockAirdropAttacker {
    function run(address distributor, address token, address lender, uint256 amount, uint256 maxHolders) external {
        IERC20(token).transferFrom(lender, address(this), amount);
        if (!IV4Rounds(distributor).roundActive()) IV4Rounds(distributor).startAirdropRound();
        IV4Rounds(distributor).processAirdropBatch(maxHolders);
        IERC20(token).transfer(lender, amount);
    }

    function sweep(address token, address to) external {
        IERC20 t = IERC20(token);
        t.transfer(to, t.balanceOf(address(this)));
    }
}
