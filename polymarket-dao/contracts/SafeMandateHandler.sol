// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

/// Safe 1.3.0 fallback handler that accepts outcome tokens only as the settlement of the voted BUY.
/// The Safe forwards onERC1155Received here with itself as msg.sender, and a revert undoes the whole
/// exchange match, so the trading EOA cannot fill any other order for the Safe. Only transfers sent
/// by the exchange itself count: on the V2 exchange those are the paths that pull the Safe's pUSD
/// (fill and fee) before delivering tokens. Direct seller-to-Safe (complementary) fills deliver tokens
/// before payment and are refused. Like SafeReceiverHandler it has no isValidSignature. Enabled
/// also as a Safe module, it lets a vote remove the trader guard (`releaseSafe`).
interface ISafeModuleExec {
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation) external returns (bool);
}

contract SafeMandateHandler is IERC1155Receiver {
    struct Mandate {
        uint256 tokenId;
        uint256 limitPrice; // pUSD per share, 6 decimals
        uint256 budget;
        uint256 feeCap;
        uint64 deadline; // zero: no mandate
        uint256 fundedBalance; // the Safe's pUSD when the mandate was set
        uint256 startShares; // the Safe's tokenId balance when the mandate was set
    }

    uint256 private constant PRICE_UNIT = 1e6;
    address public immutable timelock;
    IERC20 public immutable collateral;
    IERC1155 public immutable positions;
    address public immutable exchange;
    mapping(address => Mandate) public mandates;

    event MandateSet(address indexed safe, uint256 indexed market, uint256 indexed tokenId, uint256 limitPrice, uint256 budget, uint256 feeCap, uint64 deadline);
    event MandateCleared(address indexed safe);
    event SafeReleased(address indexed safe);

    error OnlyTimelock();
    error InvalidMandate();
    error NoActiveMandate();
    error NotExchangeSettlement();
    error WrongToken();
    error BudgetExceeded();
    error PriceAboveLimit();
    error BatchNotAccepted();
    error ModuleCallFailed();

    constructor(address timelock_, IERC20 collateral_, IERC1155 positions_, address exchange_) {
        timelock = timelock_;
        collateral = collateral_;
        positions = positions_;
        exchange = exchange_;
    }

    /// Called by the proposal that funds the Safe, after the funding call: the current pUSD balance
    /// is the reference for everything the Safe spends under this mandate. `market` is checked
    /// against the proposal topic by the Governor.
    function setMandate(address safe, uint256 market, uint256 tokenId, uint256 limitPrice, uint256 budget, uint256 feeCap, uint64 deadline) external {
        if (msg.sender != timelock) revert OnlyTimelock();
        if (limitPrice == 0 || limitPrice > PRICE_UNIT || deadline <= block.timestamp) revert InvalidMandate();
        mandates[safe] = Mandate(tokenId, limitPrice, budget, feeCap, deadline, collateral.balanceOf(safe), positions.balanceOf(safe, tokenId));
        emit MandateSet(safe, market, tokenId, limitPrice, budget, feeCap, deadline);
    }

    function clearMandate(address safe) external {
        if (msg.sender != timelock) revert OnlyTimelock();
        delete mandates[safe];
        emit MandateCleared(safe);
    }

    /// Voted release: clears the mandate and removes the Safe's guard, so its owner regains full
    /// control. Requires this handler to be an enabled module of the Safe.
    function releaseSafe(address safe) external {
        if (msg.sender != timelock) revert OnlyTimelock();
        delete mandates[safe];
        if (!ISafeModuleExec(safe).execTransactionFromModule(safe, 0, abi.encodeWithSignature("setGuard(address)", address(0)), 0)) revert ModuleCallFailed();
        emit SafeReleased(safe);
    }

    /// Cumulative over partial fills: everything spent since the mandate was set must stay within
    /// the budget and within the limit price for every share received, plus the fee cap.
    function onERC1155Received(address operator, address from, uint256 id, uint256, bytes calldata) external view returns (bytes4) {
        Mandate storage m = mandates[msg.sender];
        if (m.deadline == 0 || block.timestamp > m.deadline) revert NoActiveMandate();
        if (operator != exchange || from != exchange) revert NotExchangeSettlement();
        if (id != m.tokenId) revert WrongToken();
        uint256 balance = collateral.balanceOf(msg.sender);
        uint256 spent = balance < m.fundedBalance ? m.fundedBalance - balance : 0;
        if (spent > m.budget + m.feeCap) revert BudgetExceeded();
        uint256 shares = positions.balanceOf(msg.sender, id);
        shares = shares > m.startShares ? shares - m.startShares : 0;
        if (spent > m.limitPrice * shares / PRICE_UNIT + m.feeCap) revert PriceAboveLimit();
        return this.onERC1155Received.selector;
    }

    /// The V2 exchange never batch-transfers to a maker.
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) {
        revert BatchNotAccepted();
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == 0x01ffc9a7;
    }
}
