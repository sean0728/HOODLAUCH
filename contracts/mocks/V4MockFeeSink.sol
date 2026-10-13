// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test double for the ETH-intake side of the platform distributors: records what the hook pays in.
contract V4MockFeeSink {
    uint256 public feeDeposits;      // sum of depositFee() ETH
    uint256 public creatorDeposits;  // sum of depositFor() ETH
    uint256 public plainReceived;    // sum of plain transfers
    mapping(address => uint256) public creatorByToken;
    bool public rejecting;

    function setRejecting(bool r) external { rejecting = r; }

    function depositFee() external payable {
        require(!rejecting, "sink rejecting");
        feeDeposits += msg.value;
    }

    function depositFor(address token) external payable {
        require(!rejecting, "sink rejecting");
        creatorDeposits += msg.value;
        creatorByToken[token] += msg.value;
    }

    receive() external payable {
        require(!rejecting, "sink rejecting");
        plainReceived += msg.value;
    }
}
