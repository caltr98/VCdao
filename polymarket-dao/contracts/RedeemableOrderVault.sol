// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./OrderVault.sol";
import "./VaultRedemption.sol";

/// Future deployments retain the existing treasury interface and add on-chain redemption.
contract RedeemableOrderVault is OrderVault, VaultRedemption {
    constructor(
        address timelock_, IERC20 collateral_, IERC1155 positions_, MarketRegistry registry_,
        address standardExchange_, address negativeRiskExchange_, ICollateralAdapter adapter_
    ) OrderVault(timelock_, collateral_, positions_, registry_, standardExchange_, negativeRiskExchange_)
      VaultRedemption(adapter_, collateral_, positions_) {}

    function _validateBuy(bytes32 id, Buy calldata buy) internal view override(BetVault, OrderVault) {
        OrderVault._validateBuy(id, buy);
    }

    function _availableNative() internal view override(BetVault, VaultRedemption) returns (uint256) {
        return VaultRedemption._availableNative();
    }
}
