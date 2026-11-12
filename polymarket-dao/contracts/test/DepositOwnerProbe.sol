// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Fork-only probe: a contract owner accepts one explicitly approved digest.
contract DepositOwnerProbe {
    address public immutable controller = msg.sender;
    mapping(bytes32 => bool) public approved;

    function approve(bytes32 digest) external {
        require(msg.sender == controller, "Only controller");
        approved[digest] = true;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        bool marker = keccak256(signature) == keccak256(hex"01") || (signature.length == 65 && keccak256(signature) == keccak256(new bytes(65)));
        return approved[digest] && marker
            ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
