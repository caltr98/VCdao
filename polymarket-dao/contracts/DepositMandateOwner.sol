// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "./BetVault.sol";

interface IDepositMandateWallet {
    function pendingOwner() external view returns (address);
    function pendingOwnerNonce() external view returns (uint256);
    function pause() external;
    function revokeAllowance(address token, address spender) external;
    function withdrawERC20(address token, address to, uint256 amount) external;
    function withdrawERC1155(address token, address to, uint256[] calldata ids, uint256[] calldata amounts) external;
}

interface IDepositMandateFactory {
    function predictWalletAddress(bytes32 id) external view returns (address);
}

interface IDepositMandateGovernor {
    function state(uint256 proposalId) external view returns (uint8);
    function hashProposal(address[] memory targets, uint256[] memory values, bytes[] memory data, bytes32 descriptionHash) external pure returns (uint256);
}

/// One admission experiment: a voted order and a fixed refund to the DAO.
/// There is no deployer role or general signing authority.
contract DepositMandateOwner {
    using SafeERC20 for IERC20;
    address public immutable wallet;
    address public immutable treasury;
    address public immutable transport;
    address public immutable exchange;
    IERC20 public immutable collateral;
    IERC1155 public immutable positions;
    IDepositMandateGovernor public immutable governor;
    uint256 public immutable tokenId;
    uint256 public immutable market;
    uint256 public immutable shares;
    uint256 public immutable budget;
    uint256 public immutable deadline;
    uint256 public immutable fundingProposal;
    bytes32 public immutable orderDigest;
    bytes32 public immutable refundDigest;
    bytes32 public immutable approvalDigest;
    bytes32 public immutable walletDomain;
    bool public activated;
    bool public stopped;

    struct Plan {
        address wallet;
        address factory;
        address treasury;
        address transport;
        address exchange;
        address governor;
        uint256 market;
        uint256 tokenId;
        uint256 budget;
        uint256 shares;
        uint256 deadline;
        uint256 salt;
        uint256 timestamp;
        bytes32 metadata;
        bytes32 builder;
        bytes32 expectedOrderDigest;
        bytes32 refundDigest;
        bytes32 approvalDigest;
        bytes32 descriptionHash;
    }

    constructor(Plan memory plan) {
        address selectedWallet = plan.wallet;
        if (selectedWallet == address(0)) {
            require(plan.factory.code.length > 0, "Invalid factory");
            selectedWallet = IDepositMandateFactory(plan.factory).predictWalletAddress(bytes32(uint256(uint160(address(this)))));
        } else {
            require(selectedWallet.code.length > 0, "Invalid wallet");
        }
        require(plan.treasury.code.length > 0, "Invalid custody");
        require(plan.governor.code.length > 0 && plan.transport != address(0), "Invalid governance");
        require(plan.budget > 0 && plan.shares > plan.budget && plan.deadline > block.timestamp, "Invalid mandate");
        wallet = selectedWallet;
        treasury = plan.treasury;
        transport = plan.transport;
        exchange = plan.exchange;
        governor = IDepositMandateGovernor(plan.governor);
        collateral = BetVault(payable(plan.treasury)).collateral();
        positions = BetVault(payable(plan.treasury)).positions();
        tokenId = plan.tokenId;
        market = plan.market;
        shares = plan.shares;
        budget = plan.budget;
        deadline = plan.deadline;
        orderDigest = _orderDigest(plan, selectedWallet);
        require(orderDigest == plan.expectedOrderDigest, "Order fields mismatch");
        refundDigest = plan.refundDigest;
        approvalDigest = plan.approvalDigest;
        walletDomain = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("DepositWallet"), keccak256("1"), block.chainid, selectedWallet));
        fundingProposal = _fundingProposal(plan.descriptionHash);
    }

    function _orderDigest(Plan memory plan, address selectedWallet) private view returns (bytes32) {
        bytes32 orderType = keccak256("Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)");
        bytes32 contents = keccak256(abi.encode(orderType, plan.salt, selectedWallet, selectedWallet, plan.tokenId,
            plan.budget, plan.shares, uint8(0), uint8(3), plan.timestamp, plan.metadata, plan.builder));
        bytes32 typed = keccak256("TypedDataSign(Order contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)");
        bytes32 nested = keccak256(abi.encode(typed, contents, keccak256("DepositWallet"), keccak256("1"),
            block.chainid, selectedWallet, bytes32(0)));
        bytes32 appDomain = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Polymarket CTF Exchange"), keccak256("2"), block.chainid, plan.exchange));
        return keccak256(abi.encodePacked(hex"1901", appDomain, nested));
    }

    function _fundingProposal(bytes32 descriptionHash) private view returns (uint256) {
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        bytes[] memory data = new bytes[](1);
        targets[0] = treasury;
        data[0] = abi.encodeCall(BetVault.withdrawCollateral, (address(this), budget));
        return governor.hashProposal(targets, values, data, descriptionHash);
    }

    /// A donation cannot activate the mandate: its exact funding vote must execute.
    function activate() external {
        require(!activated && !stopped && block.timestamp <= deadline, "Mandate unavailable");
        require(governor.state(fundingProposal) == 7, "DAO vote not executed");
        BetVault(payable(treasury)).registry().validateBuy(market, tokenId, uint64(deadline));
        activated = true;
        collateral.safeTransfer(wallet, budget);
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        bool handover = msg.sender == wallet && _handoverDigest() == digest;
        bool order = activated && !stopped && block.timestamp <= deadline && digest == orderDigest;
        bool refund = digest == refundDigest || digest == approvalDigest;
        bool signed = _signedByTransport(digest, signature);
        return (handover && keccak256(signature) == keccak256(hex"01")) || ((order || refund) && signed)
            ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function _handoverDigest() private view returns (bytes32) {
        if (IDepositMandateWallet(wallet).pendingOwner() != address(this)) return bytes32(0);
        bytes32 contents = keccak256(abi.encode(keccak256("OwnershipHandover(address newOwner,uint256 nonce)"),
            address(this), IDepositMandateWallet(wallet).pendingOwnerNonce()));
        return keccak256(abi.encodePacked(hex"1901", walletDomain, contents));
    }

    function _signedByTransport(bytes32 digest, bytes calldata signature) private view returns (bool) {
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
        return error == ECDSA.RecoverError.NoError && signer == transport;
    }

    /// Permissionless abort for this one-order probe; assets can only return to the DAO.
    function startRecovery() external {
        require(!stopped, "Already stopped");
        stopped = true;
        IDepositMandateWallet(wallet).pause();
    }

    /// The venue's wallet enforces its one-hour emergency delay.
    function recover() external {
        require(stopped, "Stop mandate first");
        IDepositMandateWallet(wallet).revokeAllowance(address(collateral), exchange);
        IDepositMandateWallet(wallet).withdrawERC20(address(collateral), treasury, collateral.balanceOf(wallet));
        _recoverPosition();
        uint256 remaining = collateral.balanceOf(address(this));
        if (remaining > 0) collateral.safeTransfer(treasury, remaining);
    }

    function _recoverPosition() private {
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amounts = new uint256[](1);
        ids[0] = tokenId;
        amounts[0] = positions.balanceOf(wallet, tokenId);
        if (amounts[0] > 0) IDepositMandateWallet(wallet).withdrawERC1155(address(positions), treasury, ids, amounts);
    }
}
