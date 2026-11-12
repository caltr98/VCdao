// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// ABI fields of Polymarket's published V2 order, including its unsigned signature field.
library PolymarketOrder {
    struct Order {
        uint256 salt;
        address maker;
        address signer;
        uint256 tokenId;
        uint256 makerAmount;
        uint256 takerAmount;
        uint8 side;
        uint8 signatureType;
        uint256 timestamp;
        bytes32 metadata;
        bytes32 builder;
        bytes signature;
    }

    struct Buy {
        uint256 market;
        uint256 tokenId;
        uint256 principal;
        uint256 shares;
        uint256 feeBudget;
        uint64 deadline;
        address exchange;
    }
}

interface IPolymarketExchange {
    function hashOrder(PolymarketOrder.Order memory order) external view returns (bytes32);
}
