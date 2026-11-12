// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./MockAssets.sol";
import "../VaultRedemption.sol";

contract MockResolvedPositions is MockPositions {
    mapping(bytes32 => uint256) public getOutcomeSlotCount;
    mapping(bytes32 => uint256) public payoutDenominator;
    mapping(bytes32 => mapping(uint256 => uint256)) public payoutNumerators;

    function prepare(bytes32 condition, uint256 slots) external { getOutcomeSlotCount[condition] = slots; }
    function resolve(bytes32 condition, uint256 yes, uint256 no) external {
        payoutNumerators[condition][0] = yes;
        payoutNumerators[condition][1] = no;
        payoutDenominator[condition] = yes + no;
    }
    function getCollectionId(bytes32 parent, bytes32 condition, uint256 indexSet) external pure returns (bytes32) {
        return keccak256(abi.encode(parent, condition, indexSet));
    }
    function getPositionId(address asset, bytes32 collection) external pure returns (uint256) {
        return uint256(keccak256(abi.encode(asset, collection)));
    }
    function burn(address owner, uint256 id, uint256 amount) external {
        require(msg.sender == owner || isApprovedForAll(owner, msg.sender), "Not approved");
        _burn(owner, id, amount);
    }
}

contract MockRedemptionAdapter is ICollateralAdapter {
    address public immutable CONDITIONAL_TOKENS;
    address public immutable COLLATERAL_TOKEN;
    address public immutable USDCE;
    uint256 public mode;
    bool public reentryAccepted;

    constructor(address asset, address ctf) { COLLATERAL_TOKEN = asset; USDCE = asset; CONDITIONAL_TOKENS = ctf; }
    function setMode(uint256 mode_) external { mode = mode_; }
    function redeemPositions(address, bytes32, bytes32 condition, uint256[] calldata) external {
        require(mode != 4, "Adapter failed");
        if (mode == 3) (reentryAccepted,) = msg.sender.call(abi.encodeWithSignature("redeem(uint256)", uint256(condition)));
        uint256 payout = _consume(condition, 1, 0) + _consume(condition, 2, 1);
        MockCollateral(COLLATERAL_TOKEN).mint(msg.sender, mode == 1 && payout > 0 ? payout - 1 : payout);
    }
    function _consume(bytes32 condition, uint256 indexSet, uint256 index) private returns (uint256) {
        MockResolvedPositions ctf = MockResolvedPositions(CONDITIONAL_TOKENS);
        uint256 id = ctf.getPositionId(USDCE, ctf.getCollectionId(bytes32(0), condition, indexSet));
        uint256 amount = ctf.balanceOf(msg.sender, id);
        if (mode != 2) ctf.burn(msg.sender, id, amount);
        return Math.mulDiv(amount, ctf.payoutNumerators(condition, index), ctf.payoutDenominator(condition));
    }
}
