// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./MarketRegistry.sol";

/// Fixed-price delivery: collateral stays here until the approved outcome tokens arrive.
contract BetVault is ERC1155Holder, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Buy {
        uint256 market;
        uint256 tokenId;
        uint256 shares;
        uint256 payment;
        uint64 deadline;
        address executor;
    }

    enum Status { Unknown, Authorized, Fulfilled, Expired, Cancelled }
    address public immutable timelock;
    IERC20 public immutable collateral;
    IERC1155 public immutable positions;
    MarketRegistry public immutable registry;
    uint256 public reserved;
    mapping(bytes32 => Buy) public buys;
    mapping(bytes32 => Status) public status;
    mapping(bytes32 => bool) public usedOrderHash;
    mapping(bytes32 => uint64) public authorizedAt;

    event BuyAuthorized(bytes32 indexed id, uint256 indexed market, uint256 indexed tokenId, uint256 shares, uint256 payment, uint64 deadline, address executor);
    // The transaction hash is an audit reference; Solidity does not verify historical receipts.
    event PositionDelivered(bytes32 indexed id, address indexed executor, bytes32 indexed settlementTx, bytes32 orderHash, uint256 shares, uint256 payment);
    event BuyClosed(bytes32 indexed id, Status status);

    modifier onlyTimelock() {
        require(msg.sender == timelock, "Only timelock");
        _;
    }

    constructor(address timelock_, IERC20 collateral_, IERC1155 positions_, MarketRegistry registry_) {
        require(timelock_ != address(0), "Invalid timelock");
        require(address(collateral_).code.length > 0 && address(positions_).code.length > 0, "Invalid assets");
        require(address(registry_).code.length > 0 && registry_.timelock() == timelock_, "Invalid registry");
        timelock = timelock_;
        collateral = collateral_;
        positions = positions_;
        registry = registry_;
    }

    // Preserves VCdao's native-currency membership deposits, separate from trading collateral.
    receive() external payable {}

    function authorizeBuy(bytes32 id, Buy calldata buy) external onlyTimelock {
        _validateBuy(id, buy);
        buys[id] = buy;
        status[id] = Status.Authorized;
        authorizedAt[id] = uint64(block.timestamp);
        reserved += buy.payment;
        emit BuyAuthorized(id, buy.market, buy.tokenId, buy.shares, buy.payment, buy.deadline, buy.executor);
    }

    function _validateBuy(bytes32 id, Buy calldata buy) internal view virtual {
        require(id != bytes32(0) && status[id] == Status.Unknown, "Repeated authorization");
        registry.validateBuy(buy.market, buy.tokenId, buy.deadline);
        require(buy.shares > 0 && buy.payment > 0 && buy.payment < buy.shares, "Invalid quote");
        require(buy.executor != address(this), "Invalid executor");
        require(collateral.balanceOf(address(this)) >= reserved + buy.payment, "Insufficient free collateral");
    }

    /// Executor must hold the entire position and approve this vault as an ERC1155 operator.
    /// A named executor gets the approved payment as a fixed quote, inclusive of costs and margin.
    /// With no named executor, anyone may deliver and the price is a Dutch auction: it rises
    /// linearly from zero at authorization to the approved payment at the deadline, so the first
    /// solver to deliver sets it near market cost. The unpaid remainder stays in the treasury.
    function fulfill(bytes32 id, bytes32 settlementTx, bytes32 orderHash) external nonReentrant {
        Buy memory buy = buys[id];
        _validateDelivery(id, buy, settlementTx, orderHash);
        uint256 price = currentPayment(id);
        usedOrderHash[orderHash] = true;
        _close(id, Status.Fulfilled);
        _receivePosition(buy);
        collateral.safeTransfer(msg.sender, price);
        emit PositionDelivered(id, msg.sender, settlementTx, orderHash, buy.shares, price);
    }

    /// Push delivery for wallets that cannot approve operators (Polymarket's relayer allowlists
    /// them): the solver sends exactly the shares with data = abi.encode(id, settlementTx, orderHash)
    /// and is paid in the same call. Transfers with other data are accepted as plain receipts.
    function onERC1155Received(address operator, address from, uint256 tokenId, uint256 value, bytes memory data) public override returns (bytes4) {
        if (msg.sender == address(positions) && data.length == 96) _fulfillPushed(from, tokenId, value, data);
        return super.onERC1155Received(operator, from, tokenId, value, data);
    }

    function _fulfillPushed(address from, uint256 tokenId, uint256 value, bytes memory data) private nonReentrant {
        (bytes32 id, bytes32 settlementTx, bytes32 orderHash) = abi.decode(data, (bytes32, bytes32, bytes32));
        Buy memory buy = buys[id];
        require(status[id] == Status.Authorized, "Not authorized");
        require(buy.executor == address(0) || from == buy.executor, "Wrong executor");
        require(block.timestamp <= buy.deadline, "Execution expired");
        require(settlementTx != bytes32(0) && orderHash != bytes32(0), "Missing audit reference");
        require(!usedOrderHash[orderHash], "Order reference reused");
        require(tokenId == buy.tokenId && value == buy.shares, "Wrong delivery");
        uint256 price = currentPayment(id);
        usedOrderHash[orderHash] = true;
        _close(id, Status.Fulfilled);
        collateral.safeTransfer(from, price);
        emit PositionDelivered(id, from, settlementTx, orderHash, buy.shares, price);
    }

    function currentPayment(bytes32 id) public view returns (uint256) {
        Buy memory buy = buys[id];
        if (buy.executor != address(0) || block.timestamp >= buy.deadline) return buy.payment;
        return buy.payment * (block.timestamp - authorizedAt[id]) / (buy.deadline - authorizedAt[id]);
    }

    function _validateDelivery(bytes32 id, Buy memory buy, bytes32 settlementTx, bytes32 orderHash) private view {
        require(status[id] == Status.Authorized, "Not authorized");
        require(buy.executor == address(0) || msg.sender == buy.executor, "Wrong executor");
        require(block.timestamp <= buy.deadline, "Execution expired");
        require(settlementTx != bytes32(0) && orderHash != bytes32(0), "Missing audit reference");
        require(!usedOrderHash[orderHash], "Order reference reused");
    }

    function _receivePosition(Buy memory buy) private {
        uint256 beforeBalance = positions.balanceOf(address(this), buy.tokenId);
        positions.safeTransferFrom(msg.sender, address(this), buy.tokenId, buy.shares, "");
        require(positions.balanceOf(address(this), buy.tokenId) == beforeBalance + buy.shares, "Wrong delivery");
    }

    function _close(bytes32 id, Status next) private {
        reserved -= buys[id].payment;
        status[id] = next;
        emit BuyClosed(id, next);
    }

    function expire(bytes32 id) external {
        require(status[id] == Status.Authorized && block.timestamp > buys[id].deadline, "Not expired");
        _close(id, Status.Expired);
    }

    function cancel(bytes32 id) external onlyTimelock {
        require(status[id] == Status.Authorized, "Not authorized");
        _close(id, Status.Cancelled);
    }

    function withdrawCollateral(address recipient, uint256 amount) external onlyTimelock nonReentrant {
        require(amount <= collateral.balanceOf(address(this)) - reserved, "Collateral reserved");
        collateral.safeTransfer(recipient, amount);
    }

    function transferPosition(address recipient, uint256 tokenId, uint256 amount) external onlyTimelock nonReentrant {
        positions.safeTransferFrom(address(this), recipient, tokenId, amount, "");
    }

    function withdrawNative(address payable recipient, uint256 amount) external onlyTimelock nonReentrant {
        require(amount <= _availableNative(), "Native funds reserved");
        (bool sent,) = recipient.call{value: amount}("");
        require(sent, "Native transfer failed");
    }

    function _availableNative() internal view virtual returns (uint256) {
        return address(this).balance;
    }
}
