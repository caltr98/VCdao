import { ethers, network } from "hardhat";
import { strict as assert } from "assert";
import { writeFileSync } from "fs";
import { forkPolygon } from "./fork";
import { POLYGON } from "./addresses";
import { exchange } from "./safe-fork";

const walletAddress = "0x03360EEC0D055a915e5cBf075447Ef36C6B6Ffb6";
const abi = [
  "function owner() view returns(address)", "function factory() view returns(address)",
  "function nonce() view returns(uint256)", "function pendingOwnerNonce() view returns(uint256)",
  "function transferOwnership(address,uint256)", "function completeOwnershipHandover(bytes)",
  "function execute((address wallet,uint256 nonce,uint256 deadline,(address target,uint256 value,bytes data)[] calls),bytes)",
  "function isValidSignature(bytes32,bytes) view returns(bytes4)"
];
const types = {
  Batch: [{ name: "wallet", type: "address" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }, { name: "calls", type: "Call[]" }],
  Call: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }]
};
const orderTypes = { Order: [
  { name: "salt", type: "uint256" }, { name: "maker", type: "address" }, { name: "signer", type: "address" },
  { name: "tokenId", type: "uint256" }, { name: "makerAmount", type: "uint256" }, { name: "takerAmount", type: "uint256" },
  { name: "side", type: "uint8" }, { name: "signatureType", type: "uint8" }, { name: "timestamp", type: "uint256" },
  { name: "metadata", type: "bytes32" }, { name: "builder", type: "bytes32" }
] };

function wrappedOrder(order: Record<string, unknown>) {
  const appDomain = { name: "Polymarket CTF Exchange", version: "2", chainId: 137, verifyingContract: POLYGON.exchange };
  const nestedTypes = { ...orderTypes, TypedDataSign: [{ name: "contents", type: "Order" },
    { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" }, { name: "salt", type: "bytes32" }] };
  const contents = ethers.TypedDataEncoder.hashStruct("Order", orderTypes, order);
  const description = ethers.toUtf8Bytes(ethers.TypedDataEncoder.from(orderTypes).encodeType("Order"));
  const signature = ethers.concat([new Uint8Array(65), ethers.TypedDataEncoder.hashDomain(appDomain), contents,
    description, ethers.toBeHex(description.length, 2)]);
  const digest = ethers.TypedDataEncoder.hash(appDomain, nestedTypes, { contents: order, name: "DepositWallet",
    version: "1", chainId: 137, verifyingContract: walletAddress, salt: ethers.ZeroHash });
  return { signature, digest };
}

async function impersonate(address: string) {
  await network.provider.send("hardhat_impersonateAccount", [address]);
  await network.provider.send("hardhat_setBalance", [address, "0x8ac7230489e80000"]);
  return ethers.getSigner(address);
}

async function rejects(action: () => Promise<unknown>) {
  let rejected = false;
  try { await action(); } catch { rejected = true; }
  assert(rejected, "Expected unauthorized execution to revert");
}

async function main() {
  const fork = await forkPolygon();
  const [controller] = await ethers.getSigners();
  const wallet = new ethers.Contract(walletAddress, abi, controller);
  const factory = await impersonate(await wallet.factory());
  const probe = await (await ethers.getContractFactory("DepositOwnerProbe")).deploy();
  const domain = { name: "DepositWallet", version: "1", chainId: 137, verifyingContract: walletAddress };
  const oldOwner = await wallet.owner();
  const deadline = fork.timestamp + 3600;

  // Only the local fork impersonates the wallet to initiate its self-call handover.
  const self = await impersonate(walletAddress);
  await (await wallet.connect(self).getFunction("transferOwnership")(await probe.getAddress(), deadline)).wait();
  const handoverTypes = { OwnershipHandover: [{ name: "newOwner", type: "address" }, { name: "nonce", type: "uint256" }] };
  const handover = { newOwner: await probe.getAddress(), nonce: await wallet.pendingOwnerNonce() };
  await (await probe.approve(ethers.TypedDataEncoder.hash(domain, handoverTypes, handover))).wait();
  await (await wallet.completeOwnershipHandover("0x01")).wait();
  assert.equal((await wallet.owner()).toLowerCase(), (await probe.getAddress()).toLowerCase());

  const token = new ethers.Interface(["function approve(address,uint256)", "function allowance(address,address) view returns(uint256)"]);
  const batch = { wallet: walletAddress, nonce: await wallet.nonce(), deadline,
    calls: [{ target: POLYGON.collateral, value: 0, data: token.encodeFunctionData("approve", [POLYGON.exchange, 50000]) }] };
  const digest = ethers.TypedDataEncoder.hash(domain, types, batch);
  await rejects(() => wallet.connect(factory).getFunction("execute")(batch, "0x01"));
  await (await probe.approve(digest)).wait();
  const changed = { ...batch, calls: [{ ...batch.calls[0], data: token.encodeFunctionData("approve", [POLYGON.exchange, 50001]) }] };
  await rejects(() => wallet.connect(factory).getFunction("execute")(changed, "0x01"));
  await (await wallet.connect(factory).getFunction("execute")(batch, "0x01")).wait();
  await rejects(() => wallet.connect(factory).getFunction("execute")(batch, "0x01"));
  const collateral = new ethers.Contract(POLYGON.collateral, token, controller);
  assert.equal(await collateral.allowance(walletAddress, POLYGON.exchange), 50000n);

  // Exchange callers use the ERC-7739 wrapper, unlike factory batches.
  const order = { salt: 1, maker: walletAddress, signer: walletAddress, tokenId: 1, makerAmount: 50000,
    takerAmount: 5000000, side: 0, signatureType: 3, timestamp: fork.timestamp * 1000,
    metadata: ethers.ZeroHash, builder: ethers.ZeroHash };
  const wrapped = wrappedOrder(order);
  await (await probe.approve(wrapped.digest)).wait();
  const hash = await exchange.hashOrder({ ...order, signature: wrapped.signature });
  // A nonzero gas price selects on-chain verification. Solady's RPC fallback
  // deliberately burns gas on invalid zero-gas-price simulations.
  const call = { gasPrice: (await ethers.provider.getFeeData()).gasPrice! };
  assert.equal(await wallet.isValidSignature(hash, wrapped.signature, call), "0x1626ba7e");
  const changedHash = await exchange.hashOrder({ ...order, makerAmount: 50001, signature: wrapped.signature });
  assert.equal(await wallet.isValidSignature(changedHash, wrapped.signature, call), "0xffffffff");

  const report = { block: fork.block, blockHash: fork.blockHash, wallet: walletAddress, originalOwner: oldOwner,
    forkOwner: await probe.getAddress(), contractHandover: true, unapprovedBatchRejected: true,
    changedBudgetRejected: true, approvedBatchExecuted: true, replayRejected: true,
    erc7739OrderSignatureAccepted: true, changedOrderBudgetRejected: true,
    liveTransactions: 0, scope: "Deployed wallet bytecode on a Polygon fork; CLOB admission after handover remains untested" };
  writeFileSync("output/deposit-owner-fork.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  fork.remote.destroy();
}

main().catch(error => {
  console.error(error.code === "ERR_ASSERTION" ? error.message : {
    name: error.name, code: error.code, reason: error.reason,
    message: error.message?.replace(/https?:\/\/\S+/g, "[RPC redacted]").replace(/0x[0-9a-fA-F]{64}/g, "[hash redacted]"),
    shortMessage: error.shortMessage?.replace(/https?:\/\/\S+/g, "[RPC redacted]")
  });
  process.exitCode = 1;
});
