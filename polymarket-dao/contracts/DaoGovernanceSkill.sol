// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./prestifilippo/GovernanceSkill.sol";
import "./DaoSkillCalculator.sol";

/// Keeps the inherited VC verification, bitmap merging and topic checkpoints.
contract DaoGovernanceSkill is GovernanceSkill {
    constructor(address token, address controller, uint256 weight, address calculator)
        GovernanceSkill(token, controller, weight, calculator) {}

    function _validateSkillCalculator(address calculator) internal view override returns (ISkillCalculator) {
        if (calculator == address(0)) revert ZeroAddress();
        if (calculator.code.length == 0) revert NotAContract();
        uint256 topics = DaoSkillCalculator(calculator).topicCount();
        if (topics == 0 || topics > 32) revert InvalidCalculator();
        uint256[] memory scores = ISkillCalculator(calculator).calculateAllVPFromBitmap(0);
        if (scores.length != topics) revert InvalidCalculator();
        for (uint256 i; i < topics; i++) if (scores[i] != 0) revert InvalidCalculator();
        return ISkillCalculator(calculator);
    }

    function _topicCount() internal view override returns (uint256) {
        return DaoSkillCalculator(address(skillCalculator)).topicCount();
    }

    function _skillFlag(bytes32 id) internal view override returns (uint256) {
        return DaoSkillCalculator(address(skillCalculator)).skillFlag(id);
    }

    function _skillsFromBitmap(uint256 bitmap) internal view override returns (bytes32[] memory) {
        return DaoSkillCalculator(address(skillCalculator)).skillsFromBitmap(bitmap);
    }

    function getSupportedTopics() external view override returns (uint256[] memory topics) {
        topics = new uint256[](_topicCount());
        for (uint256 i; i < topics.length; i++) topics[i] = i;
    }

    function getSupportedSkills() external view override returns (bytes32[] memory) {
        return DaoSkillCalculator(address(skillCalculator)).getSupportedSkills();
    }
}
