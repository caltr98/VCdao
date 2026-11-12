import { ethers, network } from "hardhat";
import { strict as assert } from "assert";
import { readFileSync, writeFileSync } from "fs";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { forkPolygon } from "./fork";
import { POLYGON } from "./addresses";
import { collateral, exchange, findHolder, impersonated } from "./safe-fork";

const state = JSON.parse(readFileSync("output/deposit-handover.json", "utf8"));
const walletAbi = ["function owner() view returns(address)", "function pendingOwnerNonce() view returns(uint)",
  "function transferOwnership(address,uint256)", "function completeOwnershipHandover(bytes)",
  "function execute((address wallet,uint256 nonce,uint256 deadline,(address target,uint256 value,bytes data)[] calls),bytes)",
  "function isValidSignature(bytes32,bytes) view returns(bytes4)"];
const batchTypes = { Batch: [{ name: "wallet", type: "address" }, { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" }, { name: "calls", type: "Call[]" }],
  Call: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] };

async function rejected(action: () => Promise<unknown>) {
  let denied = false;
  try { await action(); } catch { denied = true; }
  assert(denied, "Expected call to fail");
}

async function main() {
  const fork = await forkPolygon();
  const [sender] = await ethers.getSigners();
  const governor = await (await ethers.getContractFactory("MockDepositGovernor")).deploy();
  const plan = { wallet: state.wallet, factory: "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07", treasury: state.dao.vault, transport: state.transport,
    exchange: POLYGON.exchange, governor: await governor.getAddress(), market: BigInt(state.market.conditionId),
    tokenId: state.market.token, budget: 50000, shares: 5000000, deadline: state.deadline,
    salt: state.order.salt, timestamp: state.order.timestamp, metadata: state.order.metadata,
    builder: state.order.builder, expectedOrderDigest: state.orderDigest,
    refundDigest: state.refundDigest, approvalDigest: state.approvalDigest ?? ethers.ZeroHash,
    descriptionHash: state.descriptionHash };
  const controller = await (await ethers.getContractFactory("DepositMandateOwner")).deploy(plan);
  const wallet = new ethers.Contract(state.wallet, walletAbi, sender);
  const factory = await impersonated("0x00000000000Fb5C9ADea0298D729A0CB3823Cc07");
  const ownerKey = ethers.keccak256(ethers.concat([`0x${process.env.DEPLOYER_PRIVATE_KEY!.replace(/^0x/, "")}`,
    ethers.toUtf8Bytes("polymarket-dao relayer admission probe 3")]));
  const owner = new ethers.Wallet(ownerKey);
  assert.equal(owner.address.toLowerCase(), state.transport.toLowerCase());
  const handover = { wallet: state.wallet, nonce: state.nonceBeforeHandover, deadline: state.deadline,
    calls: [{ target: state.wallet, value: 0, data: wallet.interface.encodeFunctionData("transferOwnership", [await controller.getAddress(), state.deadline]) }] };
  const signature = await owner.signTypedData({ name: "DepositWallet", version: "1", chainId: 137,
    verifyingContract: state.wallet }, batchTypes, handover);
  await (await wallet.connect(factory).getFunction("execute")(handover, signature)).wait();
  await (await wallet.completeOwnershipHandover("0x01")).wait();
  assert.equal((await wallet.owner()).toLowerCase(), (await controller.getAddress()).toLowerCase());

  await rejected(() => controller.activate());
  const order = { salt: state.order.salt, maker: state.wallet, signer: state.wallet,
    tokenId: BigInt(state.order.token_id), makerAmount: 50000, takerAmount: 5000000,
    side: 0, signatureType: 3, timestamp: state.order.timestamp,
    metadata: state.order.metadata, builder: state.order.builder, signature: state.order.signature };
  const orderHash = await exchange.hashOrder(order);
  const call = { gasPrice: (await ethers.provider.getFeeData()).gasPrice! };
  assert.equal(await wallet.isValidSignature(orderHash, order.signature, call), "0xffffffff");

  const holder = await impersonated(await findHolder(fork.remote, fork.block, 50000n));
  await (await (collateral.connect(holder) as any).transfer(await controller.getAddress(), 50000)).wait();
  await rejected(() => controller.activate());
  await (await governor.executeVote()).wait();
  const timelock = await impersonated(state.dao.timelock);
  const registry = new ethers.Contract(state.dao.registry, [
    "function registerMarket(uint256,(uint256 yesToken,uint256 noToken,uint256 skillTopic,uint64 closesAt,bool exists),string)"
  ], timelock);
  const closesAt = Math.floor(Date.parse(state.market.endDate) / 1000);
  await (await registry.registerMarket(BigInt(state.market.conditionId), {
    yesToken: state.market.token, noToken: state.market.no, skillTopic: 2, closesAt, exists: true
  }, `https://polymarket.com/market/${state.market.slug}`)).wait();
  await (await controller.activate()).wait();
  assert.equal(await collateral.balanceOf(state.wallet), 50000n);
  assert.equal(await wallet.isValidSignature(orderHash, order.signature, call), "0x1626ba7e");
  const changed = await exchange.hashOrder({ ...order, makerAmount: 50001 });
  assert.equal(await wallet.isValidSignature(changed, order.signature, call), "0xffffffff");

  const refund = state.refund;
  const batch = { wallet: state.wallet, nonce: refund.nonce, deadline: refund.deadline,
    calls: refund.calls.map((entry: any) => ({ target: entry.to, value: entry.value, data: entry.data })) };
  const treasuryBefore = await collateral.balanceOf(state.dao.vault);
  await (await wallet.connect(factory).getFunction("execute")(batch, refund.signature)).wait();
  assert.equal(await collateral.balanceOf(state.wallet), 0n);
  assert.equal(await collateral.balanceOf(state.dao.vault), treasuryBefore + 50000n);
  await rejected(() => wallet.connect(factory).getFunction("execute")(batch, refund.signature));
  await (await controller.startRecovery()).wait();
  await time.increase(3601);
  await (await controller.recover()).wait();
  const allowance = await new ethers.Contract(POLYGON.collateral,
    ["function allowance(address,address) view returns(uint)"], sender).allowance(state.wallet, POLYGON.exchange);
  assert.equal(allowance, 0n);
  const report = { block: fork.block, wallet: state.wallet, controller: await controller.getAddress(),
    contractOwner: true, preVoteOrderRejected: true, fundingVoteRequired: true,
    exactOrderAccepted: true, changedAmountRejected: true, fixedRefundExecuted: true,
    refundReplayRejected: true, emergencyAllowanceRevoked: true, liveTransactions: 0 };
  writeFileSync("output/deposit-mandate-fork.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  fork.remote.destroy();
}

main().catch(error => {
  const detail = String(error.shortMessage ?? error.message ?? "unknown").replace(/https?:\/\/\S+/g, "[RPC redacted]");
  console.error(error.code === "ERR_ASSERTION" ? error.message : detail);
  process.exitCode = 1;
});
