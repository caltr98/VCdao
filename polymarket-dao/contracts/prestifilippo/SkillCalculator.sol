// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./ISkillCalculator.sol";
import "./SkillDefinitions.sol";

/*
    Calcola uno skill score normalizzato (0-100) per ciascun topic della DAO.

    Topic:
    0 = AI & Data
    1 = Cloud & Cybersecurity
    2 = FinTech & Blockchain
    3 = Enterprise Software

    Lo score e' la somma delle rilevanze delle skill uniche, piu' un boost di 10
    per la coppia complementare del topic. Il risultato finale e' sempre capped a 100.
*/
contract SkillCalculator is ISkillCalculator {
    uint256 private constant MAX_SCORE = 100;
    uint256 private constant COMPLEMENTARY_SKILLS_BOOST = 10;

    uint256 private constant MACHINE_LEARNING_FLAG = SkillDefinitions.MACHINE_LEARNING_FLAG;
    uint256 private constant DATA_ENGINEERING_FLAG = SkillDefinitions.DATA_ENGINEERING_FLAG;
    uint256 private constant CYBER_SECURITY_FLAG = SkillDefinitions.CYBER_SECURITY_FLAG;
    uint256 private constant CLOUD_ARCHITECTURE_FLAG = SkillDefinitions.CLOUD_ARCHITECTURE_FLAG;
    uint256 private constant DISTRIBUTED_SYSTEMS_FLAG = SkillDefinitions.DISTRIBUTED_SYSTEMS_FLAG;
    uint256 private constant BLOCKCHAIN_FLAG = SkillDefinitions.BLOCKCHAIN_FLAG;
    uint256 private constant SOFTWARE_ARCHITECTURE_FLAG = SkillDefinitions.SOFTWARE_ARCHITECTURE_FLAG;
    uint256 private constant STARTUP_FINANCE_FLAG = SkillDefinitions.STARTUP_FINANCE_FLAG;

    /*
        Adapter per chiamanti off-chain che dispongono di hash: duplicati e skill
        sconosciute non contribuiscono. La DAO passa direttamente la bitmap.
    */
    function calculateAllVP(bytes32[] calldata skills) external pure returns (uint256[] memory) {
        uint256 skillFlags;
        for (uint256 i = 0; i < skills.length; i++) {
            skillFlags |= SkillDefinitions.skillFlag(skills[i]);
        }
        return calculateAllVPFromBitmap(skillFlags);
    }

    /// I bit non assegnati sono ignorati, come gli hash sconosciuti nell'adapter.
    function calculateAllVPFromBitmap(uint256 skillFlags) public pure override returns (uint256[] memory scores) {
        scores = new uint256[](SkillDefinitions.TOPIC_COUNT);
        for (uint256 i = 0; i < SkillDefinitions.SKILL_COUNT; i++) {
            uint256 flag = 1 << i;
            if ((skillFlags & flag) != 0) _addRelevance(scores, flag);
        }
        _addBoosts(scores, skillFlags);

        for (uint256 topicId = 0; topicId < SkillDefinitions.TOPIC_COUNT; topicId++) {
            if (scores[topicId] > MAX_SCORE) scores[topicId] = MAX_SCORE;
        }
    }

    /*
        Matrice: [AI & Data, Cloud & Cybersecurity, FinTech & Blockchain, Enterprise Software].

        Scala adottata:
        - 35: competenza centrale
        - 25-30: fortemente rilevante
        - 15-20: di supporto
        - 5-10: marginale

        Le coppie complementari valgono 65 prima del boost e 75 dopo il boost:
        il cap non annulla quindi la sinergia e uno score di 100 richiede competenze ulteriori.
    */
    function _addRelevance(uint256[] memory scores, uint256 flag) private pure {
        if (flag == MACHINE_LEARNING_FLAG) {
            _addScores(scores, 35, 5, 5, 15);
        } else if (flag == DATA_ENGINEERING_FLAG) {
            _addScores(scores, 30, 20, 15, 20);
        } else if (flag == CYBER_SECURITY_FLAG) {
            _addScores(scores, 15, 35, 25, 20);
        } else if (flag == CLOUD_ARCHITECTURE_FLAG) {
            _addScores(scores, 15, 30, 20, 30);
        } else if (flag == DISTRIBUTED_SYSTEMS_FLAG) {
            _addScores(scores, 20, 30, 25, 30);
        } else if (flag == BLOCKCHAIN_FLAG) {
            _addScores(scores, 5, 15, 35, 15);
        } else if (flag == SOFTWARE_ARCHITECTURE_FLAG) {
            _addScores(scores, 15, 25, 20, 35);
        } else {
            // startupFinance
            _addScores(scores, 15, 10, 30, 25);
        }
    }

    function _addScores(
        uint256[] memory scores,
        uint256 aiData,
        uint256 cloudCybersecurity,
        uint256 fintechBlockchain,
        uint256 enterpriseSoftware
    ) private pure {
        scores[SkillDefinitions.TOPIC_AI_DATA] += aiData;
        scores[SkillDefinitions.TOPIC_CLOUD_CYBERSECURITY] += cloudCybersecurity;
        scores[SkillDefinitions.TOPIC_FINTECH_BLOCKCHAIN] += fintechBlockchain;
        scores[SkillDefinitions.TOPIC_ENTERPRISE_SOFTWARE] += enterpriseSoftware;
    }

    function _addBoosts(uint256[] memory scores, uint256 skillFlags) private pure {
        if (_hasBoth(skillFlags, MACHINE_LEARNING_FLAG, DATA_ENGINEERING_FLAG)) {
            scores[SkillDefinitions.TOPIC_AI_DATA] += COMPLEMENTARY_SKILLS_BOOST;
        }
        if (_hasBoth(skillFlags, CYBER_SECURITY_FLAG, CLOUD_ARCHITECTURE_FLAG)) {
            scores[SkillDefinitions.TOPIC_CLOUD_CYBERSECURITY] += COMPLEMENTARY_SKILLS_BOOST;
        }
        if (_hasBoth(skillFlags, BLOCKCHAIN_FLAG, STARTUP_FINANCE_FLAG)) {
            scores[SkillDefinitions.TOPIC_FINTECH_BLOCKCHAIN] += COMPLEMENTARY_SKILLS_BOOST;
        }
        if (_hasBoth(skillFlags, SOFTWARE_ARCHITECTURE_FLAG, CLOUD_ARCHITECTURE_FLAG)) {
            scores[SkillDefinitions.TOPIC_ENTERPRISE_SOFTWARE] += COMPLEMENTARY_SKILLS_BOOST;
        }
    }

    function _hasBoth(uint256 skillFlags, uint256 first, uint256 second) private pure returns (bool) {
        uint256 requiredFlags = first | second;
        return (skillFlags & requiredFlags) == requiredFlags;
    }
}
