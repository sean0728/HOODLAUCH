// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title V4Create2Deployer
/// @notice Minimal CREATE2 factory used to place V4TaxHook at an address whose
/// low 14 bits encode its hook permissions (0x20CC). Uniswap V4 reads a hook's
/// permissions from its address, so the hook can't be deployed with a normal
/// CREATE; scripts/V4mineHookAddress.js searches for a salt and this contract
/// deploys with it. Anyone may use it; it holds no state and no funds.
contract V4Create2Deployer {
    event Deployed(address indexed addr, bytes32 indexed salt);

    function deploy(bytes32 salt, bytes memory initCode) external returns (address addr) {
        assembly {
            addr := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        require(addr != address(0), "V4Create2Deployer: deploy failed");
        emit Deployed(addr, salt);
    }

    function computeAddress(bytes32 salt, bytes32 initCodeHash) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }
}
