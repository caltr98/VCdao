import { ethers, network, artifacts } from "hardhat";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployDao, verifyDeployment } from "./deployment";
import { credentialTypes } from "./local";
import { daoTopicPolicy } from "./topic-policy";

const OUT = "output/benchmarks-bitmap";
const COUNTS = [1, 2, 4, 8, 16, 32, 64];
const SKILLS = daoTopicPolicy.skills.slice(0, 8).map(skill => skill.name);
const rows: any[] = [], summaries: any[] = [], runs: any[] = [];
const encode = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? String(item) : item, 2);
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function record(transaction: any, sample: number, stage: string, operation: string, member?: number) {
  const receipt = await transaction.wait();
  assert.equal(receipt.status, 1);
  rows.push({ sample, stage, operation, member: member ?? null, actor: transaction.from, transaction_hash: transaction.hash, block_number: receipt.blockNumber, gas_used: String(receipt.gasUsed), gas_price_wei: String(receipt.gasPrice), fee_wei: String(receipt.fee), environment: "local", network: "hardhat", included_in_upgrade_cost: operation === "upgradeSkillWithVC" });
  return receipt.gasUsed as bigint;
}

async function memberWallet(index: number) {
  const wallet = ethers.HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined, `m/44'/60'/0'/0/${index + 2}`).connect(ethers.provider);
  await network.provider.send("hardhat_setBalance", [wallet.address, ethers.toQuantity(ethers.parseEther("100"))]);
  return wallet;
}

async function scenario(sample: number) {
  await network.provider.send("hardhat_reset");
  const [owner, issuer] = await ethers.getSigners();
  const assets = await fixtures();
  const plan = { timelockDelaySeconds: 3600, votingDelayBlocks: 1, votingPeriodBlocks: 50, skillWeightBps: 5000, trustedIssuer: issuer.address, markets: [{ conditionId: ethers.id("bitmap benchmark crypto market"), yesToken: "11", noToken: "12", skillTopic: 2, closesAt: new Date((await time.latest() + 172800) * 1000).toISOString(), uri: "local-bitmap-benchmark" }] };
  const startBlock = await ethers.provider.getBlockNumber();
  const dao = await deployDao(plan, assets, owner);
  await recordSetup(startBlock, sample);
  const deploymentChecks = await verifyDeployment(dao, plan, assets, owner.address);
  const members = await prepareMembers();
  const measurements = await upgradeMembers();
  addSummaries(sample, measurements);
  runs.push({ sample, policyHash: digest("examples/dao-topic-policy.json"), skills: SKILLS, dao: Object.fromEntries(await Promise.all(Object.entries(dao).filter(([key]) => key !== "startBlock").map(async ([key, contract]) => [key, await (contract as any).getAddress()]))), deploymentChecks, memberCount: members.length, assertion: "8 unique skills per member; capped score and aggregate supply checked for every configured topic" });

  async function prepareMembers() {
    const wallets = [];
    for (let index = 0; index < 64; index++) {
      const member = await memberWallet(index);
      await record(await dao.token.connect(member).joinDAO({ value: ethers.parseEther("5") }), sample, "activation", "joinDAO", index + 1);
      await record(await dao.token.connect(member).delegate(member.address), sample, "activation", "delegate", index + 1);
      await record(await dao.skills.connect(member).registerDID(`did:ethr:${member.address}`), sample, "activation", "registerDID", index + 1);
      wallets.push(member);
    }
    return wallets;
  }

  async function upgradeMembers() {
    const measurements = [];
    const scores = await dao.calculator.calculateAllVPFromBitmap(255n);
    for (let index = 0; index < members.length; index++) {
      const member = members[index];
      const vc = { issuer: { id: `did:ethr:${issuer.address}` }, issuanceDate: "2026-10-02", credentialSubject: { id: `did:ethr:${member.address}`, organization: "DAO benchmark", unit: "Research", skills: SKILLS } };
      const signature = await issuer.signTypedData({ name: "Universal VC Protocol", version: "1" }, credentialTypes, vc);
      measurements.push(await record(await dao.skills.connect(member).upgradeSkillWithVC(vc, signature), sample, "credential", "upgradeSkillWithVC", index + 1));
      assert.equal(await dao.skills.memberSkillBitmap(member.address), 255n);
      assert.equal((await dao.skills.getMemberSkills(member.address)).length, 8);
      for (let topic = 0; topic < scores.length; topic++) {
        assert.equal(await dao.skills.getSkillVotes(member.address, topic), scores[topic] * 10n ** 18n / 2n);
        assert.equal(await dao.skills.getTotalSkillSupply(topic), BigInt(index + 1) * scores[topic] * 10n ** 18n / 2n);
      }
    }
    return measurements;
  }
}

async function fixtures() {
  const collateral = await (await ethers.getContractFactory("MockCollateral")).deploy();
  const positions = await (await ethers.getContractFactory("MockPositions")).deploy();
  await Promise.all([collateral.waitForDeployment(), positions.waitForDeployment()]);
  return { collateral: await collateral.getAddress(), positions: await positions.getAddress(), exchange: await collateral.getAddress(), negRiskExchange: await collateral.getAddress() };
}

async function recordSetup(start: number, sample: number) {
  for (let number = start + 1; number <= await ethers.provider.getBlockNumber(); number++) {
    const block = (await ethers.provider.getBlock(number))!;
    for (const hash of block.transactions) await record((await ethers.provider.getTransaction(hash))!, sample, "setup", "deploymentOrConfiguration");
  }
}

function addSummaries(sample: number, gas: bigint[]) {
  for (const count of COUNTS) {
    const total = gas.slice(0, count).reduce((sum, value) => sum + value, 0n);
    summaries.push({ sample, members: count, skills_per_member: 8, cumulative_upgrade_gas: String(total), average_upgrade_gas: Number(total) / count, first_member_gas: String(gas[0]), last_member_gas: String(gas[count - 1]), profile: "original eight certified skills; four nonzero topic scores within the ten-topic DAO catalog" });
  }
}

function aggregated() {
  return COUNTS.map(members => {
    const values = summaries.filter(row => row.members === members).map(row => Number(row.cumulative_upgrade_gas)).sort((a, b) => a - b);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return { members, skills_per_member: 8, samples: values.length, min_gas: values[0], median_gas: values[Math.floor(values.length / 2)], mean_gas: mean, max_gas: values[values.length - 1], stddev_gas: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length), average_gas_per_member: mean / members };
  });
}

function csv(values: any[]) {
  const keys = Object.keys(values[0]);
  const quote = (value: unknown) => JSON.stringify(String(value ?? ""));
  return [keys.join(","), ...values.map(row => keys.map(key => quote(row[key])).join(","))].join("\n") + "\n";
}

async function main() {
  assert.equal(network.name, "hardhat", "Bitmap benchmark is local only");
  mkdirSync(OUT, { recursive: true });
  for (let sample = 1; sample <= 5; sample++) { await scenario(sample); console.log(`Bitmap sample ${sample}/5 complete`); }
  const build = (await artifacts.getBuildInfo("contracts/DaoGovernanceSkill.sol:DaoGovernanceSkill"))!;
  const sources = Object.fromEntries(Object.entries(build.input.sources).map(([name, source]) => [name, createHash("sha256").update(source.content).digest("hex")]));
  const scriptSources = Object.fromEntries(["hardhat.config.ts", "scripts/benchmark-bitmap.ts", "scripts/deployment.ts", "scripts/local.ts", "scripts/topic-policy.ts", "scripts/addresses.ts"].map(path => [path, digest(path)]));
  const manifest = { schemaVersion: 1, timestamp: new Date().toISOString(), command: "npx hardhat run scripts/benchmark-bitmap.ts", environment: "local", chainId: String((await ethers.provider.getNetwork()).chainId), node: process.version, compiler: build.solcLongVersion, compilerSettings: build.input.settings, packageLockHash: digest("package-lock.json"), harnessHash: digest("scripts/benchmark-bitmap.ts"), scriptSources, sources, policy: daoTopicPolicy, policyHash: digest("examples/dao-topic-policy.json"), credentialTypes, counts: COUNTS, skills: SKILLS, repetitions: 5, method: "Each repetition deploys a fresh DAO and prepares 64 members before credentials; each member receives eight new skills in a separate mined transaction; count rows sum the first N upgrades. Activation/setup/principal are excluded from upgrade totals.", liveTransactions: 0 };
  const aggregate = aggregated();
  for (const [name, value] of Object.entries({ manifest, operations: rows, summaries, aggregate, runs })) writeFileSync(`${OUT}/${name}.json`, encode(value) + "\n");
  writeFileSync(`${OUT}/operations.csv`, csv(rows));
  writeFileSync(`${OUT}/aggregate.csv`, csv(aggregate));
  console.log(encode(aggregate));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
