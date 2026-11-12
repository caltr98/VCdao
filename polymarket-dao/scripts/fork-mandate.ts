import { ethers } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Contract, Wallet } from "ethers";
import { POLYGON, printJson } from "./polymarket";
import { forkPolygon } from "./fork";
import { deployDao } from "./deployment";
import { issueSkill } from "./local";
import { UNIT, USDC_E, chooseMarket, collateral, createSafe, erc20, exchange, findHolder, findOperator, funded, impersonated, ownerExec, positions, resolve, signed, usdce, type Fork, type Market, type Order } from "./safe-fork";

// Polygon-fork check of SafeMandateHandler on the deployed V2 exchange. Part 1 probes what the Safe
// holds when its ERC1155 hook runs on each BUY path. Part 2 deploys the DAO, votes one proposal that
// funds a guarded factory Safe and sets its mandate, then tries the approved order and each attack,
// and ends with a permissionless redeem to the treasury. Everything runs on the in-process fork; the
// order post is simulated by handing the signed order to the forked operator.
type Operator = Awaited<ReturnType<typeof impersonated>>;
const handlerErrors = new ethers.Interface(["error NoActiveMandate()", "error NotExchangeSettlement()", "error WrongToken()", "error BudgetExceeded()", "error PriceAboveLimit()", "error BatchNotAccepted()", "error MandateActive()", "error OnlyTimelock()", "error OwnerTransactionNotAllowed()"]);

async function main() {
  const market = await chooseMarket();
  const fork = await forkPolygon();
  try {
    const operator = await impersonated(await findOperator(fork.remote, fork.block));
    const holder = await impersonated(await findHolder(fork.remote, fork.block, 150n * UNIT));
    const fund = async (to: string, amount: bigint) => (await (collateral.connect(holder) as Contract).getFunction("transfer")(to, amount)).wait();
    const report = { checkedAt: new Date().toISOString(), scope: "In-process Polygon fork; nothing was sent to Polygon or to an authenticated API. Order posts are simulated.", forkedFrom: fork.block, market: { slug: market.slug, conditionId: market.conditionId }, probe: await probe(market, operator, fund), mandate: await mandate(market, fork, operator, fund) };
    mkdirSync("output", { recursive: true });
    writeFileSync("output/fork-mandate.json", JSON.stringify(report, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
    printJson(report);
  } finally { fork.remote.destroy(); }
}

type Fund = (to: string, amount: bigint) => Promise<unknown>;

// Part 1: a guarded Safe whose fallback handler records the Safe's pUSD and share balances at each hook.
async function probe(market: Market, operator: Operator, fund: Fund) {
  const trader = await funded(), buyer = await trader2(fund, 40n * UNIT), seller = await trader2(fund, 10n * UNIT);
  const handler = await (await ethers.getContractFactory("ProbeReceiverHandler")).deploy(POLYGON.collateral, POLYGON.positions);
  const { safeAddress } = await guardedSafe(trader, await handler.getAddress(), []);
  await fund(safeAddress, 15n * UNIT);
  const principal = 5n * UNIT, shares = 10n * UNIT, half = principal / 2n, fee = UNIT / 20n;
  const balance = async () => collateral.balanceOf(safeAddress) as Promise<bigint>;

  // 1. Safe taker BUY against a complement BUY (MINT), half the order, with a taker fee.
  const order = await signed(trader, safeAddress, market.yes, principal, shares, 2);
  const beforeTaker = await balance();
  await settle(market, operator, order, [await signed(buyer, buyer.address, market.no, half, shares / 2n, 0)], half, [half], fee, [0n]);
  // 2. The same Safe order as maker BUY against a complement taker BUY (MINT), the other half, with a maker fee.
  const beforeMaker = await balance();
  await settle(market, operator, await signed(buyer, buyer.address, market.no, half, shares / 2n, 0), [order], half, [half], 0n, [fee]);
  // 3. Safe taker BUY against a resting SELL of the same token (COMPLEMENTARY): the seller first buys YES.
  await settle(market, operator, await signed(seller, seller.address, market.yes, principal, shares, 0), [await signed(buyer, buyer.address, market.no, principal, shares, 0)], principal, [principal], 0n, [0n]);
  await (await (positions.connect(seller) as Contract).getFunction("setApprovalForAll")(POLYGON.exchange, true)).wait();
  const beforeDirect = await balance();
  await settle(market, operator, await signed(trader, safeAddress, market.yes, principal, shares, 2), [await signed(seller, seller.address, market.yes, shares, principal, 0, 1)], principal, [shares], 0n, [0n]);

  const hits = (await handler.allHits()).map(h => ({ operator: h.operator, from: h.from, id: h.id === market.yes ? "yes" : h.id.toString(), value: h.value, safeCollateralAtHook: h.collateral, safeSharesAtHook: h.shares, batch: h.batch }));
  const who = (a: string) => a === POLYGON.exchange ? "exchange" : a === seller.address ? "seller" : a;
  return {
    hits: hits.map(h => ({ ...h, operator: who(h.operator), from: who(h.from) })),
    mintTaker: { before: beforeTaker, atHook: hits[0].safeCollateralAtHook, deductedBeforeTokens: beforeTaker - hits[0].safeCollateralAtHook, expected: half + fee },
    mintMaker: { before: beforeMaker, atHook: hits[1].safeCollateralAtHook, deductedBeforeTokens: beforeMaker - hits[1].safeCollateralAtHook, expected: half + fee },
    complementaryTaker: { before: beforeDirect, atHook: hits[2].safeCollateralAtHook, deductedBeforeTokens: beforeDirect - hits[2].safeCollateralAtHook, after: await balance() },
    sharesCountedBeforeHook: hits.every((h, i) => h.safeSharesAtHook === (i === 0 ? h.value : hits.slice(0, i + 1).reduce((s, x) => s + x.value, 0n))),
    batchHooks: hits.filter(h => h.batch).length,
  };
}

// Part 2: the DAO votes the funding and the mandate; the trading EOA can fill only the voted order.
async function mandate(market: Market, fork: Fork, operator: Operator, fund: Fund) {
  const [deployer, alice, bob, issuer, anyone] = await ethers.getSigners();
  const dao = await deployDao(forkPlan(market, issuer.address), POLYGON, deployer);
  await fund(await dao.vault.getAddress(), 25n * UNIT);
  for (const member of [alice, bob]) {
    await (await dao.token.connect(member).joinDAO({ value: ethers.parseEther("20") })).wait();
    await (await dao.token.connect(member).delegate(member.address)).wait();
  }
  await issueSkill(dao.skills, issuer, alice, ["blockchain"]);
  await mine();

  const trader = await funded(), counterparty = await trader2(fund, 40n * UNIT), accomplice = await trader2(fund, 15n * UNIT);
  const sweeper = await (await ethers.getContractFactory("SafeSweeper")).deploy(await dao.vault.getAddress(), USDC_E, POLYGON.positions, await dao.mandateHandler.getAddress());
  const { safe, safeAddress } = await guardedSafe(trader, await dao.mandateHandler.getAddress(), [await dao.timelock.getAddress(), await sweeper.getAddress(), await dao.mandateHandler.getAddress()]);

  // A proposal on this market by alice, voted by both members, queued and executed after the Timelock delay.
  const pass = async (targets: string[], calldatas: string[], description: string) => {
    const values = targets.map(() => 0);
    await (await dao.governor.connect(alice).proposeWithTopic(targets, values, calldatas, description, BigInt(market.conditionId))).wait();
    const id = await dao.governor.hashProposal(targets, values, calldatas, ethers.id(description));
    await mine(2);
    for (const voter of [alice, bob]) if (await dao.governor.state(id) === 1n) await (await dao.governor.connect(voter).castVote(id, 1)).wait();
    await mine(61);
    await (await dao.governor.queue(targets, values, calldatas, ethers.id(description))).wait();
    await time.increase(61);
    await (await dao.governor.execute(targets, values, calldatas, ethers.id(description))).wait();
    return id;
  };

  // One proposal: fund the Safe from the vault, then set its mandate (0.50 limit, 20 pUSD budget, 0.20 fee cap).
  const limitPrice = UNIT / 2n, budget = 20n * UNIT, feeCap = UNIT / 5n, deadline = (await time.latest()) + 86_400;
  const targets = [await dao.vault.getAddress(), await dao.mandateHandler.getAddress()];
  const calldatas = [dao.vault.interface.encodeFunctionData("withdrawCollateral", [safeAddress, budget + feeCap]), dao.mandateHandler.interface.encodeFunctionData("setMandate", [safeAddress, BigInt(market.conditionId), market.yes, limitPrice, budget, feeCap, deadline])];
  const description = `Fork mandate: buy YES on ${market.slug} at most ${limitPrice} per share`;
  const proposalId = await pass(targets, calldatas, description);
  const governance = { proposalId, state: await dao.governor.state(proposalId), safeCollateral: await collateral.balanceOf(safeAddress), mandate: await dao.mandateHandler.mandates(safeAddress) };

  // A BUY by the Safe for `principal` pUSD and `shares` of `token`, matched as MINT against a complement BUY.
  const buy = async (token: bigint, principal: bigint, shares: bigint, fee = 0n, against: Wallet = counterparty) => {
    const complement = token === market.yes ? market.no : market.yes;
    return attempt(() => settle(market, operator, signedSafe(token, principal, shares), [signed(against, against.address, complement, shares - principal, shares, 0)], principal, [shares - principal], fee, [0n]));
  };
  const signedSafe = (token: bigint, principal: bigint, shares: bigint) => signed(trader, safeAddress, token, principal, shares, 2);
  // The accomplice sells YES directly to the Safe (COMPLEMENTARY path); it first buys YES through a MINT.
  await settle(market, operator, signed(accomplice, accomplice.address, market.yes, 5n * UNIT, 10n * UNIT, 0), [signed(counterparty, counterparty.address, market.no, 5n * UNIT, 10n * UNIT, 0)], 5n * UNIT, [5n * UNIT], 0n, [0n]);
  await (await (positions.connect(accomplice) as Contract).getFunction("setApprovalForAll")(POLYGON.exchange, true)).wait();
  const direct = (principal: bigint) => attempt(() => settle(market, operator, signedSafe(market.yes, principal, 10n * UNIT), [signed(accomplice, accomplice.address, market.yes, 10n * UNIT, principal, 0, 1)], principal, [10n * UNIT], 0n, [0n]));

  const attacks = {
    wrongOutcome: await buy(market.no, 5n * UNIT, 10n * UNIT),
    worsePrice: await buy(market.yes, 6n * UNIT, 10n * UNIT),
    selfDealingMint: await buy(market.yes, 99n * UNIT / 10n, 10n * UNIT, 0n, accomplice),
    selfDealingDirect: await direct(99n * UNIT / 10n),
    directSellAtLimit: await direct(5n * UNIT),
    feeAboveCap: await buy(market.yes, 5n * UNIT, 10n * UNIT, feeCap + 1n),
  };
  const approvedOrder = await buy(market.yes, 5n * UNIT, 10n * UNIT, UNIT / 20n);
  // Two partial fills of one order within the terms, then a third fill that breaks the cumulative price.
  const partialOrder = await signedSafe(market.yes, 5n * UNIT, 10n * UNIT);
  const partial = (principal: bigint) => attempt(() => settle(market, operator, partialOrder, [signed(counterparty, counterparty.address, market.no, principal, 2n * principal, 0)], principal, [principal], 0n, [0n]));
  const partialFills = { first: await partial(5n * UNIT / 2n), second: await partial(5n * UNIT / 2n), thirdAboveLimit: await buy(market.yes, 6n * UNIT, 10n * UNIT) };
  const afterFills = { safeYes: await positions.balanceOf(safeAddress, market.yes), safeCollateral: await collateral.balanceOf(safeAddress) };
  const erc1271Answer = await attempt(() => new ethers.Contract(safeAddress, ["function isValidSignature(bytes32,bytes) view returns (bytes4)"], ethers.provider).isValidSignature(ethers.ZeroHash, "0x"));

  const recoverBeforeDeadline = await attempt(async () => (await sweeper.connect(anyone).recover(safeAddress)).wait());
  await time.increaseTo(deadline + 1);
  const afterDeadline = await buy(market.yes, UNIT / 2n, UNIT);
  const timelock = await impersonated(await dao.timelock.getAddress());
  await (await dao.mandateHandler.connect(timelock).setMandate(safeAddress, BigInt(market.conditionId), market.yes, limitPrice, budget, feeCap, (await time.latest()) + 3600)).wait();
  await (await dao.mandateHandler.connect(timelock).clearMandate(safeAddress)).wait();
  const afterClear = await buy(market.yes, UNIT / 2n, UNIT);
  const vaultBefore: bigint = await collateral.balanceOf(await dao.vault.getAddress());
  const recover = await attempt(async () => (await sweeper.connect(anyone).recover(safeAddress)).wait());
  const recovery = { recoverBeforeDeadline, recover, vaultPusdGain: (await collateral.balanceOf(await dao.vault.getAddress())) - vaultBefore, safeCollateral: await collateral.balanceOf(safeAddress) };

  const resolution = await resolve(market, fork, [1n, 0n]);
  const vaultUsdceBefore: bigint = await usdce.balanceOf(await dao.vault.getAddress());
  const redeem = await attempt(async () => (await sweeper.connect(anyone).redeem(safeAddress, market.conditionId)).wait());
  const afterRedeem = { safeYes: await positions.balanceOf(safeAddress, market.yes), vaultUsdceGain: (await usdce.balanceOf(await dao.vault.getAddress())) - vaultUsdceBefore, safeCollateral: await collateral.balanceOf(safeAddress) };
  // Release by vote: the guard goes, and the owner's handler change (refused while guarded) now passes.
  const self = (fn: string, args: unknown[]) => ownerExec(safe, trader, safeAddress, safe.interface.encodeFunctionData(fn, args));
  const handlerChangeWhileGuarded = await attempt(() => self("setFallbackHandler", [trader.address]));
  const releaseByNonTimelock = await attempt(async () => (await dao.mandateHandler.connect(anyone).releaseSafe(safeAddress)).wait());
  await pass([await dao.mandateHandler.getAddress()], [dao.mandateHandler.interface.encodeFunctionData("releaseSafe", [safeAddress])], `Release Safe ${safeAddress}`);
  const guardSlot = await ethers.provider.getStorage(safeAddress, "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8");
  const release = { handlerChangeWhileGuarded, releaseByNonTimelock, guardAfterVote: ethers.dataSlice(guardSlot, 12), handlerChangeAfterRelease: await attempt(() => self("setFallbackHandler", [trader.address])) };
  return { safe: safeAddress, owners: await safe.getOwners(), governance, attacks, approvedOrder, partialFills, afterFills, erc1271Answer, afterDeadline, afterClear, recovery, resolution, redeem, afterRedeem, release };
}

// The Safe of `trader` with the given modules, an exchange approval, `handler` as fallback handler and the trader guard set last.
async function guardedSafe(trader: Wallet, handler: string, modules: string[]) {
  const created = await createSafe(trader);
  for (const module of modules) await created.self("enableModule", [module]);
  await ownerExec(created.safe, trader, POLYGON.collateral, erc20.encodeFunctionData("approve", [POLYGON.exchange, ethers.MaxUint256]));
  await created.self("setFallbackHandler", [handler]);
  const guard = await (await ethers.getContractFactory("SafeTraderGuard")).deploy(POLYGON.collateral, POLYGON.exchange);
  await created.self("setGuard", [await guard.getAddress()]);
  return created;
}

async function trader2(fund: Fund, amount: bigint) {
  const wallet = await funded();
  await fund(wallet.address, amount);
  await (await (collateral.connect(wallet) as Contract).getFunction("approve")(POLYGON.exchange, ethers.MaxUint256)).wait();
  return wallet;
}

async function settle(market: Market, operator: Operator, taker: Order | Promise<Order>, makers: (Order | Promise<Order>)[], takerFill: bigint, makerFills: bigint[], takerFee: bigint, makerFees: bigint[]) {
  return (await (exchange.connect(operator) as Contract).getFunction("matchOrders")(market.conditionId, await taker, await Promise.all(makers), takerFill, makerFills, takerFee, makerFees)).wait();
}

// "accepted", or the handler's custom error when it caused the revert.
async function attempt(call: () => Promise<unknown>) {
  try { await call(); return "accepted"; } catch (e: any) {
    const data = e.data ?? e.error?.data ?? e.info?.error?.data;
    const name = typeof data === "string" && data.length >= 10 ? handlerErrors.parseError(data)?.name : undefined;
    return name ? `rejected: ${name}` : `rejected: ${e.shortMessage ?? e.message}`.slice(0, 160);
  }
}

function forkPlan(market: Market, issuer: string) {
  const closesAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const markets = [{ conditionId: market.conditionId, yesToken: market.yes.toString(), noToken: market.no.toString(), skillTopic: 2, closesAt, uri: `https://polymarket.com/market/${market.slug}` }];
  return { timelockDelaySeconds: 60, votingDelayBlocks: 1, votingPeriodBlocks: 60, skillWeightBps: 5000, trustedIssuer: issuer, markets };
}

main().catch(e => { console.error(e); process.exitCode = 1; });
