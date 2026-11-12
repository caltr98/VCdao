import { ethers } from "hardhat";
import { impersonateAccount, mine, setBalance, time } from "@nomicfoundation/hardhat-network-helpers";
import { mkdirSync, writeFileSync } from "node:fs";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { JsonRpcProvider } from "ethers";
import { POLYGON, printJson, readJson, verifyPurchaseLogs } from "./polymarket";
import { forkPolygon } from "./fork";
import { deployDao, verifyDeployment } from "./deployment";
import { issueSkill, proposal } from "./local";
import { orderObject, type OrderFields } from "./order";
import { runTick, type RunnerDeps } from "../automation/src/runner";
import type { RunnerState, Settings } from "../automation/src/config";

// Polygon-fork rehearsal of the primary route. The forked chain runs in process: the DAO, its
// votes, the runner's transactions and the operator's match exist only locally. The public CLOB
// book is read over HTTP; order submission is simulated and no credentials leave the process.
const tuple = "(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder,bytes signature)";
const exchangeAbi = [
  `function matchOrders(bytes32 conditionId,${tuple} takerOrder,${tuple}[] makerOrders,uint256 takerFillAmount,uint256[] makerFillAmounts,uint256 takerFeeAmount,uint256[] makerFeeAmounts)`,
  `function preapproveOrder(${tuple} order)`,
  `function hashOrder(${tuple} order) view returns (bytes32)`,
  `function validateOrder(${tuple} order) view`,
  "function isOperator(address) view returns (bool)",
  "function getMaxFeeRate() view returns (uint256)",
  "function orderStatus(bytes32) view returns (bool filled, uint248 remaining)",
];
const erc20Abi = ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"];
const positionsAbi = ["function balanceOf(address,uint256) view returns (uint256)"];
const UNIT = 1_000_000n;
const exchangeRead = new ethers.Contract(POLYGON.exchange, exchangeAbi, ethers.provider);
const collateral = new ethers.Contract(POLYGON.collateral, erc20Abi, ethers.provider);
const positions = new ethers.Contract(POLYGON.positions, positionsAbi, ethers.provider);

type Market = Awaited<ReturnType<typeof chooseMarket>>;

async function main() {
  const market = await chooseMarket();
  const fork = await forkPolygon();
  try {
    const report = await rehearse(market, fork);
    mkdirSync("output", { recursive: true });
    writeFileSync("output/fork-e2e.json", JSON.stringify(report, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
    printJson(report);
  } finally { fork.remote.destroy(); }
}

// A live binary market on the standard exchange with a public book; the DAO buys the first outcome.
async function chooseMarket() {
  const markets = await readJson("https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=100&order=volume24hr&ascending=false");
  for (const market of markets) {
    const ids = typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
    const outcomes = typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes;
    if (market.negRisk || !market.acceptingOrders || ids?.length !== 2 || Date.parse(market.endDate) < Date.now() + 7 * 86_400_000) continue;
    const book = await readJson(`https://clob.polymarket.com/book?token_id=${ids[0]}`).catch(() => undefined);
    if (book?.neg_risk === false && book.asset_id === ids[0]) return { question: market.question as string, slug: market.slug as string, conditionId: market.conditionId as string, yesToken: BigInt(ids[0]), noToken: BigInt(ids[1]), outcome: outcomes[0] as string, endDate: market.endDate as string, tickSize: book.tick_size as string, minimumSize: String(book.min_order_size) };
  }
  throw new Error("No live binary market with a standard-exchange book");
}

async function rehearse(market: Market, fork: Awaited<ReturnType<typeof forkPolygon>>) {
  const [deployer, alice, bob, issuer] = await ethers.getSigners();
  const terms = await orderTerms(market);
  const operator = await impersonated(await findOperator(fork.remote, fork.block));
  const counterparty = await fundedWallet();
  const plan = forkPlan(market, issuer.address);
  const dao = await deployDao(plan, POLYGON, deployer);
  const checks = await verifyDeployment(dao, plan, POLYGON, deployer.address);
  await fundFromHolder(fork, dao, counterparty, terms);
  await joinMembers(dao, [alice, bob], issuer);
  const primary = await primaryRoute(market, dao, terms, operator, counterparty, [alice, bob]);
  const cached = await cachedWindow(market, dao, terms, operator, counterparty);
  return { checkedAt: new Date().toISOString(), scope: "In-process Polygon fork: DAO deployment, governance, runner transactions and the operator match are local. The CLOB book was read live; order submission was simulated. Nothing was sent to Polygon or to an authenticated API.", forkedFrom: { block: fork.block, blockHash: fork.blockHash }, market: { ...market, yesToken: market.yesToken.toString(), noToken: market.noToken.toString() }, terms, operator: await operator.getAddress(), deploymentChecks: checks, contracts: { vault: await dao.vault.getAddress(), governor: await dao.governor.getAddress(), automation: await dao.automation.getAddress() }, primary, cachedWindow: cached };
}

// A 0.50 limit price lies on every Polymarket tick grid. A zero exchange cap means V2 enforces no
// fee limit, so the rehearsal charges 1% and relies on the wallet budget as the only bound.
async function orderTerms(market: Market) {
  const shares = [10n * UNIT, BigInt(Math.ceil(Number(market.minimumSize))) * UNIT].reduce((a, b) => a > b ? a : b);
  const principal = shares / 2n;
  const maxFeeRate: bigint = await exchangeRead.getMaxFeeRate();
  const fee = principal * (maxFeeRate === 0n || maxFeeRate > 100n ? 100n : maxFeeRate) / 10_000n;
  return { shares, principal, fee, feeBudget: 2n * fee, budget: principal + 2n * fee, maxFeeRateBps: maxFeeRate };
}

async function impersonated(address: string) {
  await impersonateAccount(address);
  await setBalance(address, ethers.parseEther("10"));
  return ethers.getSigner(address);
}

async function fundedWallet() {
  const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
  await setBalance(wallet.address, ethers.parseEther("10"));
  return wallet;
}

// The sender of a recent exchange transaction that the exchange itself lists as an operator.
async function findOperator(remote: JsonRpcProvider, block: number) {
  const logs = await remote.getLogs({ address: POLYGON.exchange, fromBlock: block - 20, toBlock: block });
  for (const hash of new Set(logs.map(log => log.transactionHash))) {
    const sender = (await remote.getTransaction(hash))?.from;
    if (sender && await exchangeRead.isOperator(sender)) return sender;
  }
  throw new Error("No operator transaction in the recent blocks");
}

function forkPlan(market: Market, issuer: string) {
  const closesAt = new Date(Math.min(Date.parse(market.endDate), Date.now() + 30 * 86_400_000)).toISOString();
  const markets = [{ conditionId: market.conditionId, yesToken: market.yesToken.toString(), noToken: market.noToken.toString(), skillTopic: 2, closesAt, uri: `https://polymarket.com/market/${market.slug}` }];
  return { timelockDelaySeconds: 60, votingDelayBlocks: 1, votingPeriodBlocks: 60, skillWeightBps: 5000, trustedIssuer: issuer, markets };
}

type ForkDao = Awaited<ReturnType<typeof deployDao>>;
type Counterparty = Awaited<ReturnType<typeof fundedWallet>>;
type Terms = Awaited<ReturnType<typeof orderTerms>>;

// Two order budgets for the treasury and two NO-side principals for the counterparty.
async function fundFromHolder(fork: Awaited<ReturnType<typeof forkPolygon>>, dao: ForkDao, counterparty: Counterparty, terms: Terms) {
  const holder = await impersonated(await findCollateralHolder(fork.remote, fork.block, 2n * terms.budget + 2n * terms.principal));
  await (await collateral.connect(holder).getFunction("transfer")(await dao.vault.getAddress(), 2n * terms.budget)).wait();
  await (await collateral.connect(holder).getFunction("transfer")(counterparty.address, 2n * terms.principal)).wait();
  await (await collateral.connect(counterparty).getFunction("approve")(POLYGON.exchange, ethers.MaxUint256)).wait();
}

async function findCollateralHolder(remote: JsonRpcProvider, block: number, amount: bigint) {
  const logs = await remote.getLogs({ address: POLYGON.collateral, topics: [ethers.id("Transfer(address,address,uint256)")], fromBlock: block - 200, toBlock: block });
  const protocol = [POLYGON.collateral, POLYGON.exchange, POLYGON.negRiskExchange].map(address => address.toLowerCase());
  for (const log of logs) {
    const to = ethers.getAddress(ethers.dataSlice(log.topics[2], 12));
    if (!protocol.includes(to.toLowerCase()) && await collateral.balanceOf(to) >= amount) return to;
  }
  throw new Error("No recent pUSD recipient holds enough collateral");
}

async function joinMembers(dao: ForkDao, members: HardhatEthersSigner[], issuer: HardhatEthersSigner) {
  for (const member of members) {
    await (await dao.token.connect(member).joinDAO({ value: ethers.parseEther("20") })).wait();
    await (await dao.token.connect(member).delegate(member.address)).wait();
  }
  await issueSkill(dao.skills, issuer, members[0], ["blockchain"]);
  await mine();
}

// Proposal, vote, runner-driven queue and execute, simulated post, real operator match, receipt
// check and runner-driven collection.
async function primaryRoute(market: Market, dao: ForkDao, terms: Terms, operator: HardhatEthersSigner, counterparty: Counterparty, voters: HardhatEthersSigner[]) {
  const id = ethers.id(`fork-e2e:${market.conditionId}`);
  const buy = { market: BigInt(market.conditionId), tokenId: market.yesToken, principal: terms.principal, shares: terms.shares, feeBudget: terms.feeBudget, deadline: (await time.latest()) + 7200, exchange: POLYGON.exchange };
  const action = await proposal(dao.governor, voters[0], await dao.vault.getAddress(), dao.vault.interface.encodeFunctionData("authorizeOrder", [id, buy]), buy.market, `Fork rehearsal: buy ${market.outcome} on ${market.slug}`);
  for (const voter of voters) if (await dao.governor.state(action.id) === 1n) await (await dao.governor.connect(voter).castVote(action.id, 1)).wait();
  const runner = await forkRunner(dao);
  const ticks = [await runner.after(70), await runner.afterDelay(61)];
  const wallet = await ethers.getContractAt("OrderWallet", await dao.vault.orderWallets(id));
  const digest = await wallet.orderHash();
  const order = await wallet.getOrder();
  ticks.push(await runner.after(33));
  const overBudgetFee = await rejects(() => matchAgainstNoBuyer(market, orderObject(order), counterparty, operator, terms.principal, terms.feeBudget + 1n));
  const receipt = await matchAgainstNoBuyer(market, orderObject(order), counterparty, operator, terms.principal, terms.fee);
  const evidence = verifyPurchaseLogs(receipt!.logs, { executor: await wallet.getAddress(), tokenId: market.yesToken, shares: terms.shares, payment: terms.budget, orderHash: digest });
  // The gas limit the Worker signs for this collection is this estimate × 1.2.
  const collectGasEstimate = await wallet.collect.estimateGas();
  ticks.push(await runner.after(0), await runner.after(33));
  const collectHash = ticks[3].transaction?.hash;
  return { proposalId: action.id.toString(), wallet: await wallet.getAddress(), digest, ticks: ticks.map(summary), posted: runner.venue.posted.has(digest), feeAboveBudget: overBudgetFee, settlementTx: receipt!.hash, receiptEvidence: evidence, collectGasEstimate, collectGasUsed: collectHash && (await ethers.provider.getTransactionReceipt(collectHash))!.gasUsed, finalWalletState: await wallet.state(), treasuryShares: await positions.balanceOf(await dao.vault.getAddress(), market.yesToken), treasuryCollateral: await collateral.balanceOf(await dao.vault.getAddress()), walletAllowance: await collateral.allowance(await wallet.getAddress(), POLYGON.exchange) };
}

function summary(report: Awaited<ReturnType<typeof runTick>>) {
  return { status: report.status, transaction: report.transaction?.label.split(":")[0], orderPosted: Boolean(report.orderPosted), orders: report.orders, issues: report.issues, gas: report.gas };
}

// The runner uses the production Polygon profile against the fork. Only the public book read
// leaves the process; the geoblock answer, POST and order read are local stand-ins.
async function forkRunner(dao: ForkDao) {
  const gas = await fundedWallet();
  const config = { governor: await dao.governor.getAddress(), vault: await dao.vault.getAddress(), automation: await dao.automation.getAddress(), startBlock: dao.startBlock, confirmations: 32 };
  const settings: Settings = { config, execution: true, submission: true, gasCapWei: ethers.parseEther("5"), gasKey: gas.privateKey, clobCredentials: JSON.stringify({ address: gas.address, key: "fork-key", secret: Buffer.from("fork-secret").toString("base64"), passphrase: "fork-pass" }) };
  const venue = simulatedVenue();
  let saved: RunnerState | undefined;
  const deps: RunnerDeps = { provider: ethers.provider, network: POLYGON, request: venue.request, storage: { load: async () => saved && structuredClone(saved), save: async state => { saved = structuredClone(state); } } };
  const after = async (blocks: number) => { await mine(blocks); return runTick(settings, deps); };
  const afterDelay = async (seconds: number) => { await time.increase(seconds); return after(33); };
  return { after, afterDelay, venue };
}

function simulatedVenue() {
  const posted = new Map<string, string>();
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "clob.polymarket.com" && url.pathname === "/book" && !init?.headers) return fetch(url);
    if (url.hostname === "polymarket.com") return Response.json({ blocked: false });
    if (init?.method === "POST") return accept(String(init.body));
    const id = url.pathname.replace("/data/order/", "");
    return posted.has(id) ? Response.json({ id, status: "LIVE", size_matched: "0", original_size: "" }) : new Response("null");
  };
  // The deployed exchange recomputes the digest from the posted JSON, including the exact salt.
  async function accept(body: string) {
    const { order } = JSON.parse(body);
    const digest: string = await exchangeRead.hashOrder({ ...order, salt: BigInt(body.match(/"salt":(\d+)/)![1]), side: 0 });
    posted.set(digest, body);
    return Response.json({ success: true, errorMsg: "", orderID: digest, status: "live", makingAmount: "", takingAmount: "" });
  }
  return { request, posted };
}

// A MINT match: the DAO wallet buys the first outcome, the counterparty buys the second at the
// complementary price, and the exchange splits their combined collateral into both outcomes.
async function matchAgainstNoBuyer(market: Market, takerOrder: OrderFields, counterparty: Counterparty, operator: HardhatEthersSigner, principal: bigint, fee: bigint) {
  const shares = principal * takerOrder.takerAmount / takerOrder.makerAmount;
  const makerOrder = await signedBuy(counterparty, market.noToken, principal, shares);
  const exchange = exchangeRead.connect(operator) as typeof exchangeRead;
  return (await exchange.getFunction("matchOrders")(market.conditionId, takerOrder, [makerOrder], principal, [principal], fee, [0])).wait();
}

async function signedBuy(wallet: Counterparty, tokenId: bigint, principal: bigint, shares: bigint) {
  const order = { salt: BigInt(ethers.hexlify(ethers.randomBytes(8))), maker: wallet.address, signer: wallet.address, tokenId, makerAmount: principal, takerAmount: shares, side: 0, signatureType: 0, timestamp: BigInt(Date.now()), metadata: ethers.ZeroHash, builder: ethers.ZeroHash, signature: "0x" };
  return { ...order, signature: wallet.signingKey.sign(await exchangeRead.hashOrder(order)).serialized };
}

// The documented limitation on the deployed bytecode: a preapproved order still fills after the
// wallet's signature has expired, until collection revokes the allowance.
async function cachedWindow(market: Market, dao: ForkDao, terms: Terms, operator: HardhatEthersSigner, counterparty: Counterparty) {
  const timelock = await impersonated(await dao.timelock.getAddress());
  const id = ethers.id(`fork-cached:${market.conditionId}`);
  const deadline = (await time.latest()) + 120;
  await (await dao.vault.connect(timelock).authorizeOrder(id, { market: BigInt(market.conditionId), tokenId: market.yesToken, principal: terms.principal, shares: terms.shares, feeBudget: terms.feeBudget, deadline, exchange: POLYGON.exchange })).wait();
  const wallet = await ethers.getContractAt("OrderWallet", await dao.vault.orderWallets(id));
  const order = orderObject(await wallet.getOrder());
  await (await (exchangeRead.connect(operator) as typeof exchangeRead).getFunction("preapproveOrder")(order)).wait();
  await time.increaseTo(deadline + 1);
  const liveSignature = await wallet.isValidSignature(await wallet.orderHash(), "0x01");
  const liveValidation = await rejects(() => exchangeRead.validateOrder(order));
  const half = terms.principal / 2n;
  const cachedFill = await matchAgainstNoBuyer(market, { ...order, signature: "0x" }, counterparty, operator, half, terms.fee / 2n);
  const collection = await (await wallet.collect()).wait();
  const afterCleanup = await rejects(() => matchAgainstNoBuyer(market, { ...order, signature: "0x" }, counterparty, operator, half, 0n));
  return { wallet: await wallet.getAddress(), liveSignatureAfterDeadline: liveSignature, liveValidationAfterDeadline: liveValidation, cachedFillAfterDeadline: cachedFill!.status === 1 ? "filled" : "failed", sharesAfterCachedFill: await positions.balanceOf(await dao.vault.getAddress(), market.yesToken), finalWalletState: await wallet.state(), collectGasUsed: collection!.gasUsed, allowanceAfterCollection: await collateral.allowance(await wallet.getAddress(), POLYGON.exchange), cachedFillAfterCollection: afterCleanup };
}

async function rejects(call: () => Promise<unknown>) {
  try { await call(); return "accepted"; } catch { return "rejected"; }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
