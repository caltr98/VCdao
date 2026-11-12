// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/// Relayer probe: accepts an ERC1155 push from a contract caller and sends it straight back.
contract ShareReturner {
    function onERC1155Received(address, address from, uint256 id, uint256 value, bytes calldata) external returns (bytes4) {
        IERC1155(msg.sender).safeTransferFrom(address(this), from, id, value, "");
        return this.onERC1155Received.selector;
    }
}
