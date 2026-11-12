import { ethers, network } from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import type { Wallet } from "ethers";
import { POLYGON } from "./addresses";

const path = process.env.DEPOSIT_FROM_DAO === "yes"
  ? (process.env.DEPOSIT_SECOND === "yes" ? "output/deposit-from-dao-2.json" : "output/deposit-from-dao.json")
  : "output/deposit-handover.json";
const state = JSON.parse(readFileSync(path, "utf8"));
const save = () => writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
const pause = () => new Promise(resolve => setTimeout(resolve, 4000));

function signerKey(): Wallet {
  return new ethers.Wallet(`0x${process.env.DEPLOYER_PRIVATE_KEY!.replace(/^0x/, "")}`, ethers.provider);
}

async function send(name: string, signer: Wallet, to: string | undefined, data: string) {
  const existing = state.transactions?.[name];
  if (existing) return verify(name, existing);
  const nonce = await ethers.provider.getTransactionCount(signer.address, "pending");
  const gasLimit = await ethers.provider.estimateGas({ from: signer.address, to, data });
  const fees = await ethers.provider.getFeeData();
  const unsigned = await signer.populateTransaction({ to, data, nonce, gasLimit: gasLimit * 12n / 10n,
    maxFeePerGas: fees.maxFeePerGas!, maxPriorityFeePerGas: fees.maxPriorityFeePerGas!, type: 2 });
  const raw = await signer.signTransaction(unsigned);
  state.transactions ??= {};
  state.transactions[name] = { status: "signed", hash: ethers.keccak256(raw), nonce, raw };
  save();
  await ethers.provider.broadcastTransaction(raw);
  return verify(name, state.transactions[name]);
}

async function verify(name: string, recorded: any) {
  const start = Date.now();
  let receipt = await ethers.provider.getTransactionReceipt(recorded.hash);
  while (!receipt && Date.now() - start < 60000) {
    await pause();
    receipt = await ethers.provider.getTransactionReceipt(recorded.hash);
  }
  if (!receipt) throw new Error(`${name}: transaction pending; reconcile exact hash before continuing`);
  recorded.status = receipt.status === 1 ? "confirmed" : "reverted";
  recorded.block = receipt.blockNumber;
  delete recorded.raw;
  save();
  if (receipt.status !== 1) throw new Error(`${name}: transaction reverted`);
  return receipt;
}

async function ready(governor: any, id: bigint, expected: bigint, label: string) {
  const began = Date.now();
  while (await governor.state(id) !== expected) {
    const current = await governor.state(id);
    if (current === 3n || current === 2n) throw new Error(`${label}: proposal ended before vote`);
    if (Date.now() - began > 15 * 60_000) throw new Error(`${label}: governance state did not arrive`);
    await pause();
  }
}

async function proposal(name: string, signer: Wallet, topic: bigint, targets: string[], data: string[], description: string) {
  const governor = new ethers.Contract(state.dao.governor, [
    "function hashProposal(address[],uint256[],bytes[],bytes32) pure returns(uint256)",
    "function proposeWithTopic(address[],uint256[],bytes[],string,uint256)",
    "function state(uint256) view returns(uint8)", "function castVote(uint256,uint8)",
    "function queue(address[],uint256[],bytes[],bytes32)",
    "function execute(address[],uint256[],bytes[],bytes32)",
    "function proposalEta(uint256) view returns(uint256)"
  ], signer);
  const values = targets.map(() => 0);
  const hash = ethers.id(description);
  const id: bigint = await governor.hashProposal(targets, values, data, hash);
  state.proposals ??= {};
  state.proposals[name] ??= { id: id.toString(), topic: topic.toString(), description, targets, data };
  if (state.proposals[name].id !== id.toString()) throw new Error(`${name}: proposal identity mismatch`);
  save();
  await send(`${name}.propose`, signer, state.dao.governor,
    governor.interface.encodeFunctionData("proposeWithTopic", [targets, values, data, description, topic]));
  if (await governor.state(id) === 0n) await ready(governor, id, 1n, `${name} voting start`);
  if (await governor.state(id) === 1n) await send(`${name}.vote`, signer, state.dao.governor,
    governor.interface.encodeFunctionData("castVote", [id, 1]));
  await ready(governor, id, 4n, `${name} vote`);
  await send(`${name}.queue`, signer, state.dao.governor,
    governor.interface.encodeFunctionData("queue", [targets, values, data, hash]));
  while (BigInt((await ethers.provider.getBlock("latest"))!.timestamp) < await governor.proposalEta(id)) await pause();
  await send(`${name}.execute`, signer, state.dao.governor,
    governor.interface.encodeFunctionData("execute", [targets, values, data, hash]));
  if (await governor.state(id) !== 7n) throw new Error(`${name}: execution unconfirmed`);
  state.proposals[name].status = "executed";
  save();
}

async function register(signer: Wallet) {
  const market = state.market;
  const registry = new ethers.Contract(state.dao.registry, [
    "function markets(uint256) view returns(uint256,uint256,uint256,uint64,bool)",
    "function registerMarket(uint256,(uint256 yesToken,uint256 noToken,uint256 skillTopic,uint64 closesAt,bool exists),string)"
  ], signer);
  const topic = BigInt(market.conditionId);
  const existing = await registry.markets(topic);
  if (existing[4]) {
    if (existing[0] !== BigInt(market.token) || existing[1] !== BigInt(market.no)) throw new Error("Market mapping differs");
    return;
  }
  const args = [topic, { yesToken: market.token, noToken: market.no, skillTopic: 2,
    closesAt: Math.floor(Date.parse(market.endDate) / 1000), exists: true },
    `https://polymarket.com/market/${market.slug}`];
  await proposal("marketRegistration", signer, BigInt(state.bootstrapTopic), [state.dao.registry],
    [registry.interface.encodeFunctionData("registerMarket", args)], `Register market ${market.slug} for DAO admission test`);
}

async function deploy(signer: Wallet) {
  if (state.transactions?.["controller.deploy"]) {
    await send("controller.deploy", signer, undefined, "0x");
    return verifyController();
  }
  if (await ethers.provider.getCode(state.controller ?? ethers.ZeroAddress) !== "0x") return verifyController();
  if (process.env.DEPOSIT_FROM_DAO !== "yes") {
    const wallet = new ethers.Contract(state.wallet, ["function owner() view returns(address)"], signer);
    if ((await wallet.owner()).toLowerCase() !== state.transport.toLowerCase()) throw new Error("Unexpected wallet owner");
  }
  const factory = await ethers.getContractFactory("DepositMandateOwner", signer);
  const plan = { wallet: process.env.DEPOSIT_FROM_DAO === "yes" ? ethers.ZeroAddress : state.wallet,
    factory: "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07", treasury: state.dao.vault, transport: state.transport,
    exchange: POLYGON.exchange, governor: state.dao.governor, market: BigInt(state.market.conditionId),
    tokenId: state.market.token, budget: 50000, shares: 5000000, deadline: state.deadline,
    salt: state.order.salt, timestamp: state.order.timestamp, metadata: state.order.metadata,
    builder: state.order.builder, expectedOrderDigest: state.orderDigest,
    refundDigest: state.refundDigest, approvalDigest: state.approvalDigest ?? ethers.ZeroHash,
    descriptionHash: state.descriptionHash };
  const deployment = await factory.getDeployTransaction(plan);
  const nonce = await ethers.provider.getTransactionCount(signer.address, "pending");
  const address = ethers.getCreateAddress({ from: signer.address, nonce });
  if (state.controller && state.controller.toLowerCase() !== address.toLowerCase()) throw new Error("Predicted controller changed before deployment");
  state.controller = address;
  save();
  await send("controller.deploy", signer, undefined, deployment.data!);
  await verifyController();
}

async function verifyController() {
  const code = await ethers.provider.getCode(state.controller);
  if (code === "0x") throw new Error("Controller deployment not confirmed");
  const controller = await ethers.getContractAt("DepositMandateOwner", state.controller);
  if ((await controller.wallet()).toLowerCase() !== state.wallet.toLowerCase()
    || await controller.orderDigest() !== state.orderDigest
    || await controller.refundDigest() !== state.refundDigest
    || await controller.approvalDigest() !== (state.approvalDigest ?? ethers.ZeroHash)
    || (await controller.treasury()).toLowerCase() !== state.dao.vault.toLowerCase()) throw new Error("Controller immutable mismatch");
  const vault = new ethers.Contract(state.dao.vault,
    ["function withdrawCollateral(address,uint256)"], ethers.provider);
  const governor = new ethers.Contract(state.dao.governor,
    ["function hashProposal(address[],uint256[],bytes[],bytes32) pure returns(uint256)"], ethers.provider);
  const data = vault.interface.encodeFunctionData("withdrawCollateral", [state.controller, 50000]);
  const expected = await governor.hashProposal([state.dao.vault], [0], [data], state.descriptionHash);
  if (await controller.fundingProposal() !== expected) throw new Error("Funding proposal mismatch");
  state.controllerVerified = true;
  save();
}

async function complete(signer: Wallet) {
  const wallet = new ethers.Contract(state.wallet, [
    "function owner() view returns(address)", "function pendingOwner() view returns(address)",
    "function completeOwnershipHandover(bytes)"], signer);
  if ((await wallet.owner()).toLowerCase() === state.controller.toLowerCase()) return;
  if ((await wallet.pendingOwner()).toLowerCase() !== state.controller.toLowerCase()) throw new Error("Pending owner mismatch");
  await send("handover.complete", signer, state.wallet,
    wallet.interface.encodeFunctionData("completeOwnershipHandover", ["0x01"]));
  if ((await wallet.owner()).toLowerCase() !== state.controller.toLowerCase()) throw new Error("DAO owner not installed");
  state.ownerConfirmed = true;
  save();
}

async function fund(signer: Wallet) {
  if (!state.ownerConfirmed) throw new Error("Confirm contract ownership before DAO funding vote");
  const vault = new ethers.Contract(state.dao.vault, ["function withdrawCollateral(address,uint256)"], signer);
  const data = vault.interface.encodeFunctionData("withdrawCollateral", [state.controller, 50000]);
  await proposal("funding", signer, BigInt(state.market.conditionId), [state.dao.vault], [data], state.description);
  const controller = await ethers.getContractAt("DepositMandateOwner", state.controller, signer);
  if (await controller.activated()) return;
  await send("mandate.activate", signer, state.controller, controller.interface.encodeFunctionData("activate"));
  const collateral = new ethers.Contract(POLYGON.collateral, ["function balanceOf(address) view returns(uint256)"], signer);
  if (await collateral.balanceOf(state.wallet) !== 50000n) throw new Error("Wallet funding mismatch");
  state.activated = true;
  save();
}

async function verifyOwner() {
  const wallet = new ethers.Contract(state.wallet, ["function owner() view returns(address)"], ethers.provider);
  if (await ethers.provider.getCode(state.wallet) === "0x") throw new Error("Deposit Wallet not deployed");
  if ((await wallet.owner()).toLowerCase() !== state.controller.toLowerCase()) throw new Error("DAO controller is not wallet owner");
  state.ownerConfirmed = true;
  save();
}

async function recovery(signer: Wallet, completeRecovery: boolean) {
  const controller = await ethers.getContractAt("DepositMandateOwner", state.controller, signer);
  if (!await controller.stopped()) await send("recovery.start", signer, state.controller,
    controller.interface.encodeFunctionData("startRecovery"));
  if (completeRecovery) await send("recovery.finish", signer, state.controller,
    controller.interface.encodeFunctionData("recover"));
}

async function main() {
  if (network.name !== "polygon" || process.env.CONFIRM_DEPOSIT_DAO !== "yes") throw new Error("Polygon DAO handover requires the task's live confirmation flag");
  if ((await ethers.provider.getNetwork()).chainId !== 137n) throw new Error("Polygon required");
  const signer = signerKey();
  const action = process.env.DEPOSIT_ACTION;
  if (action === "register") await register(signer);
  else if (action === "deploy") await deploy(signer);
  else if (action === "complete") await complete(signer);
  else if (action === "verify-owner") await verifyOwner();
  else if (action === "fund") await fund(signer);
  else if (action === "start-recovery") await recovery(signer, false);
  else if (action === "recover") await recovery(signer, true);
  else throw new Error("Unknown DEPOSIT_ACTION");
  console.log(JSON.stringify({ action, controller: state.controller, ownerConfirmed: state.ownerConfirmed ?? false,
    activated: state.activated ?? false, status: "confirmed" }, null, 2));
}

main().catch(error => {
  console.error(String(error.shortMessage ?? error.message ?? "Live Deposit mandate failed").replace(/https?:\/\/\S+/g, "[RPC redacted]"));
  process.exitCode = 1;
});
