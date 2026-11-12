import { ethers } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { GovernanceSkill, DaoGovernanceSkill, MarketGovernor } from "../typechain-types";
import { deployDao, type DeploymentPlan } from "./deployment";

export const MARKET = BigInt(ethers.id("Local demo: blockchain market"));
export const OTHER_MARKET = BigInt(ethers.id("Local demo: AI market"));
export const UNIT = 1_000_000n;

// Demonstration settings: one-block voting delay, 30-block voting period and a ten-second Timelock.
function localPlan(issuer: string, closesAt: number): DeploymentPlan {
  const closing = new Date(closesAt * 1000).toISOString();
  const market = (name: string, yesToken: string, noToken: string, skillTopic: number) => ({ conditionId: ethers.id(name), yesToken, noToken, skillTopic, closesAt: closing, uri: "local-demo" });
  const markets = [market("Local demo: blockchain market", "11", "12", 2), market("Local demo: AI market", "21", "22", 0)];
  return { timelockDelaySeconds: 10, votingDelayBlocks: 1, votingPeriodBlocks: 30, skillWeightBps: 5000, trustedIssuer: issuer, markets };
}

export async function localSystem() {
  const [owner, alice, bob, executor, issuer] = await ethers.getSigners();
  const collateral = await (await ethers.getContractFactory("MockCollateral")).deploy();
  const positions = await (await ethers.getContractFactory("MockPositions")).deploy();
  const exchange = await (await ethers.getContractFactory("MockExchange")).deploy(collateral, positions);
  const negativeRiskExchange = await (await ethers.getContractFactory("MockExchange")).deploy(collateral, positions);
  const assets = { collateral: await collateral.getAddress(), positions: await positions.getAddress(), exchange: await exchange.getAddress(), negRiskExchange: await negativeRiskExchange.getAddress() };
  const plan = localPlan(issuer.address, (await time.latest()) + 86400);
  const dao = await deployDao(plan, assets, owner);
  await collateral.mint(dao.vault, 1000n * UNIT);
  await configureMembers();
  return { owner, alice, bob, executor, issuer, ...dao, collateral, positions, exchange, negativeRiskExchange, plan, assets };

  async function configureMembers() {
    for (const member of [alice, bob]) {
      await dao.token.connect(member).joinDAO({ value: ethers.parseEther("20") });
      await dao.token.connect(member).delegate(member.address);
    }
    await issueSkill(dao.skills, issuer, alice, ["blockchain"]);
    await mine();
  }
}

export async function issueSkill(skills: GovernanceSkill | DaoGovernanceSkill, issuer: HardhatEthersSigner, member: HardhatEthersSigner, names: string[]) {
  const did = `did:ethr:${member.address}`;
  if (await skills.memberDID(member.address) === ethers.ZeroHash) await (await skills.connect(member).registerDID(did)).wait();
  const vc = { issuer: { id: `did:ethr:${issuer.address}` }, issuanceDate: "2026-09-26", credentialSubject: { id: did, organization: "Local demo", unit: "Research", skills: names } };
  const signature = await issuer.signTypedData({ name: "Universal VC Protocol", version: "1" }, credentialTypes, vc);
  await (await skills.connect(member).upgradeSkillWithVC(vc, signature)).wait();
}

export const credentialTypes = {
  Issuer: [{ name: "id", type: "string" }],
  CredentialSubject: [{ name: "id", type: "string" }, { name: "organization", type: "string" }, { name: "unit", type: "string" }, { name: "skills", type: "string[]" }],
  VerifiableCredential: [{ name: "issuer", type: "Issuer" }, { name: "issuanceDate", type: "string" }, { name: "credentialSubject", type: "CredentialSubject" }],
};

export async function proposal(governor: MarketGovernor, voter: HardhatEthersSigner, target: string, data: string, topic = MARKET, description = "Acquire approved Polymarket position") {
  const hash = ethers.id(description);
  await governor.connect(voter).proposeWithTopic([target], [0], [data], description, topic);
  const id = await governor.hashProposal([target], [0], [data], hash);
  await mine(2);
  return { id, targets: [target], values: [0], calldatas: [data], hash };
}

export async function approveAndExecute(governor: MarketGovernor, voters: HardhatEthersSigner[], action: Awaited<ReturnType<typeof proposal>>) {
  for (const voter of voters) {
    if (await governor.state(action.id) === 1n) await governor.connect(voter).castVote(action.id, 1);
  }
  await mine(31);
  await governor.queue(action.targets, action.values, action.calldatas, action.hash);
  await time.increase(10);
  await governor.execute(action.targets, action.values, action.calldatas, action.hash);
}
