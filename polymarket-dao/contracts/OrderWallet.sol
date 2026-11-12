// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./PolymarketOrder.sol";

/// One approved order, one bounded allowance, and one immutable DAO recipient.
contract OrderWallet is IERC1271, ERC1155Holder, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State { Active, Collected, Expired, Cancelled }
    address public immutable treasury;
    IERC20 public immutable collateral;
    IERC1155 public immutable positions;
    address public immutable exchange;
    uint256 public immutable market;
    uint64 public immutable deadline;
    uint256 public immutable budget;
    bytes32 public immutable orderHash;
    State public state;
    PolymarketOrder.Order private approvedOrder;

    event WalletClosed(State state, uint256 sharesReturned, uint256 collateralReturned);

    constructor(IERC20 collateral_, IERC1155 positions_, bytes32 id, PolymarketOrder.Buy memory buy) {
        treasury = msg.sender;
        collateral = collateral_;
        positions = positions_;
        exchange = buy.exchange;
        market = buy.market;
        deadline = buy.deadline;
        budget = buy.principal + buy.feeBudget;
        approvedOrder = _buildOrder(id, buy);
        orderHash = IPolymarketExchange(exchange).hashOrder(approvedOrder);
        collateral.forceApprove(exchange, budget);
    }

    /// The official SDKs keep the salt at or below 2^53 so it stays an exact JSON number;
    /// the full intent ID stays in metadata.
    function _buildOrder(bytes32 id, PolymarketOrder.Buy memory buy) private view returns (PolymarketOrder.Order memory) {
        return PolymarketOrder.Order({
            salt: uint256(id) >> 203, maker: address(this), signer: address(this), tokenId: buy.tokenId,
            makerAmount: buy.principal, takerAmount: buy.shares, side: 0, signatureType: 3,
            timestamp: block.timestamp * 1000, metadata: id, builder: bytes32(0), signature: hex"01"
        });
    }

    function getOrder() external view returns (PolymarketOrder.Order memory) {
        return approvedOrder;
    }

    /// The nonempty marker requests live ERC1271 validation at the exchange.
    /// A caller can transport this order but cannot authorize different terms.
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        bool active = state == State.Active && block.timestamp <= deadline;
        bool approved = hash == orderHash && signature.length == 1 && signature[0] == 0x01;
        return active && approved ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function canCollect() public view returns (bool) {
        return state == State.Active && (block.timestamp > deadline || positions.balanceOf(address(this), approvedOrder.tokenId) >= approvedOrder.takerAmount);
    }

    /// Anyone may finish the job. The recipient is always the DAO treasury.
    function collect() external nonReentrant {
        require(canCollect(), "Order still active");
        bool filled = positions.balanceOf(address(this), approvedOrder.tokenId) >= approvedOrder.takerAmount;
        _close(filled ? State.Collected : State.Expired);
    }

    function cancel() external nonReentrant {
        require(msg.sender == treasury && state == State.Active, "Only active treasury order");
        _close(State.Cancelled);
    }

    function _close(State next) private {
        state = next;
        // Cached exchange preapprovals may skip ERC1271. Remove spending authority first.
        collateral.forceApprove(exchange, 0);
        (uint256 shares, uint256 refund) = _returnAssets();
        emit WalletClosed(next, shares, refund);
    }

    function _returnAssets() private returns (uint256 shares, uint256 refund) {
        shares = positions.balanceOf(address(this), approvedOrder.tokenId);
        refund = collateral.balanceOf(address(this));
        if (shares > 0) positions.safeTransferFrom(address(this), treasury, approvedOrder.tokenId, shares, "");
        if (refund > 0) collateral.safeTransfer(treasury, refund);
    }

    /// Late donations cannot reopen an order; they can only return to its DAO.
    function recover() external nonReentrant {
        require(state != State.Active, "Order still active");
        _returnAssets();
    }
}
