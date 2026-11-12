// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./BetVault.sol";
import "./OrderWallet.sol";

/// Primary route: treasury-funded contract orders. BetVault's delivery route remains available.
contract OrderVault is BetVault {
    using SafeERC20 for IERC20;

    address public immutable standardExchange;
    address public immutable negativeRiskExchange;
    mapping(bytes32 => OrderWallet) public orderWallets;

    event ContractOrderAuthorized(bytes32 indexed id, uint256 indexed market, address indexed wallet, bytes32 orderHash, uint256 budget, uint64 deadline);

    constructor(
        address timelock_, IERC20 collateral_, IERC1155 positions_, MarketRegistry registry_,
        address standardExchange_, address negativeRiskExchange_
    ) BetVault(timelock_, collateral_, positions_, registry_) {
        require(standardExchange_.code.length > 0 && negativeRiskExchange_.code.length > 0, "Invalid exchange");
        standardExchange = standardExchange_;
        negativeRiskExchange = negativeRiskExchange_;
    }

    function authorizeOrder(bytes32 id, PolymarketOrder.Buy calldata buy) external onlyTimelock nonReentrant {
        _validateOrder(id, buy);
        OrderWallet wallet = new OrderWallet(collateral, positions, id, buy);
        orderWallets[id] = wallet;
        collateral.safeTransfer(address(wallet), buy.principal + buy.feeBudget);
        emit ContractOrderAuthorized(id, buy.market, address(wallet), wallet.orderHash(), wallet.budget(), buy.deadline);
    }

    function _validateOrder(bytes32 id, PolymarketOrder.Buy calldata buy) private view {
        require(id != bytes32(0) && address(orderWallets[id]) == address(0) && status[id] == Status.Unknown, "Repeated authorization");
        require(buy.exchange == standardExchange || buy.exchange == negativeRiskExchange, "Unsupported exchange");
        registry.validateBuy(buy.market, buy.tokenId, buy.deadline);
        require(buy.principal > 0 && buy.principal + buy.feeBudget < buy.shares, "Invalid order budget");
        require(collateral.balanceOf(address(this)) >= reserved + buy.principal + buy.feeBudget, "Insufficient free collateral");
    }

    function _validateBuy(bytes32 id, Buy calldata buy) internal view virtual override {
        require(address(orderWallets[id]) == address(0), "Repeated authorization");
        super._validateBuy(id, buy);
    }

    function cancelOrder(bytes32 id) external onlyTimelock {
        require(address(orderWallets[id]) != address(0), "Unknown order");
        orderWallets[id].cancel();
    }

    function orderMarket(bytes32 id) external view returns (uint256) {
        require(address(orderWallets[id]) != address(0), "Unknown order");
        return orderWallets[id].market();
    }
}
