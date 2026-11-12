// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

/// Safe fallback handler that only accepts ERC1155 transfers. Unlike the default compatibility
/// handler it has no isValidSignature, so no owner signature can act as an ERC-1271 Safe signature.
contract SafeReceiverHandler is ERC1155Holder {}
