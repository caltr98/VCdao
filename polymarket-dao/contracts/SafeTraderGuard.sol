// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Safe 1.3.0 transaction guard for a Polymarket trading Safe. The trading EOA, as owner, may only
/// approve collateral to the configured exchange. Transfers, owner, module, guard and fallback
/// handler changes and delegatecalls all revert. Module transactions (the DAO) are not guarded.
contract SafeTraderGuard {
    bytes4 private constant APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 private constant GUARD_INTERFACE = 0xe6d7a83a;
    address public immutable collateral;
    address public immutable exchange;

    error OwnerTransactionNotAllowed();

    constructor(address collateral_, address exchange_) {
        collateral = collateral_;
        exchange = exchange_;
    }

    function checkTransaction(
        address to, uint256 value, bytes calldata data, uint8 operation,
        uint256, uint256, uint256, address, address payable, bytes memory, address
    ) external view {
        if (to != collateral || value != 0 || operation != 0 || data.length != 68 || bytes4(data[:4]) != APPROVE) revert OwnerTransactionNotAllowed();
        (address spender,) = abi.decode(data[4:], (address, uint256));
        if (spender != exchange) revert OwnerTransactionNotAllowed();
    }

    function checkAfterExecution(bytes32, bool) external pure {}

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == GUARD_INTERFACE || interfaceId == 0x01ffc9a7;
    }
}
