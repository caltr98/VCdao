import { artifacts, ethers, network } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import { setTimeout as delay } from "node:timers/promises";
import { deployDao, verifyDeployment, type DeploymentPlan } from "./deployment";
import { POLYGON } from "./addresses";
import { erc20, safeAbi } from "./safe-fork";
import { REDEMPTION, redemptionMarket, verifyRedemptionAssets, type RedemptionMarket } from "./redemption";
import { RedemptionSigner } from "./redemption-journal";

export const daoAssets = { collateral: POLYGON.collateral, positions: POLYGON.positions, exchange: POLYGON.exchange, negRiskExchange: POLYGON.negRiskExchange, collateralAdapter: REDEMPTION.adapter };
export const deploymentNames = ["TimelockController", "GovernanceToken", "DaoSkillCalculator", "DaoGovernanceSkill", "MarketRegistry", "RedeemableOrderVault", "SafeMandateHandler", "MarketGovernor", "GovernanceAutomation"];
export type DaoRedemptionPlan = { deployment: DeploymentPlan; market: RedemptionMarket; principal: string; membershipDeposit: string; gasAllocation: string; maxRefund: string; gasPriceCap: string; gasUnitsCap: number; overhead: number; totalGasBudget: string; artifactHashes: Record<string, string> };

export async function artifactHashes() {
  return Object.fromEntries(await Promise.all(deploymentNames.map(async name => [name, ethers.keccak256((await artifacts.readArtifact(name)).bytecode)])));
}

export async function assetSnapshot() {
  const pusd = new ethers.Contract(POLYGON.collateral, erc20, ethers.provider);
  const { ctf } = await verifyRedemptionAssets(redemptionMarket());
  return { block: await ethers.provider.getBlockNumber(), safePusd: String(await pusd.balanceOf(REDEMPTION.safe)), safeRecoveredShares: String(await ctf.balanceOf(REDEMPTION.safe, REDEMPTION.oldToken)), oldVaultShares: String(await ctf.balanceOf(REDEMPTION.oldVault, REDEMPTION.oldToken)), oldVaultPusd: String(await pusd.balanceOf(REDEMPTION.oldVault)), isolatedVaultPusd: String(await pusd.balanceOf("0x1B3C2d5D9F2EaB3f8155892696bB3B56fC0b6968")), mainPol: String(await ethers.provider.getBalance(REDEMPTION.owner)), mainPusd: String(await pusd.balanceOf(REDEMPTION.owner)) };
}

/// One scenario for the real-contract fork and an explicitly approved future mainnet run.
export async function runDaoRedemption(plan: DaoRedemptionPlan, signer: RedemptionSigner) {
  const live = network.name === "polygon", owner = await signer.getAddress();
  if (owner !== REDEMPTION.owner || (await ethers.provider.getNetwork()).chainId !== 137n) throw new Error("Wrong redemption signer or network");
  if (BigInt(plan.principal) > REDEMPTION.principal || BigInt(plan.principal) <= 0n) throw new Error("Principal exceeds the 0.1 pUSD test limit");
  const { adapter, ctf } = await verifyRedemptionAssets(plan.market), pusd = new ethers.Contract(POLYGON.collateral, erc20, ethers.provider);
  const before = await signer.snapshot("before", assetSnapshot);
  const safe = new ethers.Contract(REDEMPTION.safe, safeAbi, signer);
  if (await safe.getThreshold() !== 1n || !(await safe.getOwners()).includes(owner)) throw new Error("Unexpected principal funding Safe");
  const dao = await deployDao(plan.deployment, daoAssets, signer);
  const vault = await ethers.getContractAt("RedeemableOrderVault", await dao.vault.getAddress(), signer);
  const addresses = Object.fromEntries(await Promise.all(Object.entries(dao).filter(([name]) => name !== "startBlock").map(async ([name, contract]) => [name, await (contract as { getAddress(): Promise<string> }).getAddress()])));
  const deploymentChecks = await verifyDeployment(dao, plan.deployment, daoAssets, owner);
  await signer.named("joinDAO", () => dao.token.joinDAO({ value: BigInt(plan.membershipDeposit) }));
  await signer.named("delegate", () => dao.token.delegate(owner));
  await signer.named("fundPOL", () => signer.sendTransaction({ to: addresses.vault, value: BigInt(plan.gasAllocation) }));
  await governed("allocate", [vault.interface.encodeFunctionData("configureRedemptionGas", [plan.gasAllocation, plan.maxRefund, plan.gasPriceCap, plan.gasUnitsCap, plan.overhead])]);
  const signature = ethers.concat([ethers.zeroPadValue(owner, 32), ethers.ZeroHash, "0x01"]);
  const funding = erc20.encodeFunctionData("transfer", [owner, plan.principal]);
  await signer.named("fundPrincipal", () => safe.getFunction("execTransaction")(POLYGON.collateral, 0, funding, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, signature));
  await signer.named("approveSplit", () => signer.sendTransaction({ to: POLYGON.collateral, data: erc20.encodeFunctionData("approve", [REDEMPTION.adapter, plan.principal]) }));
  await signer.named("split", () => signer.sendTransaction({ to: REDEMPTION.adapter, data: adapter.interface.encodeFunctionData("splitPosition", [POLYGON.collateral, ethers.ZeroHash, plan.market.conditionId, [1, 2], plan.principal]) }));
  await signer.named("clearSplitApproval", () => signer.sendTransaction({ to: POLYGON.collateral, data: erc20.encodeFunctionData("approve", [REDEMPTION.adapter, 0]) }));
  await signer.named("deliver", () => signer.sendTransaction({ to: POLYGON.positions, data: ctf.interface.encodeFunctionData("safeBatchTransferFrom", [owner, addresses.vault, [plan.market.yes, plan.market.no], [plan.principal, plan.principal], "0x"]) }));
  const beforeRedeem = await signer.snapshot("beforeRedeem", async () => ({ block: await ethers.provider.getBlockNumber(), vaultPusd: String(await pusd.balanceOf(vault)), vaultPol: String(await ethers.provider.getBalance(vault)), callerPol: String(await ethers.provider.getBalance(owner)), allocation: String(await vault.redemptionGasBudget()) }));
  const redemption = await governed("redeem", [vault.interface.encodeFunctionData("redeem", [BigInt(plan.market.conditionId)])]);
  const receipt = (await redemption.tx.wait())!;
  const events = receipt.logs.filter(log => log.address.toLowerCase() === addresses.vault.toLowerCase()).map(log => { try { return vault.interface.parseLog(log); } catch { return null; } });
  const refund = events.find(event => event?.name === "RedemptionRefund"), redeemed = events.find(event => event?.name === "PositionRedeemed");
  if (!refund || !redeemed) throw new Error("Redemption or reimbursement event missing");
  const amount = BigInt(refund.args.amount), tag = { blockTag: receipt.blockNumber };
  const expectedAmount = [BigInt(refund.args.gasUnits) * BigInt(refund.args.gasPrice), BigInt(plan.maxRefund), BigInt(beforeRedeem.allocation)].reduce((a, b) => a < b ? a : b);
  const checks = {
    realResolvedCondition: await ctf.payoutDenominator(plan.market.conditionId, tag) > 0n,
    governedExecution: await dao.governor.state(redemption.id, tag) === 7n && redeemed.args.caller === addresses.timelock,
    exactPayout: redeemed.args.payout === BigInt(plan.principal) && await pusd.balanceOf(vault, tag) === BigInt(beforeRedeem.vaultPusd) + BigInt(plan.principal),
    sharesConsumed: await ctf.balanceOf(vault, plan.market.yes, tag) === 0n && await ctf.balanceOf(vault, plan.market.no, tag) === 0n,
    approvalCleared: !await ctf.isApprovedForAll(vault, REDEMPTION.adapter, tag),
    correctRefundCaller: refund.args.caller === owner && refund.args.proposal === redemption.id && refund.args.market === BigInt(plan.market.conditionId),
    boundedRefund: amount > 0n && amount === expectedAmount && refund.args.gasUnits <= BigInt(plan.gasUnitsCap) && refund.args.gasPrice <= BigInt(plan.gasPriceCap) && refund.args.gasPrice <= receipt.gasPrice,
    refundDelivered: refund.args.delivered && await vault.refundLiability(tag) === 0n,
    allocationDecreased: await vault.redemptionGasBudget(tag) === BigInt(beforeRedeem.allocation) - amount,
    treasuryPolDecreased: await ethers.provider.getBalance(vault, receipt.blockNumber) === BigInt(beforeRedeem.vaultPol) - amount,
    callerReceivedRefund: await ethers.provider.getBalance(owner, receipt.blockNumber) === await ethers.provider.getBalance(owner, receipt.blockNumber - 1) - receipt.fee + amount,
    collateralReservationsPreserved: await vault.reserved(tag) === 0n,
  };
  if (Object.values(checks).some(passed => !passed)) throw new Error("Governed redemption verification failed");
  // Cleanup is a further explicit proposal. Refund allocation is released before native withdrawal.
  const remainingPol = await signer.snapshot("remainingPol", async () => String(await ethers.provider.getBalance(vault)));
  await governed("cleanup", [
    vault.interface.encodeFunctionData("configureRedemptionGas", [0, 0, 0, 0, 0]),
    vault.interface.encodeFunctionData("withdrawCollateral", [REDEMPTION.safe, plan.principal]),
    vault.interface.encodeFunctionData("withdrawNative", [owner, remainingPol]),
  ]);
  const after = await assetSnapshot();
  const preservation = { principalReturned: after.safePusd === before.safePusd && after.mainPusd === before.mainPusd, recoveredSafeSharesPreserved: after.safeRecoveredShares === before.safeRecoveredShares, oldVaultAssetsPreserved: after.oldVaultShares === before.oldVaultShares && after.oldVaultPusd === before.oldVaultPusd, isolatedFixturePreserved: after.isolatedVaultPusd === before.isolatedVaultPusd, fixtureCleaned: await pusd.balanceOf(vault) === 0n && await ethers.provider.getBalance(vault) === 0n };
  if (Object.values(preservation).some(passed => !passed)) throw new Error("Cleanup or existing asset preservation failed");
  return { environment: live ? "Polygon mainnet" : "Polygon fork; only Main EOA impersonated; real oracle resolution and adapter; no mainnet broadcasts", contracts: addresses, before, beforeRedeem, after, payout: plan.principal, refund: { proposal: String(redemption.id), market: plan.market.conditionId, caller: owner, amount: String(amount), gasUnits: String(refund.args.gasUnits), gasPrice: String(refund.args.gasPrice), overhead: plan.overhead, transaction: receipt.hash, block: receipt.blockNumber, networkFee: String(receipt.fee) }, deploymentChecks, checks, preservation };

  async function governed(name: string, calldatas: string[]) {
    const description = `DAO-funded redemption fixture: ${name}`, hash = ethers.id(description), targets = calldatas.map(() => addresses.vault), values = calldatas.map(() => 0);
    await signer.named(`${name}Propose`, () => dao.governor.proposeWithTopic(targets, values, calldatas, description, BigInt(plan.market.conditionId)));
    const id = await dao.governor.hashProposal(targets, values, calldatas, hash);
    await waitBlocks(Number(await dao.governor.proposalSnapshot(id)) + 1);
    await signer.named(`${name}Vote`, () => dao.governor.castVote(id, 1));
    await waitBlocks(Number(await dao.governor.proposalDeadline(id)) + 1);
    await signer.named(`${name}Queue`, () => dao.governor.queue(targets, values, calldatas, hash));
    await waitTimestamp(Number(await dao.governor.proposalEta(id)));
    const tx = await signer.named(`${name}Execute`, () => dao.governor.execute(targets, values, calldatas, hash));
    return { id, tx };
  }
}

async function waitBlocks(target: number) {
  if (network.name === "hardhat") {
    const remaining = target - await ethers.provider.getBlockNumber();
    if (remaining > 0) await mine(remaining);
  } else while (await ethers.provider.getBlockNumber() < target) await delay(2000);
}

async function waitTimestamp(target: number) {
  if (network.name === "hardhat") {
    if ((await ethers.provider.getBlock("latest"))!.timestamp < target) await time.increaseTo(target);
  } else while ((await ethers.provider.getBlock("latest"))!.timestamp < target) await delay(2000);
}
