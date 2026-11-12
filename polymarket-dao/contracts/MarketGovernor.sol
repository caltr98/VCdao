// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./prestifilippo/MyGovernor.sol";
import "./OrderVault.sol";
import "./SafeMandateHandler.sol";
import "./VaultRedemption.sol";

contract MarketGovernor is MyGovernor, ReentrancyGuard {
    BetVault public immutable betVault;
    /// The DAO's Safe-route handler; zero disables mandate actions.
    SafeMandateHandler public immutable mandateHandler;

    constructor(
        IGovernanceToken token_, MarketRegistry markets_, TimelockController timelock_,
        BetVault vault_, SafeMandateHandler mandateHandler_, uint48 votingDelay_, uint32 votingPeriod_
    ) MyGovernor(token_, IGovernanceSkill(address(markets_)), timelock_, votingDelay_, votingPeriod_, 0, 20, 70) {
        require(address(markets_) == address(vault_.registry()), "Wrong registry");
        require(vault_.timelock() == address(timelock_), "Wrong timelock");
        require(address(mandateHandler_) == address(0) || mandateHandler_.timelock() == address(timelock_), "Wrong mandate handler");
        betVault = vault_;
        mandateHandler = mandateHandler_;
    }

    /// Every proposal carries a market topic. Direct buy actions must use that same market.
    function proposeWithTopic(
        address[] memory targets, uint256[] memory values, bytes[] memory calldatas,
        string memory description, uint256 topicId
    ) public override returns (uint256) {
        require(targets.length == calldatas.length && targets.length == values.length, "Invalid batch");
        for (uint256 i; i < targets.length; i++) _validateAction(targets[i], values[i], calldatas[i], topicId);
        return super.proposeWithTopic(targets, values, calldatas, description, topicId);
    }

    function _validateAction(address target, uint256 value, bytes memory data, uint256 topic) private view {
        require(data.length >= 4 && value == 0, "Invalid action");
        if (target == address(betVault.registry())) {
            require(bytes4(data) == MarketRegistry.registerMarket.selector, "Unsupported registry action");
            return;
        }
        if (target == address(mandateHandler) && target != address(0)) {
            _validateMandate(data, topic);
            return;
        }
        require(target == address(betVault), "Unsupported action target");
        if (bytes4(data) == OrderVault.authorizeOrder.selector) {
            require(data.length == 260, "Invalid contract order calldata");
            _requireMarket(data, topic);
            return;
        }
        if (bytes4(data) != BetVault.authorizeBuy.selector) {
            _validateMaintenance(data, topic);
            return;
        }
        _validateBuyTopic(data, topic);
    }

    function _validateBuyTopic(bytes memory data, uint256 topic) private pure {
        // This action uses a static tuple: selector + id + six Buy fields.
        require(data.length == 228, "Invalid buy calldata");
        _requireMarket(data, topic);
    }

    /// releaseSafe(safe), or setMandate(safe, market, tokenId, limitPrice, budget, feeCap, deadline): the market is the
    /// proposal topic and the token one of its two outcomes.
    function _validateMandate(bytes memory data, uint256 topic) private view {
        if (bytes4(data) == SafeMandateHandler.releaseSafe.selector) {
            require(data.length == 36, "Invalid release calldata");
            return;
        }
        require(bytes4(data) == SafeMandateHandler.setMandate.selector && data.length == 228, "Unsupported mandate action");
        _requireMarket(data, topic);
        uint256 tokenId;
        assembly ("memory-safe") { tokenId := mload(add(data, 100)) }
        (uint256 yesToken, uint256 noToken,,,) = betVault.registry().markets(topic);
        require(tokenId == yesToken || tokenId == noToken, "Mandate token mismatch");
    }

    function _requireMarket(bytes memory data, uint256 topic) private pure {
        uint256 actionMarket;
        assembly ("memory-safe") { actionMarket := mload(add(data, 68)) }
        require(actionMarket == topic, "Proposal market mismatch");
    }

    function _validateMaintenance(bytes memory data, uint256 topic) private view {
        bytes4 selector = bytes4(data);
        if (selector == VaultRedemption.redeem.selector) {
            uint256 market;
            assembly ("memory-safe") { market := mload(add(data, 36)) }
            require(data.length == 36 && market == topic, "Redemption market mismatch");
        } else if (selector == VaultRedemption.configureRedemptionGas.selector) {
            require(data.length == 164, "Invalid gas allocation calldata");
        } else if (selector == OrderVault.cancelOrder.selector) {
            bytes32 id;
            assembly ("memory-safe") { id := mload(add(data, 36)) }
            require(data.length == 36 && OrderVault(payable(address(betVault))).orderMarket(id) == topic, "Cancellation market mismatch");
        } else if (selector == BetVault.cancel.selector) {
            bytes32 id;
            assembly ("memory-safe") { id := mload(add(data, 36)) }
            (uint256 market,,,,,) = betVault.buys(id);
            require(data.length == 36 && market == topic, "Cancellation market mismatch");
        } else if (selector == BetVault.transferPosition.selector) {
            _validatePositionTopic(data, topic);
        } else {
            // Treasury maintenance remains an explicit vote by the declared market's electorate.
            require(selector == BetVault.withdrawCollateral.selector || selector == BetVault.withdrawNative.selector, "Unsupported vault action");
        }
    }

    /// Queue and execution pay their own immediate caller under the voted redemption policy.
    function queue(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash)
        public override nonReentrant returns (uint256 proposalId)
    {
        uint256 startGas = gasleft();
        proposalId = super.queue(targets, values, calldatas, descriptionHash);
        _refundRedemption(targets, values, calldatas, proposalId, startGas);
    }

    function execute(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash)
        public payable override nonReentrant returns (uint256 proposalId)
    {
        uint256 startGas = gasleft();
        proposalId = super.execute(targets, values, calldatas, descriptionHash);
        _refundRedemption(targets, values, calldatas, proposalId, startGas);
    }

    function _refundRedemption(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, uint256 proposalId, uint256 startGas) private {
        if (_isRedemption(targets, values, calldatas))
            VaultRedemption(payable(address(betVault))).reimburseRedemption(proposalId, proposalTopic[proposalId], payable(msg.sender), startGas - gasleft());
    }

    function _isRedemption(address[] memory targets, uint256[] memory values, bytes[] memory calldatas) private view returns (bool) {
        return targets.length == 1 && values.length == 1 && calldatas.length == 1 && targets[0] == address(betVault)
            && values[0] == 0 && calldatas[0].length == 36 && bytes4(calldatas[0]) == VaultRedemption.redeem.selector;
    }

    function _validatePositionTopic(bytes memory data, uint256 topic) private view {
        uint256 tokenId;
        assembly ("memory-safe") { tokenId := mload(add(data, 68)) }
        (uint256 yesToken, uint256 noToken,,,) = betVault.registry().markets(topic);
        require(data.length == 100 && (tokenId == yesToken || tokenId == noToken), "Position market mismatch");
    }
}
