// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/interfaces/IERC5805.sol";

interface IGovernanceToken is IERC5805 {

    /// @dev Necessaria al modulo skill per consentire upgrade solo ai membri.
    function isMember(address member) external view returns (bool);


    /// @dev Flusso utente minimo per entrare nella DAO e aumentare lo stake.
    function joinDAO() external payable;
    function increaseStake() external payable returns (uint256 newTokens);
    function getStakeScore(address _member) external view returns (uint256);
}
