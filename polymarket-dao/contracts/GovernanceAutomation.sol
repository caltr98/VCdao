// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/governance/IGovernor.sol";
import "./OrderWallet.sol";
import "./VaultRedemption.sol";

/// A resolver and permissionless entry point for an external automation service.
/// No signer, treasury allowance, or privileged Governor role is assigned here.
contract GovernanceAutomation {
    IGovernor public immutable governor;

    constructor(IGovernor governor_) {
        require(address(governor_).code.length > 0, "Invalid governor");
        governor = governor_;
    }

    function checker(
        address[] calldata targets, uint256[] calldata values, bytes[] calldata calldatas, bytes32 descriptionHash
    ) external view returns (bool canExec, bytes memory execPayload) {
        uint256 id = governor.hashProposal(targets, values, calldatas, descriptionHash);
        canExec = _canAdvance(id);
        execPayload = abi.encodeCall(this.advance, (targets, values, calldatas, descriptionHash));
        // This legacy resolver always targets this contract. Redemption uses the explicit-target resolver.
        if (canExec && _hasRedemption(calldatas)) canExec = false;
    }

    function redemptionChecker(address[] calldata targets, uint256[] calldata values, bytes[] calldata calldatas, bytes32 descriptionHash)
        external view returns (bool canExec, address target, bytes memory execPayload)
    {
        target = address(governor);
        execPayload = abi.encodeCall(governor.execute, (targets, values, calldatas, descriptionHash));
        if (targets.length != 1 || values.length != 1 || calldatas.length != 1 || values[0] != 0 || calldatas[0].length != 36 || !_hasRedemption(calldatas)) return (false, target, execPayload);
        if (targets[0] != IRedemptionGovernor(address(governor)).betVault()) return (false, target, execPayload);
        uint256 id = governor.hashProposal(targets, values, calldatas, descriptionHash);
        if (governor.state(id) == IGovernor.ProposalState.Succeeded) {
            return (true, target, abi.encodeCall(governor.queue, (targets, values, calldatas, descriptionHash)));
        }
        if (governor.state(id) != IGovernor.ProposalState.Queued || !_canAdvance(id)) return (false, target, execPayload);
        uint256 market = abi.decode(calldatas[0][4:], (uint256));
        try VaultRedemption(payable(targets[0])).previewRedemption(market) returns (uint256, uint256, uint256) { canExec = true; }
        catch { canExec = false; }
    }

    function _canAdvance(uint256 id) private view returns (bool) {
        IGovernor.ProposalState current = governor.state(id);
        return current == IGovernor.ProposalState.Succeeded ||
            (current == IGovernor.ProposalState.Queued && block.timestamp >= governor.proposalEta(id));
    }

    function advance(
        address[] calldata targets, uint256[] calldata values, bytes[] calldata calldatas, bytes32 descriptionHash
    ) external {
        uint256 id = governor.hashProposal(targets, values, calldatas, descriptionHash);
        require(_canAdvance(id), "Governance not ready");
        require(!_hasRedemption(calldatas), "Execute redemption directly on governor");
        if (governor.state(id) == IGovernor.ProposalState.Succeeded) governor.queue(targets, values, calldatas, descriptionHash);
        else {
            governor.execute(targets, values, calldatas, descriptionHash);
        }
    }

    function _hasRedemption(bytes[] calldata calldatas) private pure returns (bool) {
        for (uint256 i; i < calldatas.length; i++) {
            if (calldatas[i].length >= 4 && bytes4(calldatas[i]) == VaultRedemption.redeem.selector) return true;
        }
        return false;
    }

    function collectionChecker(OrderWallet wallet) external view returns (bool canExec, bytes memory execPayload) {
        return (wallet.canCollect(), abi.encodeCall(wallet.collect, ()));
    }
}
