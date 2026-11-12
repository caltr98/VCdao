// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./VPVerifier.sol";

interface IGovernanceSkill {

    /// @dev Il Governor usa questa funzione per accettare solo proposte con topic supportati.
    function isValidTopic(uint256 topicId) external view returns (bool);

    /// @dev Flusso utente minimo: registrare DID, aggiornare le skill via VC e leggerle.
    function registerDID(string calldata _did) external;
    function getMemberSkills(address member) external view returns (bytes32[] memory);
    function memberSkillBitmap(address member) external view returns (uint256);
    function hasSkill(address member, bytes32 skillId) external view returns (bool);
    function upgradeSkillWithVC(
        VPVerifier.VerifiableCredential memory _vc,
        bytes memory _issuerSignature
    ) external;

    /// @dev Letture necessarie al Governor per VP, quorum e snapshot topic-aware.
    function getSkillVotes(address account, uint256 topicId) external view returns (uint256);
    function getPastSkillVotes(address account, uint256 topicId, uint256 timepoint) external view returns (uint256);
    function getTotalSkillSupply(uint256 topicId) external view returns (uint256);
    function getPastTotalSkillSupply(uint256 topicId, uint256 timepoint) external view returns (uint256);
}
