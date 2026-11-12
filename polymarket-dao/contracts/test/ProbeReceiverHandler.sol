// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/// Fork probe: a Safe fallback handler that accepts every ERC1155 transfer and records what the Safe
/// holds at the moment the hook runs.
contract ProbeReceiverHandler {
    struct Hit { address safe; address operator; address from; uint256 id; uint256 value; uint256 collateral; uint256 shares; bool batch; }

    IERC20 public immutable collateral;
    IERC1155 public immutable positions;
    Hit[] private hits;

    constructor(IERC20 collateral_, IERC1155 positions_) {
        collateral = collateral_;
        positions = positions_;
    }

    function onERC1155Received(address operator, address from, uint256 id, uint256 value, bytes calldata) external returns (bytes4) {
        hits.push(Hit(msg.sender, operator, from, id, value, collateral.balanceOf(msg.sender), positions.balanceOf(msg.sender, id), false));
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address operator, address from, uint256[] calldata ids, uint256[] calldata values, bytes calldata) external returns (bytes4) {
        for (uint256 i; i < ids.length; i++) hits.push(Hit(msg.sender, operator, from, ids[i], values[i], collateral.balanceOf(msg.sender), positions.balanceOf(msg.sender, ids[i]), true));
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x4e2312e0 || interfaceId == 0x01ffc9a7;
    }

    function allHits() external view returns (Hit[] memory) {
        return hits;
    }
}
