// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../PolymarketOrder.sol";
import "./MockAssets.sol";

/// Models the V2 digest, signature cache, fill status and allowance boundary, not a real order book.
contract MockExchange is EIP712 {
    using SafeERC20 for IERC20;
    bytes32 private constant ORDER_TYPEHASH = keccak256("Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)");
    // Same packing as V2: remaining is zero both before the first fill and after the last one.
    struct OrderStatus { bool filled; uint248 remaining; }
    address public immutable operator = msg.sender;
    IERC20 public immutable collateral;
    MockPositions public immutable positions;
    mapping(bytes32 => bool) public preapproved;
    mapping(bytes32 => OrderStatus) public orderStatus;

    constructor(IERC20 collateral_, MockPositions positions_) EIP712("Polymarket CTF Exchange", "2") {
        collateral = collateral_;
        positions = positions_;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "Only operator");
        _;
    }

    function hashOrder(PolymarketOrder.Order memory order) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ORDER_TYPEHASH,
            order.salt, order.maker, order.signer, order.tokenId, order.makerAmount,
            order.takerAmount, order.side, order.signatureType, order.timestamp, order.metadata, order.builder)));
    }

    function validate(PolymarketOrder.Order memory order) public view {
        bytes32 digest = hashOrder(order);
        if (order.signature.length == 0 && preapproved[digest]) return;
        require(order.side == 0 && order.signatureType == 3 && order.maker == order.signer, "Wrong wallet type");
        require(IERC1271(order.signer).isValidSignature(digest, order.signature) == IERC1271.isValidSignature.selector, "Invalid signature");
    }

    /// V2's public pre-trade check: not already filled, then signature or preapproval.
    function validateOrder(PolymarketOrder.Order memory order) external view {
        require(!orderStatus[hashOrder(order)].filled, "Order already filled");
        validate(order);
    }

    function preapprove(PolymarketOrder.Order memory order) external onlyOperator {
        validate(order);
        preapproved[hashOrder(order)] = true;
    }

    function fill(PolymarketOrder.Order memory order, uint256 principal, uint256 shares, uint256 fee) external onlyOperator {
        validate(order);
        _updateStatus(hashOrder(order), order.makerAmount, principal);
        require(shares * order.makerAmount >= principal * order.takerAmount, "Price exceeds limit");
        collateral.safeTransferFrom(order.maker, operator, principal + fee);
        positions.mint(order.maker, order.tokenId, shares);
    }

    function _updateStatus(bytes32 digest, uint256 makerAmount, uint256 principal) private {
        OrderStatus storage status = orderStatus[digest];
        uint256 remaining = status.remaining == 0 ? makerAmount : status.remaining;
        require(!status.filled && principal > 0 && principal <= remaining, "Order overfilled");
        status.remaining = uint248(remaining - principal);
        status.filled = status.remaining == 0;
    }
}
