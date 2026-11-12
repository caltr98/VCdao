// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

interface ISafeModuleTarget {
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation) external returns (bool);
}

interface IMandates {
    function mandates(address safe) external view returns (uint256, uint256, uint256, uint256, uint64 deadline, uint256, uint256);
    function collateral() external view returns (IERC20);
}

interface IConditionalTokens {
    function redeemPositions(IERC20 collateral, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external;
}

/// Permissionless Safe module: once a condition has resolved (the CTF reverts before), anyone may
/// redeem the Safe's binary positions and move the redeemed USDC.e to the immutable treasury. It
/// never moves pUSD, so no caller can pull an approved budget before it fills; the DAO Timelock
/// module covers every other recovery. No call can choose a different recipient.
contract SafeSweeper {
    address public immutable treasury;
    /// Collateral of the CTF positions (USDC.e on Polygon), distinct from the exchange's pUSD.
    IERC20 public immutable redemptionCollateral;
    IERC1155 public immutable positions;
    /// Zero disables `recover`.
    IMandates public immutable mandates;

    error ModuleCallFailed();
    error MandateActive();

    constructor(address treasury_, IERC20 redemptionCollateral_, IERC1155 positions_, IMandates mandates_) {
        treasury = treasury_;
        redemptionCollateral = redemptionCollateral_;
        positions = positions_;
        mandates = mandates_;
    }

    /// Return the Safe's unspent pUSD to the treasury once it has no active mandate (never set,
    /// cleared or past its deadline). No fill can succeed then, so no pending budget is pulled.
    function recover(ISafeModuleTarget safe) external {
        if (address(mandates) == address(0)) revert MandateActive();
        (,,,, uint64 deadline,,) = mandates.mandates(address(safe));
        if (deadline != 0 && block.timestamp <= deadline) revert MandateActive();
        _sweep(safe, mandates.collateral());
    }

    /// Redeem both outcomes of a resolved binary condition (standard, non-neg-risk markets), then
    /// send the redeemed collateral to the treasury. pUSD stays: it may fund another pending order.
    function redeem(ISafeModuleTarget safe, bytes32 conditionId) external {
        uint256[] memory indexSets = new uint256[](2);
        indexSets[0] = 1;
        indexSets[1] = 2;
        _exec(safe, address(positions), abi.encodeCall(IConditionalTokens.redeemPositions, (redemptionCollateral, bytes32(0), conditionId, indexSets)));
        _sweep(safe, redemptionCollateral);
    }

    function _sweep(ISafeModuleTarget safe, IERC20 token) private {
        uint256 amount = token.balanceOf(address(safe));
        if (amount > 0) _exec(safe, address(token), abi.encodeCall(IERC20.transfer, (treasury, amount)));
    }

    function _exec(ISafeModuleTarget safe, address to, bytes memory data) private {
        if (!safe.execTransactionFromModule(to, 0, data, 0)) revert ModuleCallFailed();
    }
}
