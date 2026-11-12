import { ethers, network } from "hardhat";
import { mine, setBalance, time } from "@nomicfoundation/hardhat-network-helpers";
import { forkPolygon } from "./fork";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Contract, Wallet } from "ethers";
import { POLYGON, readJson } from "./polymarket";
import { deployDao } from "./deployment";
import { issueSkill } from "./local";
import { UNIT, USDC_E, collateral, createSafe, erc20, ownerExec, safeAbi } from "./safe-fork";

// LIVE Polygon run of the Safe mandate route up to "order ready to post". Real transactions, paid
// by DEPLOYER_PRIVATE_KEY: DAO deployment, one member joining and voting, a fresh guarded trading
// Safe, and one proposal that funds it with 0.05 pUSD and sets a mandate for a 5-share BUY at
// 0.01. The order itself is posted separately (scripts/post-safe-order.py) from a country
// Polymarket does not block. The trading key is derived from the deployer key, so no key is
// written anywhere; the state file holds only public addresses and resumes an interrupted run.
const REHEARSAL = network.name === "hardhat"; // same script on an in-process fork, nothing sent
const STATE = REHEARSAL ? "output/live-mandate-rehearsal.json" : "output/live-mandate.json";
const TRADING_LABEL = "polymarket-dao live trading 1";
const LIMIT_PRICE = UNIT / 100n, SHARES = 5n * UNIT, BUDGET = LIMIT_PRICE * SHARES / UNIT; // 0.01 × 5 = 0.05 pUSD
// PERSONAL_SAFE=yes: guard the deployer's existing (CLOB-admitted) Safe instead of a fresh one; a vote
// on SafeMandateHandler.releaseSafe undoes the guard. The original fallback handler is recorded.
const PERSONAL = process.env.PERSONAL_SAFE === "yes";
const VAULT_FUNDING = UNIT; // 1 pUSD from the deployer's existing Polymarket Safe

type State = Record<string, any>;
const state: State = !REHEARSAL && existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => { mkdirSync("output", { recursive: true }); writeFileSync(STATE, JSON.stringify(state, (_, v) => typeof v === "bigint" ? v.toString() : v, 2)); };
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (state[name] !== undefined) return state[name];
  console.log(`→ ${name}`);
  state[name] = await run();
  save();
  return state[name];
}

async function main() {
  if (!REHEARSAL && (network.name !== "polygon" || process.env.CONFIRM_LIVE_MANDATE !== "yes")) throw new Error("Run with --network polygon and CONFIRM_LIVE_MANDATE=yes");
  const fork = REHEARSAL ? await forkPolygon() : undefined;
  const deployer = REHEARSAL ? new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, ethers.provider) as any : (await ethers.getSigners())[0];
  if (REHEARSAL) await setBalance(deployer.address, ethers.parseEther("50"));
  const trader = new ethers.Wallet(ethers.keccak256(ethers.concat([ethers.zeroPadValue("0x" + process.env.DEPLOYER_PRIVATE_KEY!.replace(/^0x/, ""), 32), ethers.toUtf8Bytes(TRADING_LABEL)])), ethers.provider) as unknown as Wallet;
  const personalSafe = new ethers.Contract(await new ethers.Contract("0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b", ["function computeProxyAddress(address) view returns (address)"], ethers.provider).computeProxyAddress(deployer.address), safeAbi, deployer);

  const market = await step("market", chooseMarket);
  const dao = await step("dao", async () => {
    const plan = { timelockDelaySeconds: 30, votingDelayBlocks: 1, votingPeriodBlocks: 30, skillWeightBps: 5000, trustedIssuer: deployer.address, markets: [{ conditionId: market.conditionId, yesToken: market.yes, noToken: market.no, skillTopic: 2, closesAt: market.endDate, uri: `https://polymarket.com/market/${market.slug}` }] };
    const d = await deployDao(plan, POLYGON, deployer);
    return { timelock: await d.timelock.getAddress(), token: await d.token.getAddress(), skills: await d.skills.getAddress(), registry: await d.registry.getAddress(), vault: await d.vault.getAddress(), handler: await d.mandateHandler.getAddress(), governor: await d.governor.getAddress(), startBlock: d.startBlock };
  });
  const at = async (name: string, address: string) => ethers.getContractAt(name, address, deployer);
  const token = await at("GovernanceToken", dao.token), governor = await at("MarketGovernor", dao.governor), vault = await at("OrderVault", dao.vault), handler = await at("SafeMandateHandler", dao.handler);

  const sweeper = await step("sweeper", async () => {
    const s = await (await ethers.getContractFactory("SafeSweeper", deployer)).deploy(dao.vault, USDC_E, POLYGON.positions, dao.handler);
    await s.waitForDeployment();
    return s.getAddress();
  });
  await step("member", async () => {
    // Resumable: an EIP-7702 delegated EOA may have only one transaction in flight, so each waits.
    if (!await token.isMember(deployer.address)) await (await token.joinDAO({ value: ethers.parseEther("0.01") })).wait();
    if (await token.delegates(deployer.address) !== deployer.address) await (await token.delegate(deployer.address)).wait();
    await issueSkill(await at("GovernanceSkill", dao.skills) as any, deployer, deployer, ["blockchain"]);
    return deployer.address;
  });
  await step("vaultFunded", async () => {
    await ownerExec(personalSafe, deployer as unknown as Wallet, POLYGON.collateral, erc20.encodeFunctionData("transfer", [dao.vault, VAULT_FUNDING]));
    return collateral.balanceOf(dao.vault);
  });
  const tradingSafe = await step("tradingSafe", async () => {
    await (await deployer.sendTransaction({ to: trader.address, value: ethers.parseEther("1") })).wait();
    const created = await createSafe(trader);
    for (const module of [dao.timelock, sweeper, dao.handler]) await created.self("enableModule", [module]);
    await ownerExec(created.safe, trader, POLYGON.collateral, erc20.encodeFunctionData("approve", [POLYGON.exchange, ethers.MaxUint256]));
    await created.self("setFallbackHandler", [dao.handler]);
    const guard = await (await ethers.getContractFactory("SafeTraderGuard", deployer)).deploy(POLYGON.collateral, POLYGON.exchange);
    await guard.waitForDeployment();
    await created.self("setGuard", [await guard.getAddress()]);
    return { trader: trader.address, safe: created.safeAddress, guard: await guard.getAddress() };
  });

  const personal = PERSONAL ? await step("personalSafe", async () => {
    const slot = async (key: string) => ethers.getAddress(ethers.dataSlice(await ethers.provider.getStorage(await personalSafe.getAddress(), key), 12));
    const original = { fallbackHandler: await slot("0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5"), guard: await slot("0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8") };
    const self = (fn: string, args: unknown[]) => ownerExec(personalSafe, deployer as unknown as Wallet, personalSafe.target as string, personalSafe.interface.encodeFunctionData(fn, args));
    for (const module of [dao.timelock, sweeper, dao.handler]) if (!await personalSafe.isModuleEnabled(module)) await self("enableModule", [module]);
    await self("setFallbackHandler", [dao.handler]);
    const guard = await (await ethers.getContractFactory("SafeTraderGuard", deployer)).deploy(POLYGON.collateral, POLYGON.exchange);
    await guard.waitForDeployment();
    await self("setGuard", [await guard.getAddress()]);
    return { trader: deployer.address, safe: personalSafe.target as string, guard: await guard.getAddress(), original };
  }) : undefined;
  const target = personal ?? tradingSafe;

  const governance = await step(PERSONAL ? "governancePersonal" : "governance", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 3 * 86_400;
    const targets = [dao.vault, dao.handler];
    const calldatas = [vault.interface.encodeFunctionData("withdrawCollateral", [target.safe, BUDGET]), handler.interface.encodeFunctionData("setMandate", [target.safe, BigInt(market.conditionId), BigInt(market.yes), LIMIT_PRICE, BUDGET, 0, deadline])];
    const description = `Live mandate: BUY ${SHARES / UNIT} YES on ${market.slug} at 0.01 for ${target.safe}`;
    const hash = ethers.id(description), values = [0, 0];
    await (await governor.proposeWithTopic(targets, values, calldatas, description, BigInt(market.conditionId))).wait();
    const id = await governor.hashProposal(targets, values, calldatas, hash);
    await until(async () => await governor.state(id) === 1n, "voting starts");
    await (await governor.castVote(id, 1)).wait();
    await until(async () => await governor.state(id) === 4n, "proposal succeeds");
    await (await governor.queue(targets, values, calldatas, hash)).wait();
    await until(() => isReady(governor, id), "Timelock delay");
    await (await governor.execute(targets, values, calldatas, hash)).wait();
    return { proposalId: id.toString(), state: (await governor.state(id)).toString(), deadline };
  });

  const report = { market, dao, sweeper, tradingSafe, personal, governance, safeCollateral: await collateral.balanceOf(target.safe), mandate: (await handler.mandates(target.safe)).map(String), deployerPol: ethers.formatEther(await ethers.provider.getBalance(deployer.address)) };
  fork?.remote.destroy();
  console.log(JSON.stringify(report, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
}

async function isReady(governor: Contract | any, id: bigint) {
  const eta = await governor.proposalEta(id);
  return BigInt((await ethers.provider.getBlock("latest"))!.timestamp) >= eta;
}

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 15 * 60_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    if (REHEARSAL) { await time.increase(15); await mine(1); } else await new Promise(r => setTimeout(r, 4000));
  }
}

// A live binary standard-exchange market ending in more than a week, whose book accepts a 5-share order at 0.01.
async function chooseMarket() {
  const markets = await readJson("https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=100&order=volume24hr&ascending=false");
  for (const m of markets) {
    const ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
    if (m.negRisk || !m.acceptingOrders || ids?.length !== 2 || Date.parse(m.endDate) < Date.now() + 7 * 86_400_000) continue;
    const book = await readJson(`https://clob.polymarket.com/book?token_id=${ids[0]}`).catch(() => undefined);
    const bestBid = Math.max(0, ...(book?.bids ?? []).map((b: any) => Number(b.price)));
    if (book?.neg_risk === false && Number(book.min_order_size) <= 5 && Number(book.tick_size) <= 0.01 && bestBid >= 0.05) return { slug: m.slug as string, conditionId: m.conditionId as string, yes: ids[0] as string, no: ids[1] as string, endDate: new Date(m.endDate).toISOString(), bestBid, tickSize: book.tick_size as string };
  }
  throw new Error("No suitable market");
}

main().catch(e => { console.error(e); process.exitCode = 1; });
