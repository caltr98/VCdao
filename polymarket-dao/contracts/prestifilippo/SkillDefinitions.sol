// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
    Definizioni condivise dei topic e delle skill supportati dalla DAO.
    Gli identificatori delle skill sono case-sensitive e coincidono con i valori
    inseriti nelle VC. La libreria non usa storage e viene inlinata nei contratti.
*/
library SkillDefinitions {
    uint256 internal constant TOPIC_AI_DATA = 0;
    uint256 internal constant TOPIC_CLOUD_CYBERSECURITY = 1;
    uint256 internal constant TOPIC_FINTECH_BLOCKCHAIN = 2;
    uint256 internal constant TOPIC_ENTERPRISE_SOFTWARE = 3;
    uint256 internal constant TOPIC_COUNT = 4;

    // Posizioni canoniche: non riordinare o riutilizzare bit già assegnati.
    uint256 internal constant SKILL_COUNT = 8;
    uint256 internal constant MACHINE_LEARNING_FLAG = 1 << 0;
    uint256 internal constant DATA_ENGINEERING_FLAG = 1 << 1;
    uint256 internal constant CYBER_SECURITY_FLAG = 1 << 2;
    uint256 internal constant CLOUD_ARCHITECTURE_FLAG = 1 << 3;
    uint256 internal constant DISTRIBUTED_SYSTEMS_FLAG = 1 << 4;
    uint256 internal constant BLOCKCHAIN_FLAG = 1 << 5;
    uint256 internal constant SOFTWARE_ARCHITECTURE_FLAG = 1 << 6;
    uint256 internal constant STARTUP_FINANCE_FLAG = 1 << 7;
    uint256 internal constant SUPPORTED_SKILL_MASK = (1 << SKILL_COUNT) - 1;

    bytes32 internal constant SKILL_MACHINE_LEARNING = keccak256(bytes("machineLearning"));
    bytes32 internal constant SKILL_DATA_ENGINEERING = keccak256(bytes("dataEngineering"));
    bytes32 internal constant SKILL_CYBER_SECURITY = keccak256(bytes("cyberSecurity"));
    bytes32 internal constant SKILL_CLOUD_ARCHITECTURE = keccak256(bytes("cloudArchitecture"));
    bytes32 internal constant SKILL_DISTRIBUTED_SYSTEMS = keccak256(bytes("distributedSystems"));
    bytes32 internal constant SKILL_BLOCKCHAIN = keccak256(bytes("blockchain"));
    bytes32 internal constant SKILL_SOFTWARE_ARCHITECTURE = keccak256(bytes("softwareArchitecture"));
    bytes32 internal constant SKILL_STARTUP_FINANCE = keccak256(bytes("startupFinance"));

    function skillId(string memory skill) internal pure returns (bytes32) {
        return keccak256(bytes(skill));
    }

    function isValidTopic(uint256 topicId) internal pure returns (bool) {
        return topicId < TOPIC_COUNT;
    }

    function isValidSkill(bytes32 candidateSkill) internal pure returns (bool) {
        return skillFlag(candidateSkill) != 0;
    }

    /// Restituisce il bit della skill, oppure zero se non supportata.
    function skillFlag(bytes32 skill) internal pure returns (uint256) {
        if (skill == SKILL_MACHINE_LEARNING) return MACHINE_LEARNING_FLAG;
        if (skill == SKILL_DATA_ENGINEERING) return DATA_ENGINEERING_FLAG;
        if (skill == SKILL_CYBER_SECURITY) return CYBER_SECURITY_FLAG;
        if (skill == SKILL_CLOUD_ARCHITECTURE) return CLOUD_ARCHITECTURE_FLAG;
        if (skill == SKILL_DISTRIBUTED_SYSTEMS) return DISTRIBUTED_SYSTEMS_FLAG;
        if (skill == SKILL_BLOCKCHAIN) return BLOCKCHAIN_FLAG;
        if (skill == SKILL_SOFTWARE_ARCHITECTURE) return SOFTWARE_ARCHITECTURE_FLAG;
        if (skill == SKILL_STARTUP_FINANCE) return STARTUP_FINANCE_FLAG;
        return 0;
    }

    /// Conta i bit impostati, senza iterare su quelli assenti.
    function countSkills(uint256 bitmap) internal pure returns (uint256 count) {
        while (bitmap != 0) {
            bitmap &= bitmap - 1;
            ++count;
        }
    }

    /// Decodifica in ordine canonico di bit, indipendente dall'ordine delle VC.
    function skillsFromBitmap(uint256 bitmap) internal pure returns (bytes32[] memory skills) {
        bitmap &= SUPPORTED_SKILL_MASK;
        skills = new bytes32[](countSkills(bitmap));
        bytes32[] memory supported = supportedSkills();
        uint256 next;
        for (uint256 i = 0; i < SKILL_COUNT; i++) {
            if ((bitmap & (1 << i)) != 0) skills[next++] = supported[i];
        }
    }

    function supportedTopics() internal pure returns (uint256[] memory topics) {
        topics = new uint256[](TOPIC_COUNT);
        topics[0] = TOPIC_AI_DATA;
        topics[1] = TOPIC_CLOUD_CYBERSECURITY;
        topics[2] = TOPIC_FINTECH_BLOCKCHAIN;
        topics[3] = TOPIC_ENTERPRISE_SOFTWARE;
    }

    function supportedSkills() internal pure returns (bytes32[] memory skills) {
        skills = new bytes32[](SKILL_COUNT);
        skills[0] = SKILL_MACHINE_LEARNING;
        skills[1] = SKILL_DATA_ENGINEERING;
        skills[2] = SKILL_CYBER_SECURITY;
        skills[3] = SKILL_CLOUD_ARCHITECTURE;
        skills[4] = SKILL_DISTRIBUTED_SYSTEMS;
        skills[5] = SKILL_BLOCKCHAIN;
        skills[6] = SKILL_SOFTWARE_ARCHITECTURE;
        skills[7] = SKILL_STARTUP_FINANCE;
    }
}
