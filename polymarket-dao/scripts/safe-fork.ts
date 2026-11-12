import { ethers } from "hardhat";
import { impersonateAccount, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import type { Contract, JsonRpcProvider, Wallet } from "ethers";
import { POLYGON, readJson } from "./polymarket";
import type { forkPolygon } from "./fork";

// Shared pieces of the Safe-route fork checks (`fork-safe.ts`, `fork-mandate.ts`): a Polymarket
// factory Safe (signature type 2), live-market selection, order signing, resolution and lookups of
// the forked operator and a pUSD holder.
export const SAFE_FACTORY = "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b";
export const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // collateral of the CTF positions; the exchange trades pUSD
export const tuple = "(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder,bytes signature)";
export const exchangeAbi = [
  `function matchOrders(bytes32 conditionId,${tuple} takerOrder,${tuple}[] makerOrders,uint256 takerFillAmount,uint256[] makerFillAmounts,uint256 takerFeeAmount,uint256[] makerFeeAmounts)`,
  `function hashOrder(${tuple} order) view returns (bytes32)`,
  "function isOperator(address) view returns (bool)",
];
export const factoryAbi = [
  "function computeProxyAddress(address) view returns (address)",
  "function domainSeparator() view returns (bytes32)",
  "function createProxy(address paymentToken,uint256 payment,address paymentReceiver,(uint8 v,bytes32 r,bytes32 s) createSig)",
];
export const safeAbi = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function isModuleEnabled(address) view returns (bool)",
  "function enableModule(address)",
  "function disableModule(address prevModule,address module)",
  "function setGuard(address)",
  "function setFallbackHandler(address)",
  "function addOwnerWithThreshold(address,uint256)",
  "function swapOwner(address prevOwner,address oldOwner,address newOwner)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns (bool)",
  "function execTransactionFromModule(address to,uint256 value,bytes data,uint8 operation) returns (bool)",
];
export const erc20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)"]);
export const erc1155 = new ethers.Interface(["function balanceOf(address,uint256) view returns (uint256)", "function safeTransferFrom(address,address,uint256,uint256,bytes)", "function setApprovalForAll(address,bool)"]);
export const UNIT = 1_000_000n;
export const SENTINEL = "0x0000000000000000000000000000000000000001"; // Safe linked-list head for owners and modules
export const exchange = new ethers.Contract(POLYGON.exchange, exchangeAbi, ethers.provider);
export const collateral = new ethers.Contract(POLYGON.collateral, erc20, ethers.provider);
export const positions = new ethers.Contract(POLYGON.positions, erc1155, ethers.provider);
export const usdce = new ethers.Contract(USDC_E, erc20, ethers.provider);
export const factory = new ethers.Contract(SAFE_FACTORY, factoryAbi, ethers.provider);

export type Market = Awaited<ReturnType<typeof chooseMarket>>;
export type Fork = Awaited<ReturnType<typeof forkPolygon>>;
export type Order = Awaited<ReturnType<typeof signed>>;

export async function chooseMarket() {
  const markets = await readJson("https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=100&order=volume24hr&ascending=false");
  for (const m of markets) {
    const ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
    if (m.negRisk || !m.acceptingOrders || ids?.length !== 2) continue;
    const book = await readJson(`https://clob.polymarket.com/book?token_id=${ids[0]}`).catch(() => undefined);
    if (book?.neg_risk === false) return { slug: m.slug as string, conditionId: m.conditionId as string, yes: BigInt(ids[0]), no: BigInt(ids[1]), questionId: m.questionID as string, resolvedBy: m.resolvedBy as string };
  }
  throw new Error("No live binary standard-exchange market");
}

// Polymarket Safe for the trader EOA, created through the factory with the trader's EIP-712 signature.
export async function createSafe(trader: Wallet) {
  const safeAddress: string = await factory.computeProxyAddress(trader.address);
  const structHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "address", "uint256", "address"], [ethers.id("CreateProxy(address paymentToken,uint256 payment,address paymentReceiver)"), ethers.ZeroAddress, 0, ethers.ZeroAddress]));
  const createSig = trader.signingKey.sign(ethers.keccak256(ethers.concat(["0x1901", await factory.domainSeparator(), structHash])));
  await (await (factory.connect(trader) as Contract).getFunction("createProxy")(ethers.ZeroAddress, 0, ethers.ZeroAddress, { v: createSig.v, r: createSig.r, s: createSig.s })).wait();
  const safe = new ethers.Contract(safeAddress, safeAbi, trader);
  const self = (fn: string, args: unknown[]) => ownerExec(safe, trader, safeAddress, safe.interface.encodeFunctionData(fn, args));
  return { safe, safeAddress, self };
}

// The condition's oracle is the address that, with its question ID, reproduces the conditionId.
export async function resolve(market: Market, fork: Fork, payouts: bigint[]) {
  const ctf = new ethers.Contract(POLYGON.positions, ["function getConditionId(address,bytes32,uint256) pure returns (bytes32)", "function reportPayouts(bytes32,uint256[])", "function payoutDenominator(bytes32) view returns (uint256)", "function getCollectionId(bytes32,bytes32,uint256) view returns (bytes32)", "function getPositionId(address,bytes32) pure returns (uint256)"], ethers.provider);
  const yesPosition: bigint = await ctf.getPositionId(USDC_E, await ctf.getCollectionId(ethers.ZeroHash, market.conditionId, 1));
  const prep = await fork.remote.getLogs({ address: POLYGON.positions, topics: [ethers.id("ConditionPreparation(bytes32,address,bytes32,uint256)"), market.conditionId], fromBlock: 0, toBlock: fork.block }).catch(() => []);
  const candidates = [...prep.map(l => ({ oracle: ethers.getAddress(ethers.dataSlice(l.topics[2], 12)), questionId: l.topics[3] })), { oracle: market.resolvedBy, questionId: market.questionId }];
  for (const c of candidates) {
    if (!c.oracle || !c.questionId || (await ctf.getConditionId(c.oracle, c.questionId, 2)).toLowerCase() !== market.conditionId.toLowerCase()) continue;
    await (await (ctf.connect(await impersonated(c.oracle)) as Contract).getFunction("reportPayouts")(c.questionId, payouts)).wait();
    return { oracle: c.oracle, questionId: c.questionId, payouts, denominator: await ctf.payoutDenominator(market.conditionId), yesTokenIsUsdcePosition: yesPosition === market.yes };
  }
  return { oracle: "not identified", candidatesTried: candidates.length, yesTokenIsUsdcePosition: yesPosition === market.yes };
}

// Safe signature form for msg.sender == owner: r = owner, s = 0, v = 1.
export async function ownerExec(safe: Contract, owner: Wallet, to: string, data: string) {
  const sig = ethers.concat([ethers.zeroPadValue(owner.address, 32), ethers.ZeroHash, "0x01"]);
  await (await safe.getFunction("execTransaction")(to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, sig)).wait();
}

export async function signed(signer: Wallet, maker: string, tokenId: bigint, principal: bigint, shares: bigint, signatureType: number, side = 0) {
  const order = { salt: BigInt(ethers.hexlify(ethers.randomBytes(6))), maker, signer: signer.address, tokenId, makerAmount: principal, takerAmount: shares, side, signatureType, timestamp: BigInt(Date.now()), metadata: ethers.ZeroHash, builder: ethers.ZeroHash, signature: "0x" };
  return { ...order, signature: signer.signingKey.sign(await exchange.hashOrder(order)).serialized };
}

// MINT match: our BUY of one outcome against a counterparty BUY of the complement at the same price.
export async function match(market: Market, order: Order, counterparty: Wallet, operator: Awaited<ReturnType<typeof impersonated>>) {
  const complement = order.tokenId === market.yes ? market.no : market.yes;
  const maker = await signed(counterparty, counterparty.address, complement, order.makerAmount, order.takerAmount, 0);
  return (await (exchange.connect(operator) as Contract).getFunction("matchOrders")(market.conditionId, order, [maker], order.makerAmount, [order.makerAmount], 0, [0])).wait();
}

export async function outcome(call: () => Promise<unknown>) {
  try { await call(); return "accepted"; } catch (e: any) { return `rejected: ${e.shortMessage ?? e.message}`.slice(0, 160); }
}
export async function impersonated(address: string) { await impersonateAccount(address); await setBalance(address, ethers.parseEther("10")); return ethers.getSigner(address); }
export async function funded() { const w = ethers.Wallet.createRandom().connect(ethers.provider); await setBalance(w.address, ethers.parseEther("10")); return w as unknown as Wallet; }

export async function findOperator(remote: JsonRpcProvider, block: number) {
  const logs = await remote.getLogs({ address: POLYGON.exchange, fromBlock: block - 20, toBlock: block });
  for (const hash of new Set(logs.map(l => l.transactionHash))) {
    const from = (await remote.getTransaction(hash))?.from;
    if (from && await exchange.isOperator(from)) return from;
  }
  throw new Error("No operator transaction in the recent blocks");
}

export async function findHolder(remote: JsonRpcProvider, block: number, amount: bigint) {
  const logs = await remote.getLogs({ address: POLYGON.collateral, topics: [ethers.id("Transfer(address,address,uint256)")], fromBlock: block - 200, toBlock: block });
  const skip = [POLYGON.collateral, POLYGON.exchange, POLYGON.negRiskExchange].map(a => a.toLowerCase());
  for (const log of logs) {
    const to = ethers.getAddress(ethers.dataSlice(log.topics[2], 12));
    if (!skip.includes(to.toLowerCase()) && await collateral.balanceOf(to) >= amount) return to;
  }
  throw new Error("No pUSD holder");
}

