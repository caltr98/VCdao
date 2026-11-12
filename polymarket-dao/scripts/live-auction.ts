import { ethers, network } from "hardhat";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Wallet } from "ethers";
import { POLYGON, readJson } from "./polymarket";
import { deployDao } from "./deployment";
import { issueSkill } from "./local";
import { collateral, erc20, ownerExec, safeAbi } from "./safe-fork";

// LIVE Polygon run of open fulfilment (Dutch auction). Real transactions paid by DEPLOYER_PRIVATE_KEY:
// a fresh DAO with the current BetVault, one member, 2 pUSD from the deployer's Polymarket Safe to
// the vault, and one proposal authorizing an open 5-share buy. The solver is the same Safe: it buys
// on the CLOB (scripts/live-auction-buy.py) and, with PHASE=deliver, fulfils once the auction price
// covers its cost. The state file holds public data only and resumes an interrupted run.
const STATE = "output/live-auction.json";
const UNIT = 1_000_000n, SHARES = 5n * UNIT, VAULT_FUNDING = 2n * UNIT, WINDOW = 20 * 60;
const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => { mkdirSync("output", { recursive: true }); writeFileSync(STATE, JSON.stringify(state, (_, v) => typeof v === "bigint" ? v.toString() : v, 2)); };
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (state[name] !== undefined) return state[name];
  console.log(`→ ${name}`);
  state[name] = await run();
  save();
  return state[name];
}

async function main() {
  if (network.name !== "polygon" || process.env.CONFIRM_LIVE !== "yes") throw new Error("Run with --network polygon and CONFIRM_LIVE=yes");
  const [deployer] = await ethers.getSigners();
  const safe = new ethers.Contract(await new ethers.Contract("0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b", ["function computeProxyAddress(address) view returns (address)"], ethers.provider).computeProxyAddress(deployer.address), safeAbi, deployer);
  const market = await step("market", chooseMarket);
  const dao = await step("dao", async () => {
    const plan = { timelockDelaySeconds: 30, votingDelayBlocks: 1, votingPeriodBlocks: 30, skillWeightBps: 5000, trustedIssuer: deployer.address, markets: [{ conditionId: market.conditionId, yesToken: market.yes, noToken: market.no, skillTopic: 2, closesAt: market.endDate, uri: `https://polymarket.com/market/${market.slug}` }] };
    const d = await deployDao(plan, POLYGON, deployer);
    return { timelock: await d.timelock.getAddress(), token: await d.token.getAddress(), skills: await d.skills.getAddress(), registry: await d.registry.getAddress(), vault: await d.vault.getAddress(), governor: await d.governor.getAddress(), startBlock: d.startBlock };
  });
  const at = (name: string, address: string) => ethers.getContractAt(name, address, deployer);
  const token = await at("GovernanceToken", dao.token), governor = await at("MarketGovernor", dao.governor), vault = await at("OrderVault", dao.vault);
  await step("member", async () => {
    if (!await token.isMember(deployer.address)) await (await token.joinDAO({ value: ethers.parseEther("0.01") })).wait();
    if (await token.delegates(deployer.address) !== deployer.address) await (await token.delegate(deployer.address)).wait();
    await issueSkill(await at("GovernanceSkill", dao.skills) as any, deployer, deployer, ["blockchain"]);
    return deployer.address;
  });
  await step("vaultFunded", async () => {
    await ownerExec(safe, deployer as unknown as Wallet, POLYGON.collateral, erc20.encodeFunctionData("transfer", [dao.vault, VAULT_FUNDING]));
    return collateral.balanceOf(dao.vault);
  });
  const id = ethers.id(`live-auction:${market.conditionId}`);
  await step("authorizeBuy", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 5 * 60 + WINDOW; // voting and Timelock take about five minutes
    const buy = { market: BigInt(market.conditionId), tokenId: BigInt(market.yes), shares: SHARES, payment: BigInt(market.maxPayment), deadline, executor: ethers.ZeroAddress };
    const calldatas = [vault.interface.encodeFunctionData("authorizeBuy", [id, buy])], targets = [dao.vault], values = [0];
    const description = `Live open buy: ${SHARES / UNIT} YES on ${market.slug}, Dutch auction up to ${market.maxPayment} pUSD units`;
    const hash = ethers.id(description);
    await (await governor.proposeWithTopic(targets, values, calldatas, description, BigInt(market.conditionId))).wait();
    const proposal = await governor.hashProposal(targets, values, calldatas, hash);
    await until(async () => await governor.state(proposal) === 1n, "voting starts");
    await (await governor.castVote(proposal, 1)).wait();
    await until(async () => await governor.state(proposal) === 4n, "proposal succeeds");
    await (await governor.queue(targets, values, calldatas, hash)).wait();
    await until(async () => BigInt((await ethers.provider.getBlock("latest"))!.timestamp) >= await governor.proposalEta(proposal), "Timelock delay");
    const receipt = await (await governor.execute(targets, values, calldatas, hash)).wait();
    return { id, proposal: proposal.toString(), deadline, authorizedAt: (await vault.authorizedAt(id)).toString(), executeTx: receipt!.hash };
  });

  if (process.env.PHASE === "deliver") await step("deliver", async () => {
    const buy = state.buy;
    if (!buy?.settlementTx || !buy?.orderId || !buy?.cost) throw new Error("Record the CLOB buy first (scripts/live-auction-buy.py)");
    const positions = new ethers.Contract(POLYGON.positions, ["function balanceOf(address,uint256) view returns (uint256)", "function isApprovedForAll(address,address) view returns (bool)", "function setApprovalForAll(address,bool)"], ethers.provider);
    if (await positions.balanceOf(safe.target, market.yes) < SHARES) throw new Error("Safe does not hold the shares");
    // A solver delivers once the price covers its cost; waiting longer only raises its margin.
    await until(async () => await vault.currentPayment(id) >= BigInt(buy.cost), "auction price reaches cost", 30 * 60_000);
    if (!await positions.isApprovedForAll(safe.target, dao.vault)) await ownerExec(safe, deployer as unknown as Wallet, POLYGON.positions, positions.interface.encodeFunctionData("setApprovalForAll", [dao.vault, true]));
    const before = await collateral.balanceOf(safe.target);
    await ownerExec(safe, deployer as unknown as Wallet, dao.vault, vault.interface.encodeFunctionData("fulfill", [id, buy.settlementTx, ethers.zeroPadValue(buy.orderId, 32)]));
    const paid = (await collateral.balanceOf(safe.target)) - before;
    return { solver: safe.target, paid, cost: buy.cost, maxPayment: market.maxPayment, vaultShares: await positions.balanceOf(dao.vault, market.yes), vaultCollateral: await collateral.balanceOf(dao.vault), status: (await vault.status(id)).toString() };
  });
  console.log(JSON.stringify(state, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
}

async function until(check: () => Promise<boolean>, what: string, timeoutMs = 15 * 60_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise(r => setTimeout(r, 5000));
  }
}

// Binary standard-exchange market ending in more than a week whose best ask (0.20–0.30) has 5 shares,
// so the buy clears the CLOB's 1-dollar marketable minimum. The vote caps payment at 1.3× that cost.
async function chooseMarket() {
  const markets = await readJson("https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=100&order=volume24hr&ascending=false");
  for (const m of markets) {
    const ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
    if (m.negRisk || !m.acceptingOrders || ids?.length !== 2 || Date.parse(m.endDate) < Date.now() + 7 * 86_400_000) continue;
    const book = await readJson(`https://clob.polymarket.com/book?token_id=${ids[0]}`).catch(() => undefined);
    if (book?.neg_risk !== false || Number(book.min_order_size) > 5) continue;
    const asks = (book.asks ?? []).map((a: any) => ({ price: Number(a.price), size: Number(a.size) })).sort((a: any, b: any) => a.price - b.price);
    const best = asks[0];
    if (best && best.price >= 0.2 && best.price <= 0.3 && best.size >= 5) {
      const cost = Math.round(best.price * 5 * 1e6);
      return { slug: m.slug as string, conditionId: m.conditionId as string, yes: ids[0] as string, no: ids[1] as string, endDate: new Date(m.endDate).toISOString(), ask: best.price, tickSize: book.tick_size as string, maxPayment: String(Math.ceil(cost * 1.3)) };
    }
  }
  throw new Error("No suitable market");
}

main().catch(e => { console.error(String(e.shortMessage ?? e.message ?? e).replace(/https?:\/\/\S+/g, "[RPC redacted]")); process.exitCode = 1; });
