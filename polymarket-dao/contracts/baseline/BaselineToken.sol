// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";

/// Plain stake-voting token for the gas baseline: one vote per deposited wei, no membership,
/// DIDs or credentials. Permit and Votes match the extensions of SAGE's GovernanceToken.
contract BaselineToken is ERC20, ERC20Permit, ERC20Votes {
    /// Same cumulative cap per account as SAGE's GovernanceToken.
    uint256 public constant MAX_DEPOSIT = 100 ether;
    /// Deposits go to the DAO treasury, as SAGE forwards them to its vault. Here the treasury is the Timelock.
    address public immutable treasury;
    mapping(address => uint256) public deposited;

    constructor(address treasury_) ERC20("Baseline Governance Token", "BASE") ERC20Permit("Baseline Governance Token") {
        require(treasury_ != address(0), "Invalid treasury");
        treasury = treasury_;
    }

    function deposit() external payable {
        require(msg.value > 0 && deposited[msg.sender] + msg.value <= MAX_DEPOSIT, "Invalid deposit");
        deposited[msg.sender] += msg.value;
        _mint(msg.sender, msg.value);
        (bool ok, ) = treasury.call{value: msg.value}("");
        require(ok, "Treasury transfer failed");
    }

    function _update(address from, address to, uint256 amount) internal override(ERC20, ERC20Votes) {
        super._update(from, to, amount);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
