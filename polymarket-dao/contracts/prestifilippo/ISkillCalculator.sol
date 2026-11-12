// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
/*
Interfaccia minima usata da GovernanceSkill per calcolare il voting power derivato dalle skill.
Espone solo l'operazione batch necessaria durante un upgrade: il calcolatore concreto
puo' organizzare topic, pesi e boost come preferisce.
*/
interface ISkillCalculator {
    /// @notice Restituisce gli score (0-100) per tutti i topic supportati in una sola chiamata.
    function calculateAllVPFromBitmap(uint256 skillBitmap) external view returns (uint256[] memory);
}
