// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./prestifilippo/IGovernanceSkill.sol";

/// Markets are the proposal topics. Each market selects an existing expertise domain.
contract MarketRegistry {
    struct Market {
        uint256 yesToken;
        uint256 noToken;
        uint256 skillTopic;
        uint64 closesAt;
        bool exists;
    }

    address public immutable timelock;
    IGovernanceSkill public immutable skills;
    mapping(uint256 => Market) public markets;

    event MarketRegistered(uint256 indexed topic, uint256 yesToken, uint256 noToken, uint256 skillTopic, uint64 closesAt, string uri);

    constructor(address timelock_, IGovernanceSkill skills_) {
        require(timelock_ != address(0) && address(skills_).code.length > 0, "Invalid configuration");
        timelock = timelock_;
        skills = skills_;
    }

    /// Initial markets are registered through the timelock during deployment bootstrap.
    /// Registration is append-only so existing proposals cannot change expertise domain.
    function registerMarket(uint256 topic, Market calldata market, string calldata uri) external {
        require(msg.sender == timelock, "Only timelock");
        _validateMarket(topic, market);
        markets[topic] = market;
        emit MarketRegistered(topic, market.yesToken, market.noToken, market.skillTopic, market.closesAt, uri);
    }

    function _validateMarket(uint256 topic, Market calldata market) private view {
        require(topic != 0 && !markets[topic].exists && market.exists, "Invalid market");
        require(market.yesToken != 0 && market.noToken != 0 && market.yesToken != market.noToken, "Invalid outcomes");
        require(market.closesAt > block.timestamp && skills.isValidTopic(market.skillTopic), "Invalid domain or deadline");
    }

    function isValidTopic(uint256 topic) external view returns (bool) {
        return markets[topic].exists;
    }

    function validateBuy(uint256 topic, uint256 tokenId, uint64 deadline) external view {
        Market memory market = markets[topic];
        require(market.exists && (tokenId == market.yesToken || tokenId == market.noToken), "Wrong market outcome");
        require(deadline > block.timestamp && deadline <= market.closesAt, "Invalid execution deadline");
    }

    function _domain(uint256 topic) private view returns (uint256) {
        require(markets[topic].exists, "Unknown market");
        return markets[topic].skillTopic;
    }

    function getPastSkillVotes(address account, uint256 topic, uint256 snapshot) external view returns (uint256) {
        return skills.getPastSkillVotes(account, _domain(topic), snapshot);
    }

    function getPastTotalSkillSupply(uint256 topic, uint256 snapshot) external view returns (uint256) {
        return skills.getPastTotalSkillSupply(_domain(topic), snapshot);
    }

    function getSkillVotes(address account, uint256 topic) external view returns (uint256) {
        return skills.getSkillVotes(account, _domain(topic));
    }

    function getTotalSkillSupply(uint256 topic) external view returns (uint256) {
        return skills.getTotalSkillSupply(_domain(topic));
    }
}
