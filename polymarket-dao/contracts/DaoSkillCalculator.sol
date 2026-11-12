// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./prestifilippo/ISkillCalculator.sol";

/// The DAO selects this catalog and relevance matrix when it is deployed.
contract DaoSkillCalculator is ISkillCalculator {
    struct Boost { uint256 topic; uint256 requiredSkills; uint8 bonus; }
    uint256 public immutable topicCount;
    uint256 public immutable supportedMask;
    mapping(bytes32 => uint256) public skillFlag;
    bytes32[] private skillIds;
    bytes private relevance;
    Boost[] private boosts;

    constructor(bytes32[] memory ids, uint256 topics, bytes memory weights, Boost[] memory pairs) {
        require(ids.length > 0 && ids.length <= 256 && topics > 0 && topics <= 32, "Invalid catalog size");
        require(weights.length == ids.length * topics, "Invalid relevance matrix");
        topicCount = topics;
        supportedMask = type(uint256).max >> (256 - ids.length);
        _storeSkills(ids);
        _storeRelevance(weights);
        _storeBoosts(pairs);
    }

    function _storeSkills(bytes32[] memory ids) private {
        for (uint256 i; i < ids.length; i++) {
            require(ids[i] != bytes32(0) && skillFlag[ids[i]] == 0, "Duplicate or empty skill");
            skillIds.push(ids[i]);
            skillFlag[ids[i]] = uint256(1) << i;
        }
    }

    function _storeRelevance(bytes memory weights) private {
        for (uint256 i; i < weights.length; i++) require(uint8(weights[i]) <= 100, "Invalid relevance");
        relevance = weights;
    }

    function _storeBoosts(Boost[] memory pairs) private {
        for (uint256 i; i < pairs.length; i++) {
            Boost memory pair = pairs[i];
            require(pair.topic < topicCount && pair.bonus <= 100, "Invalid boost");
            require(pair.requiredSkills != 0 && (pair.requiredSkills & ~supportedMask) == 0, "Invalid boost skills");
            boosts.push(pair);
        }
    }

    function getSupportedSkills() external view returns (bytes32[] memory) { return skillIds; }

    function skillsFromBitmap(uint256 bitmap) external view returns (bytes32[] memory result) {
        bitmap &= supportedMask;
        uint256 count;
        for (uint256 remaining = bitmap; remaining != 0; remaining &= remaining - 1) count++;
        result = new bytes32[](count);
        uint256 next;
        for (uint256 i; i < skillIds.length; i++) if ((bitmap & (uint256(1) << i)) != 0) result[next++] = skillIds[i];
    }

    function calculateAllVPFromBitmap(uint256 bitmap) external view override returns (uint256[] memory scores) {
        scores = new uint256[](topicCount);
        bytes memory weights = relevance;
        for (uint256 i; i < skillIds.length; i++) if ((bitmap & (uint256(1) << i)) != 0) _addScores(scores, weights, i);
        _addBoosts(scores, bitmap);
        for (uint256 topic; topic < scores.length; topic++) if (scores[topic] > 100) scores[topic] = 100;
    }

    function _addScores(uint256[] memory scores, bytes memory weights, uint256 skill) private pure {
        for (uint256 topic; topic < scores.length; topic++) scores[topic] += uint8(weights[skill * scores.length + topic]);
    }

    function _addBoosts(uint256[] memory scores, uint256 bitmap) private view {
        for (uint256 i; i < boosts.length; i++) {
            Boost memory pair = boosts[i];
            if ((bitmap & pair.requiredSkills) == pair.requiredSkills) scores[pair.topic] += pair.bonus;
        }
    }
}
