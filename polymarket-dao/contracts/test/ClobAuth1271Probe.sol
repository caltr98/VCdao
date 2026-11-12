// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// Tests whether the CLOB L1-auth endpoint accepts a deployed ERC-1271 signer.
contract ClobAuth1271Probe {
    address public immutable transport;

    constructor(address transport_) { transport = transport_; }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
        return error == ECDSA.RecoverError.NoError && signer == transport
            ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
