// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../VaultRedemption.sol";

/// Contract execution callers may reject refunds or try to reenter either guarded contract.
contract RedemptionCaller {
    bool public rejectRefund;
    bool public reentryAttempted;
    bool public reentryAccepted;
    address public callbackTarget;
    bytes public callbackData;

    function configure(bool reject_, address target_, bytes calldata data_) external {
        rejectRefund = reject_;
        callbackTarget = target_;
        callbackData = data_;
    }

    function execute(IGovernor governor, address[] calldata targets, uint256[] calldata values, bytes[] calldata data, bytes32 hash) external {
        governor.execute(targets, values, data, hash);
    }

    function claim(VaultRedemption vault) external { vault.claimRedemptionRefund(); }

    function queue(IGovernor governor, address[] calldata targets, uint256[] calldata values, bytes[] calldata data, bytes32 hash) external {
        governor.queue(targets, values, data, hash);
    }

    receive() external payable {
        require(!rejectRefund, "Refund rejected");
        if (callbackTarget != address(0)) {
            reentryAttempted = true;
            (reentryAccepted,) = callbackTarget.call(callbackData);
        }
    }
}
