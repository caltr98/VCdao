// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

contract MockCollateral is ERC20 {
    constructor() ERC20("Local mock pUSD", "MOCK") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address recipient, uint256 amount) external { _mint(recipient, amount); }
}

contract MockPositions is ERC1155 {
    constructor() ERC1155("") {}
    function mint(address recipient, uint256 tokenId, uint256 amount) external { _mint(recipient, tokenId, amount, ""); }
}
