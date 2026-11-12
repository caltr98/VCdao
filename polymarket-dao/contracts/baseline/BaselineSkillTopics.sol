// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// MarketRegistry checks the expertise domain of a new market against its skills contract.
/// The baseline has no skills, so this stub accepts the same ten topics as the example DAO catalog.
contract BaselineSkillTopics {
    uint256 public constant TOPIC_COUNT = 10;

    function isValidTopic(uint256 topicId) external pure returns (bool) {
        return topicId < TOPIC_COUNT;
    }
}
