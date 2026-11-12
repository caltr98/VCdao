// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockDepositGovernor {
    uint8 public outcome;

    function executeVote() external { outcome = 7; }

    function state(uint256) external view returns (uint8) { return outcome; }

    function hashProposal(address[] memory targets, uint256[] memory values, bytes[] memory data, bytes32 descriptionHash)
        external pure returns (uint256)
    {
        return uint256(keccak256(abi.encode(targets, values, data, descriptionHash)));
    }
}
