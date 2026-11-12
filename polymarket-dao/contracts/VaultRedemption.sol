// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/governance/IGovernor.sol";
import "./BetVault.sol";

interface ICollateralAdapter {
    function CONDITIONAL_TOKENS() external view returns (address);
    function COLLATERAL_TOKEN() external view returns (address);
    function USDCE() external view returns (address);
    function redeemPositions(address collateralToken, bytes32 parent, bytes32 condition, uint256[] calldata indexSets) external;
}

interface IResolvedPositions {
    function getOutcomeSlotCount(bytes32 condition) external view returns (uint256);
    function payoutDenominator(bytes32 condition) external view returns (uint256);
    function payoutNumerators(bytes32 condition, uint256 index) external view returns (uint256);
    function getCollectionId(bytes32 parent, bytes32 condition, uint256 indexSet) external view returns (bytes32);
    function getPositionId(address collateralToken, bytes32 collection) external view returns (uint256);
}

interface IRedemptionGovernor is IGovernor {
    function betVault() external view returns (address);
    function timelock() external view returns (address);
    function proposalTopic(uint256 id) external view returns (uint256);
}

/// The standard-market adapter pays its caller. Here the caller is always the vault.
abstract contract VaultRedemption is BetVault {
    error InvalidRefundProposal();
    ICollateralAdapter public immutable redemptionAdapter;
    address public immutable positionCollateral;
    IRedemptionGovernor public redemptionGovernor;
    uint256 public redemptionGasBudget;
    uint256 public refundLiability;
    uint256 public maxRedemptionRefund;
    uint256 public maxRedemptionGasPrice;
    uint256 public maxRedemptionGasUnits;
    uint256 public redemptionGasOverhead;
    mapping(uint256 => bool) public redemptionRefunded;
    mapping(uint256 => bool) private redemptionQueueRefunded;
    mapping(address => uint256) public refundCredit;

    event PositionRedeemed(uint256 indexed market, address indexed caller, uint256 yesShares, uint256 noShares, uint256 payout);
    event RedemptionGasConfigured(uint256 budget, uint256 maxRefund, uint256 maxGasPrice, uint256 maxGasUnits, uint256 overhead);
    event RedemptionRefund(uint256 indexed proposal, uint256 indexed market, address indexed caller, uint256 gasUnits, uint256 gasPrice, uint256 amount, bool delivered);
    event RefundClaimed(address indexed caller, uint256 amount);

    constructor(ICollateralAdapter adapter_, IERC20 collateral_, IERC1155 positions_) {
        require(address(adapter_).code.length > 0, "Invalid redemption adapter");
        require(adapter_.COLLATERAL_TOKEN() == address(collateral_) && adapter_.CONDITIONAL_TOKENS() == address(positions_), "Wrong adapter assets");
        redemptionAdapter = adapter_;
        positionCollateral = adapter_.USDCE();
        require(positionCollateral.code.length > 0, "Invalid position collateral");
    }

    /// The voted Timelock action redeems after genuine resolution and pays this vault.
    function redeem(uint256 market) external onlyTimelock nonReentrant returns (uint256 payout) {
        (uint256 yes, uint256 no, uint256 expected) = _redemptionAmounts(market);
        uint256 beforeBalance = collateral.balanceOf(address(this));
        _redeemCondition(bytes32(market));
        payout = _verifyRedemption(market, beforeBalance, expected);
        emit PositionRedeemed(market, msg.sender, yes, no, payout);
    }

    /// Bootstrap wiring is sealed before deployment role handover. It grants no withdrawal right.
    function bindRedemptionGovernor(IRedemptionGovernor governor_) external onlyTimelock {
        require(address(redemptionGovernor) == address(0), "Governor already bound");
        require(governor_.betVault() == address(this) && governor_.timelock() == timelock, "Wrong redemption governor");
        redemptionGovernor = governor_;
    }

    /// Set the remaining allocation, not an additive caller allowance. Credits remain reserved.
    function configureRedemptionGas(uint256 budget, uint256 maxRefund, uint256 maxGasPrice, uint256 maxGasUnits, uint256 overhead) external onlyTimelock {
        require(budget <= address(this).balance - refundLiability, "Insufficient native funds");
        require(maxGasUnits >= overhead && maxGasUnits <= 5_000_000 && overhead <= 150_000, "Invalid gas policy");
        require(maxGasPrice <= 10_000 gwei, "Invalid gas price cap");
        (redemptionGasBudget, maxRedemptionRefund, maxRedemptionGasPrice) = (budget, maxRefund, maxGasPrice);
        (maxRedemptionGasUnits, redemptionGasOverhead) = (maxGasUnits, overhead);
        emit RedemptionGasConfigured(budget, maxRefund, maxGasPrice, maxGasUnits, overhead);
    }

    /// Only the bound Governor supplies measured gas and the immediate queue or execution caller.
    function reimburseRedemption(uint256 proposal, uint256 market, address payable caller, uint256 measuredGas) external nonReentrant {
        require(msg.sender == address(redemptionGovernor), "Only redemption governor");
        IGovernor.ProposalState state = redemptionGovernor.state(proposal);
        if ((state != IGovernor.ProposalState.Queued && state != IGovernor.ProposalState.Executed) || redemptionGovernor.proposalTopic(proposal) != market) revert InvalidRefundProposal();
        if (state == IGovernor.ProposalState.Queued) {
            require(!redemptionQueueRefunded[proposal], "Redemption already refunded");
            redemptionQueueRefunded[proposal] = true;
        } else {
            require(!redemptionRefunded[proposal], "Redemption already refunded");
            redemptionRefunded[proposal] = true;
        }
        _refundExecution(proposal, market, caller, measuredGas);
    }

    function _refundExecution(uint256 proposal, uint256 market, address payable caller, uint256 measuredGas) private {
        uint256 units = Math.min(measuredGas + redemptionGasOverhead, maxRedemptionGasUnits);
        uint256 price = Math.min(tx.gasprice, maxRedemptionGasPrice);
        uint256 amount = Math.min(Math.min(units * price, maxRedemptionRefund), redemptionGasBudget);
        redemptionGasBudget -= amount;
        // A rejected transfer cannot undo redemption or make its allocation spendable twice.
        bool delivered = amount == 0 || _deliverRefund(caller, amount);
        emit RedemptionRefund(proposal, market, caller, units, price, amount, delivered);
    }

    function _deliverRefund(address payable caller, uint256 amount) private returns (bool sent) {
        (sent,) = caller.call{value: amount, gas: 30_000}("");
        if (!sent) {
            refundCredit[caller] += amount;
            refundLiability += amount;
        }
    }

    function claimRedemptionRefund() external nonReentrant {
        uint256 amount = refundCredit[msg.sender];
        require(amount > 0, "No refund credit");
        refundCredit[msg.sender] = 0;
        refundLiability -= amount;
        (bool sent,) = payable(msg.sender).call{value: amount}("");
        require(sent, "Native transfer failed");
        emit RefundClaimed(msg.sender, amount);
    }

    function _availableNative() internal view virtual override returns (uint256) {
        return address(this).balance - redemptionGasBudget - refundLiability;
    }

    function _redemptionAmounts(uint256 market) private view returns (uint256 yes, uint256 no, uint256 expected) {
        (uint256 yesToken, uint256 noToken,,, bool exists) = registry.markets(market);
        require(exists, "Unknown market");
        IResolvedPositions ctf = IResolvedPositions(address(positions));
        _validateCondition(ctf, bytes32(market), yesToken, noToken);
        uint256 denominator = ctf.payoutDenominator(bytes32(market));
        require(denominator > 0, "Market unresolved");
        yes = positions.balanceOf(address(this), yesToken);
        no = positions.balanceOf(address(this), noToken);
        require(yes > 0 || no > 0, "No position");
        expected = Math.mulDiv(yes, ctf.payoutNumerators(bytes32(market), 0), denominator)
            + Math.mulDiv(no, ctf.payoutNumerators(bytes32(market), 1), denominator);
    }

    function previewRedemption(uint256 market) external view returns (uint256 yes, uint256 no, uint256 expected) {
        return _redemptionAmounts(market);
    }

    function _validateCondition(IResolvedPositions ctf, bytes32 condition, uint256 yesToken, uint256 noToken) private view {
        require(ctf.getOutcomeSlotCount(condition) == 2, "Not a binary condition");
        require(yesToken == _positionId(ctf, condition, 1) && noToken == _positionId(ctf, condition, 2), "Wrong condition outcomes");
    }

    function _positionId(IResolvedPositions ctf, bytes32 condition, uint256 indexSet) private view returns (uint256) {
        return ctf.getPositionId(positionCollateral, ctf.getCollectionId(bytes32(0), condition, indexSet));
    }

    function _redeemCondition(bytes32 condition) private {
        uint256[] memory indices = new uint256[](2);
        indices[0] = 1;
        indices[1] = 2;
        // ERC1155 approval covers every holding, so keep it inside this guarded transaction.
        positions.setApprovalForAll(address(redemptionAdapter), true);
        redemptionAdapter.redeemPositions(address(collateral), bytes32(0), condition, indices);
        positions.setApprovalForAll(address(redemptionAdapter), false);
    }

    function _verifyRedemption(uint256 market, uint256 beforeBalance, uint256 expected) private view returns (uint256) {
        (uint256 yesToken, uint256 noToken,,,) = registry.markets(market);
        require(positions.balanceOf(address(this), yesToken) == 0 && positions.balanceOf(address(this), noToken) == 0, "Position not consumed");
        uint256 afterBalance = collateral.balanceOf(address(this));
        require(afterBalance >= beforeBalance + expected, "Missing vault payout");
        return afterBalance - beforeBalance;
    }
}
