import { ethers } from "hardhat";
import type { BaseContract, Signer } from "ethers";
import type { MarketRegistry, TimelockController } from "../typechain-types";
import { sameAddress } from "./addresses";
import { calculatorArgs, daoTopicPolicy, validateSkillPolicy, type SkillPolicy } from "./topic-policy";

/// Every governance setting is explicit; nothing falls back to the local demonstration values.
/// Voting delay and period count blocks: the reused token keeps OpenZeppelin's block-number clock.
export type DeploymentPlan = {
  timelockDelaySeconds: number;
  votingDelayBlocks: number;
  votingPeriodBlocks: number;
  skillWeightBps: number;
  trustedIssuer: string;
  markets: MarketPlan[];
  skillPolicy?: SkillPolicy;
};
export type MarketPlan = { conditionId: string; yesToken: string; noToken: string; skillTopic: number; closesAt: string; uri: string };
export type DeploymentAssets = { collateral: string; positions: string; exchange: string; negRiskExchange: string; collateralAdapter?: string };

export function validatePlan(plan: DeploymentPlan) {
  const policy = plan.skillPolicy ?? daoTopicPolicy;
  validateSkillPolicy(policy);
  for (const key of ["timelockDelaySeconds", "votingDelayBlocks", "votingPeriodBlocks", "skillWeightBps"] as const) {
    if (!Number.isSafeInteger(plan[key]) || plan[key] < 0) throw new Error(`${key} must be a non-negative integer`);
  }
  if (plan.votingPeriodBlocks < 1 || plan.skillWeightBps > 10_000) throw new Error("Expected a voting period and a skill weight of at most 10000 bps");
  if (ethers.getAddress(plan.trustedIssuer) === ethers.ZeroAddress) throw new Error("A trusted credential issuer is required");
  // Every proposal needs a registered topic, including one that registers a further market.
  if (!plan.markets.length) throw new Error("Register at least one bootstrap market");
  for (const market of plan.markets) {
    validateMarket(market);
    if (market.skillTopic < 0 || !policy.topics[market.skillTopic]) throw new Error("Market skill topic is absent from the DAO catalog");
  }
}

function validateMarket(market: MarketPlan) {
  if (!ethers.isHexString(market.conditionId, 32) || !/^\d+$/.test(market.yesToken) || !/^\d+$/.test(market.noToken)) throw new Error("Market needs a condition ID and decimal outcome token IDs");
  if (!Number.isSafeInteger(market.skillTopic) || Number.isNaN(Date.parse(market.closesAt))) throw new Error("Market needs a skill topic and an ISO closing time");
}

/// Deploy, register bootstrap markets through a zero-delay Timelock, raise the delay, then hand
/// proposal and cancellation rights to the Governor and drop every deployer role.
export async function deployDao(plan: DeploymentPlan, assets: DeploymentAssets, deployer: Signer) {
  validatePlan(plan);
  const startBlock = await ethers.provider.getBlockNumber() + 1;
  const dao = await deployContracts(plan, assets, deployer);
  await configure(dao, plan, assets);
  await handOver(dao.timelock, await dao.governor.getAddress(), await deployer.getAddress());
  return { ...dao, startBlock };
}

async function ready<T extends BaseContract>(deployment: Promise<T>) {
  const contract = await deployment;
  await contract.waitForDeployment();
  return contract;
}

async function deployContracts(plan: DeploymentPlan, assets: DeploymentAssets, deployer: Signer) {
  const address = await deployer.getAddress();
  const timelock = await ready((await ethers.getContractFactory("TimelockController", deployer)).deploy(0, [address], [ethers.ZeroAddress], address));
  const token = await ready((await ethers.getContractFactory("GovernanceToken", deployer)).deploy(timelock, plan.skillWeightBps, 10_000 - plan.skillWeightBps));
  const calculator = await ready((await ethers.getContractFactory("DaoSkillCalculator", deployer)).deploy(...calculatorArgs(plan.skillPolicy ?? daoTopicPolicy)));
  const skills = await ready((await ethers.getContractFactory("DaoGovernanceSkill", deployer)).deploy(token, timelock, plan.skillWeightBps, calculator));
  const registry = await ready((await ethers.getContractFactory("MarketRegistry", deployer)).deploy(timelock, skills));
  const vault = await deployVault(timelock, registry, assets, deployer);
  const mandateHandler = await ready((await ethers.getContractFactory("SafeMandateHandler", deployer)).deploy(timelock, assets.collateral, assets.positions, assets.exchange));
  const governor = await ready((await ethers.getContractFactory("MarketGovernor", deployer)).deploy(token, registry, timelock, vault, mandateHandler, plan.votingDelayBlocks, plan.votingPeriodBlocks));
  const automation = await ready((await ethers.getContractFactory("GovernanceAutomation", deployer)).deploy(governor));
  return { timelock, token, calculator, skills, registry, vault, mandateHandler, governor, automation };
}

type Dao = Awaited<ReturnType<typeof deployContracts>>;

async function deployVault(timelock: TimelockController, registry: MarketRegistry, assets: DeploymentAssets, deployer: Signer) {
  const args = [await timelock.getAddress(), assets.collateral, assets.positions, await registry.getAddress(), assets.exchange, assets.negRiskExchange];
  const name = assets.collateralAdapter ? "RedeemableOrderVault" : "OrderVault";
  if (assets.collateralAdapter) args.push(assets.collateralAdapter);
  const vault = await ready((await ethers.getContractFactory(name, deployer)).deploy(...args));
  return ethers.getContractAt("OrderVault", await vault.getAddress(), deployer);
}

async function configure(dao: Dao, plan: DeploymentPlan, assets: DeploymentAssets) {
  await (await dao.token.setTreasury(dao.vault)).wait();
  await (await dao.skills.setTrustedIssuer(plan.trustedIssuer)).wait();
  if (assets.collateralAdapter) {
    const vault = await ethers.getContractAt("RedeemableOrderVault", await dao.vault.getAddress());
    await timelockCall(dao.timelock, await vault.getAddress(), vault.interface.encodeFunctionData("bindRedemptionGovernor", [await dao.governor.getAddress()]));
  }
  for (const market of plan.markets) await timelockCall(dao.timelock, await dao.registry.getAddress(), dao.registry.interface.encodeFunctionData("registerMarket", marketArgs(market)));
  await timelockCall(dao.timelock, await dao.timelock.getAddress(), dao.timelock.interface.encodeFunctionData("updateDelay", [plan.timelockDelaySeconds]));
}

export function marketArgs(market: MarketPlan): [bigint, MarketRegistry.MarketStruct, string] {
  const closesAt = Math.floor(Date.parse(market.closesAt) / 1000);
  return [BigInt(market.conditionId), { yesToken: BigInt(market.yesToken), noToken: BigInt(market.noToken), skillTopic: market.skillTopic, closesAt, exists: true }, market.uri];
}

// The Timelock starts at zero delay, so a bootstrap operation is ready once it is scheduled.
async function timelockCall(timelock: TimelockController, target: string, data: string) {
  const salt = ethers.keccak256(data);
  await (await timelock.schedule(target, 0, data, ethers.ZeroHash, salt, 0)).wait();
  await (await timelock.execute(target, 0, data, ethers.ZeroHash, salt)).wait();
}

// Revoking the deployer's admin role must come last: afterwards only the Timelock manages roles.
async function handOver(timelock: TimelockController, governor: string, deployer: string) {
  const [proposer, canceller, admin] = await Promise.all([timelock.PROPOSER_ROLE(), timelock.CANCELLER_ROLE(), timelock.DEFAULT_ADMIN_ROLE()]);
  for (const role of [proposer, canceller]) await (await timelock.grantRole(role, governor)).wait();
  for (const role of [proposer, canceller, admin]) await (await timelock.revokeRole(role, deployer)).wait();
}

/// Read the deployed wiring back from chain; any failed check throws with the check names.
export async function verifyDeployment(dao: Dao, plan: DeploymentPlan, assets: DeploymentAssets, deployer: string) {
  const { timelock, governor, vault } = dao;
  const [proposer, canceller, executor, admin] = await Promise.all([timelock.PROPOSER_ROLE(), timelock.CANCELLER_ROLE(), timelock.EXECUTOR_ROLE(), timelock.DEFAULT_ADMIN_ROLE()]);
  const deployerRoles = await Promise.all([proposer, canceller, admin].map(role => timelock.hasRole(role, deployer)));
  const checks = {
    timelockDelay: await timelock.getMinDelay() === BigInt(plan.timelockDelaySeconds),
    governorProposesAndCancels: await timelock.hasRole(proposer, governor) && await timelock.hasRole(canceller, governor),
    executionOpenToAnyone: await timelock.hasRole(executor, ethers.ZeroAddress),
    deployerHasNoTimelockRole: !deployerRoles.some(Boolean),
    votingSchedule: await governor.votingDelay() === BigInt(plan.votingDelayBlocks) && await governor.votingPeriod() === BigInt(plan.votingPeriodBlocks),
    treasuryAndIssuer: sameAddress(await dao.token.treasury(), await vault.getAddress()) && await dao.skills.trustedIssuers(plan.trustedIssuer),
    polymarketAssets: sameAddress(await vault.collateral(), assets.collateral) && sameAddress(await vault.positions(), assets.positions),
    redemptionAdapter: !assets.collateralAdapter || sameAddress(await (await ethers.getContractAt("RedeemableOrderVault", await vault.getAddress())).redemptionAdapter(), assets.collateralAdapter),
    redemptionGovernor: !assets.collateralAdapter || sameAddress(await (await ethers.getContractAt("RedeemableOrderVault", await vault.getAddress())).redemptionGovernor(), await governor.getAddress()),
    exchanges: sameAddress(await vault.standardExchange(), assets.exchange) && sameAddress(await vault.negativeRiskExchange(), assets.negRiskExchange),
    mandateHandler: sameAddress(await governor.mandateHandler(), await dao.mandateHandler.getAddress()) && sameAddress(await dao.mandateHandler.timelock(), await timelock.getAddress()) && sameAddress(await dao.mandateHandler.exchange(), assets.exchange),
    automationGovernor: sameAddress(await dao.automation.governor(), await governor.getAddress()),
    marketsRegistered: (await Promise.all(plan.markets.map(market => dao.registry.isValidTopic(BigInt(market.conditionId))))).every(Boolean),
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (failed.length) throw new Error(`Deployment checks failed: ${failed.join(", ")}`);
  return checks;
}
