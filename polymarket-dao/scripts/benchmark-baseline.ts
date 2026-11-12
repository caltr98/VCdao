import { ethers, network } from "hardhat";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import type { BaseContract, ContractTransactionResponse, TransactionResponse, Signer } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { deployDao, marketArgs, verifyDeployment, type MarketPlan } from "./deployment";
import { credentialTypes } from "./local";
import { daoTopicPolicy } from "./topic-policy";

// Local gas baseline: SAGE governance against a plain OpenZeppelin Governor, same governed action.
// Each (system, voters) scenario starts from a fresh Hardhat state. Nothing here reaches Polygon.

const OUT = "output/benchmarks-baseline";
const COUNTS = [1, 4, 16, 64];
const SKILLS = daoTopicPolicy.skills.slice(0, 8).map(skill => skill.name);
// benchmark-bitmap.ts schedule (deployment.ts has no defaults), but with 100 voting blocks: automine puts
// one ballot per block, and 64 ballots do not fit in 50. Gas does not depend on these values.
const SCHEDULE = { timelockDelaySeconds: 3600, votingDelayBlocks: 1, votingPeriodBlocks: 100 };
const STAKE = ethers.parseEther("5");
const GAS_PRICE_GWEI = 278.395338579;
const POL_USD = 0.111714935;
const FOR = 1, ABSTAIN = 2;
const ACTIVE = 1n, SUCCEEDED = 4n, EXECUTED = 7n;
// Fixed closing time so both systems govern byte-identical registerMarket arguments.
const CLOSES_AT = "2030-01-01T00:00:00Z";
const BOOTSTRAP = market("baseline benchmark bootstrap market", "11", "12");
const GOVERNED = market("baseline benchmark governed market", "31", "32");
const DESCRIPTION = "Register the benchmark market";
// SAGE's Polymarket contracts: deployDao needs them, the governance comparison does not.
const APPLICATION = ["deploy vault", "deploy mandateHandler", "deploy automation"];
const TARGET = ["deploy registry", "deploy topics"];

type SystemName = "baseline" | "sage";
type Extra = { member?: number; support?: number };
type Receipt = { system: SystemName; voters: number; category: string; operation: string; member: number | null; support: number | null; gas_used: number; block_number: number; transaction_hash: string };
type Action = { targets: string[]; values: bigint[]; calldatas: string[]; hash: string };
type System = {
  governor: any; registry: any;
  log: (category: string, operation: string, transaction: TransactionResponse, extra?: Extra) => Promise<void>;
  join: (member: Signer & { address: string }, number: number) => Promise<void>;
  propose: (member: Signer, action: Action) => Promise<ContractTransactionResponse>;
};
type Builder = (voters: number, owner: HardhatEthersSigner, issuer: HardhatEthersSigner) => Promise<System>;

const receipts: Receipt[] = [];

function market(name: string, yesToken: string, noToken: string): MarketPlan {
  return { conditionId: ethers.id(name), yesToken, noToken, skillTopic: 2, closesAt: CLOSES_AT, uri: "local-baseline-benchmark" };
}

async function record(system: SystemName, voters: number, category: string, operation: string, transaction: TransactionResponse, extra: Extra = {}) {
  const receipt = (await transaction.wait())!;
  assert.equal(receipt.status, 1);
  receipts.push({ system, voters, category, operation, member: extra.member ?? null, support: extra.support ?? null, gas_used: Number(receipt.gasUsed), block_number: receipt.blockNumber, transaction_hash: transaction.hash });
}

// ---------- Deployment ----------

async function ready<T extends BaseContract>(deployment: Promise<T>) {
  const contract = await deployment;
  await contract.waitForDeployment();
  return contract;
}

// Name each setup transaction after the contract it creates or the function it calls.
async function recordSetup(system: SystemName, voters: number, start: number, contracts: Record<string, BaseContract>) {
  const byAddress = new Map<string, [string, BaseContract]>();
  for (const [key, contract] of Object.entries(contracts)) byAddress.set((await contract.getAddress()).toLowerCase(), [key, contract]);
  for (let number = start; number <= await ethers.provider.getBlockNumber(); number++) {
    for (const hash of (await ethers.provider.getBlock(number))!.transactions) {
      const transaction = (await ethers.provider.getTransaction(hash))!;
      const label = await setupLabel(transaction, byAddress);
      await record(system, voters, deploymentCategory(label), label, transaction);
    }
  }
}

async function setupLabel(transaction: TransactionResponse, byAddress: Map<string, [string, BaseContract]>) {
  if (!transaction.to) return `deploy ${byAddress.get((await transaction.wait())!.contractAddress!.toLowerCase())![0]}`;
  const [key, contract] = byAddress.get(transaction.to.toLowerCase())!;
  return `${key}.${contract.interface.parseTransaction({ data: transaction.data })!.name}`;
}

function deploymentCategory(label: string) {
  if (APPLICATION.includes(label)) return "deployment:application";
  return TARGET.includes(label) ? "deployment:target" : "deployment:governance";
}

// ---------- SAGE ----------

const sageSystem: Builder = async (voters, owner, issuer) => {
  const assets = await mockAssets();
  const plan = { ...SCHEDULE, skillWeightBps: 5000, trustedIssuer: issuer.address, markets: [BOOTSTRAP] };
  const { startBlock, ...dao } = await deployDao(plan, assets, owner);
  await recordSetup("sage", voters, startBlock, dao);
  await verifyDeployment(dao, plan, assets, owner.address);
  const log: System["log"] = (category, operation, transaction, extra) => record("sage", voters, category, operation, transaction, extra);
  return { governor: dao.governor, registry: dao.registry, log, join, propose };

  // Members join as in benchmark-bitmap: stake, self-delegation, DID, then eight certified skills.
  async function join(member: Signer & { address: string }, number: number) {
    await log("membership", "joinDAO", await dao.token.connect(member).joinDAO({ value: STAKE }), { member: number });
    await log("membership", "delegate", await dao.token.connect(member).delegate(member.address), { member: number });
    await log("credential", "registerDID", await dao.skills.connect(member).registerDID(`did:ethr:${member.address}`), { member: number });
    const [vc, signature] = await credential(issuer, member.address);
    await log("credential", "upgradeSkillWithVC", await dao.skills.connect(member).upgradeSkillWithVC(vc, signature), { member: number });
  }

  // Every SAGE proposal needs a registered market topic: the bootstrap market provides it.
  function propose(member: Signer, action: Action) {
    return dao.governor.connect(member).proposeWithTopic(action.targets, action.values, action.calldatas, DESCRIPTION, BigInt(BOOTSTRAP.conditionId));
  }
};

async function mockAssets() {
  const collateral = await ready((await ethers.getContractFactory("MockCollateral")).deploy());
  const positions = await ready((await ethers.getContractFactory("MockPositions")).deploy());
  const [collateralAddress, positionsAddress] = [await collateral.getAddress(), await positions.getAddress()];
  return { collateral: collateralAddress, positions: positionsAddress, exchange: collateralAddress, negRiskExchange: collateralAddress };
}

async function credential(issuer: HardhatEthersSigner, member: string) {
  const vc = { issuer: { id: `did:ethr:${issuer.address}` }, issuanceDate: "2026-11-03", credentialSubject: { id: `did:ethr:${member}`, organization: "DAO benchmark", unit: "Research", skills: SKILLS } };
  return [vc, await issuer.signTypedData({ name: "Universal VC Protocol", version: "1" }, credentialTypes, vc)] as const;
}

// ---------- Baseline ----------

const baselineSystem: Builder = async (voters, owner) => {
  const start = await ethers.provider.getBlockNumber() + 1;
  const contracts = await deployBaseline(owner);
  await recordSetup("baseline", voters, start, contracts);
  const log: System["log"] = (category, operation, transaction, extra) => record("baseline", voters, category, operation, transaction, extra);
  return { governor: contracts.governor, registry: contracts.registry, log, join, propose };

  async function join(member: Signer & { address: string }, number: number) {
    await log("membership", "deposit", await contracts.token.connect(member).deposit({ value: STAKE }), { member: number });
    await log("membership", "delegate", await contracts.token.connect(member).delegate(member.address), { member: number });
  }

  function propose(member: Signer, action: Action) {
    return contracts.governor.connect(member).propose(action.targets, action.values, action.calldatas, DESCRIPTION);
  }
};

// Standard OpenZeppelin setup: the Timelock starts with its final delay and open execution;
// the Governor proposes and cancels; the deployer then drops the admin role.
async function deployBaseline(owner: HardhatEthersSigner) {
  const timelock = await ready((await ethers.getContractFactory("TimelockController")).deploy(SCHEDULE.timelockDelaySeconds, [], [ethers.ZeroAddress], owner.address));
  const token = await ready((await ethers.getContractFactory("BaselineToken")).deploy(timelock));
  const governor = await ready((await ethers.getContractFactory("BaselineGovernor")).deploy(token, timelock, SCHEDULE.votingDelayBlocks, SCHEDULE.votingPeriodBlocks));
  const topics = await ready((await ethers.getContractFactory("BaselineSkillTopics")).deploy());
  const registry = await ready((await ethers.getContractFactory("MarketRegistry")).deploy(timelock, topics));
  await handOver(timelock, await governor.getAddress(), owner.address);
  return { timelock, token, governor, topics, registry };
}

async function handOver(timelock: any, governor: string, owner: string) {
  await (await timelock.grantRole(await timelock.PROPOSER_ROLE(), governor)).wait();
  await (await timelock.grantRole(await timelock.CANCELLER_ROLE(), governor)).wait();
  await (await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), owner)).wait();
}

// ---------- Governance lifecycle ----------

async function scenario(name: SystemName, build: Builder, voters: number) {
  await network.provider.send("hardhat_reset");
  const [owner, issuer] = await ethers.getSigners();
  const system = await build(voters, owner, issuer);
  const members = await joinMembers(system, voters);
  const action = await registerMarketAction(system.registry);
  const id = await proposeAction(system, members[0], action);
  await castVotes(system, members, id);
  await closeVote(system.governor, id);
  await queueAndExecute(system, action, id);
  assert.equal(await system.registry.isValidTopic(BigInt(GOVERNED.conditionId)), true, `${name}: market not registered`);
}

async function joinMembers(system: System, voters: number) {
  const members = [];
  for (let index = 0; index < voters; index++) {
    const member = ethers.HDNodeWallet.fromPhrase("test test test test test test test test test test test junk", undefined, `m/44'/60'/0'/0/${index + 2}`).connect(ethers.provider);
    await network.provider.send("hardhat_setBalance", [member.address, ethers.toQuantity(ethers.parseEther("100"))]);
    await system.join(member, index + 1);
    members.push(member);
  }
  return members;
}

async function registerMarketAction(registry: any): Promise<Action> {
  const data = registry.interface.encodeFunctionData("registerMarket", marketArgs(GOVERNED));
  return { targets: [await registry.getAddress()], values: [0n], calldatas: [data], hash: ethers.id(DESCRIPTION) };
}

async function proposeAction(system: System, proposer: Signer, action: Action) {
  await system.log("governance", "propose", await system.propose(proposer, action), { member: 1 });
  return system.governor.hashProposal(action.targets, action.values, action.calldatas, action.hash);
}

// Alternate For and Abstain. For stays at about half of the stake, below SAGE's 70% superquorum, so
// every ballot lands while the proposal is Active; For + Abstain gives the 20% quorum in both systems.
// With one voter the single For ballot reaches the SAGE superquorum, which is still a valid Active vote.
async function castVotes(system: System, members: Signer[], id: bigint) {
  await mine(SCHEDULE.votingDelayBlocks + 1);
  for (let index = 0; index < members.length; index++) {
    assert.equal(await system.governor.state(id), ACTIVE, "Each ballot must land while the proposal is Active");
    const support = index % 2 ? ABSTAIN : FOR;
    await system.log("vote", "castVote", await system.governor.connect(members[index]).castVote(id, support), { member: index + 1, support });
  }
}

// Mine past the deadline so both systems queue from the same Succeeded state.
async function closeVote(governor: any, id: bigint) {
  const deadline = await governor.proposalDeadline(id);
  const now = BigInt(await ethers.provider.getBlockNumber());
  if (now <= deadline) await mine(deadline - now + 1n);
  assert.equal(await governor.state(id), SUCCEEDED);
}

async function queueAndExecute(system: System, action: Action, id: bigint) {
  await system.log("governance", "queue", await system.governor.queue(action.targets, action.values, action.calldatas, action.hash));
  await time.increase(SCHEDULE.timelockDelaySeconds);
  await system.log("governance", "execute", await system.governor.execute(action.targets, action.values, action.calldatas, action.hash));
  assert.equal(await system.governor.state(id), EXECUTED);
}

// ---------- Aggregation and reports ----------

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { samples: sorted.length, median, min: sorted[0], max: sorted[sorted.length - 1], mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length };
}

// Per-scenario sums: deployment by category and the four-step lifecycle with the first ballot.
function scenarioTotals() {
  const totals: { system: SystemName; operation: string; gas: number }[] = [];
  for (const system of ["baseline", "sage"] as SystemName[]) for (const voters of COUNTS) {
    const rows = receipts.filter(row => row.system === system && row.voters === voters);
    const sum = (keep: (row: Receipt) => boolean) => rows.filter(keep).reduce((total, row) => total + row.gas_used, 0);
    for (const category of ["deployment:governance", "deployment:target", "deployment:application"]) totals.push({ system, operation: `total ${category}`, gas: sum(row => row.category === category) });
    totals.push({ system, operation: "total deployment:all", gas: sum(row => row.category.startsWith("deployment")) });
    totals.push({ system, operation: "total lifecycle (propose + first vote + queue + execute)", gas: sum(row => row.category === "governance" || (row.operation === "castVote" && row.member === 1)) });
  }
  return totals;
}

function aggregate() {
  const groups = new Map<string, { system: SystemName; operation: string; voters: string; values: number[] }>();
  const add = (system: SystemName, operation: string, voters: string, gas: number) => {
    const key = `${system}|${operation}|${voters}`;
    if (!groups.has(key)) groups.set(key, { system, operation, voters, values: [] });
    groups.get(key)!.values.push(gas);
  };
  for (const row of receipts) add(row.system, row.operation, "all", row.gas_used);
  for (const row of receipts.filter(row => row.operation === "castVote")) add(row.system, row.operation, String(row.voters), row.gas_used);
  for (const row of receipts.filter(row => row.operation === "castVote" && row.member === 1)) add(row.system, "castVote first ballot", "all", row.gas_used);
  for (const total of scenarioTotals()) add(total.system, total.operation, "all", total.gas);
  return [...groups.values()].map(({ values, ...group }) => ({ ...group, ...stats(values), usd_median: usd(stats(values).median) }));
}

function usd(gas: number) {
  return gas * GAS_PRICE_GWEI * 1e-9 * POL_USD;
}

function csv(values: any[]) {
  const keys = Object.keys(values[0]);
  const quote = (value: unknown) => JSON.stringify(String(value ?? ""));
  return [keys.join(","), ...values.map(row => keys.map(key => quote(row[key])).join(","))].join("\n") + "\n";
}

// Comparison rows: label, baseline operation, SAGE operation, voters group.
const COMPARED: [string, string, string, string][] = [
  ["Membership: deposit / joinDAO", "deposit", "joinDAO", "all"],
  ["Membership: delegate (self)", "delegate", "delegate", "all"],
  ["Propose registerMarket (propose / proposeWithTopic)", "propose", "propose", "all"],
  ["One vote (first ballot, For)", "castVote first ballot", "castVote first ballot", "all"],
  ["Queue", "queue", "queue", "all"],
  ["Execute registerMarket via Timelock", "execute", "execute", "all"],
  ["Lifecycle: propose + one vote + queue + execute", "total lifecycle (propose + first vote + queue + execute)", "total lifecycle (propose + first vote + queue + execute)", "all"],
  ["Deployment: governance core + configuration", "total deployment:governance", "total deployment:governance", "all"],
  ["Deployment: MarketRegistry target (+ baseline topic stub)", "total deployment:target", "total deployment:target", "all"],
  ["Deployment: all transactions (SAGE incl. Polymarket contracts)", "total deployment:all", "total deployment:all", "all"],
];

function markdown(rows: ReturnType<typeof aggregate>) {
  const find = (system: SystemName, operation: string, voters: string) => rows.find(row => row.system === system && row.operation === operation && row.voters === voters)!;
  const number = (value: number) => Math.round(value).toLocaleString("en-US");
  const cell = (row: ReturnType<typeof find>) => row.min === row.max ? number(row.median) : `${number(row.median)} [${number(row.min)}–${number(row.max)}]`;
  const money = (gas: number) => `$${usd(gas).toFixed(6)}`;
  const compare = (label: string, base: ReturnType<typeof find>, sage: ReturnType<typeof find>) =>
    `| ${label} | ${cell(base)} | ${cell(sage)} | ${number(sage.median - base.median)} | ${((sage.median / base.median - 1) * 100).toFixed(1)}% | ${money(base.median)} | ${money(sage.median)} |`;
  const header = "| Operation | Baseline gas | SAGE gas | Difference | SAGE overhead % | Baseline USD | SAGE USD |\n|---|---:|---:|---:|---:|---:|---:|";
  const main = COMPARED.map(([label, base, sage, voters]) => compare(label, find("baseline", base, voters), find("sage", sage, voters)));
  const votes = COUNTS.map(voters => compare(`castVote, N = ${voters} (mean ${number(find("baseline", "castVote", String(voters)).mean)} / ${number(find("sage", "castVote", String(voters)).mean)})`, find("baseline", "castVote", String(voters)), find("sage", "castVote", String(voters))));
  const sageOnly = ["registerDID", "upgradeSkillWithVC"].map(operation => `| ${operation} | ${cell(find("sage", operation, "all"))} | ${money(find("sage", operation, "all").median)} |`);
  return [
    "# SAGE vs plain OpenZeppelin Governor: local gas baseline", "",
    `Command: \`npx hardhat run scripts/benchmark-baseline.ts\` (Hardhat in-process network only). Generated ${new Date().toISOString()}.`, "",
    `Gas cells: median [min–max] over all receipts of that operation; one value when min = max. USD = gas × ${GAS_PRICE_GWEI} gwei × 1e-9 × $${POL_USD}/POL, on the median.`,
    `Scenarios: N = ${COUNTS.join(", ")} voters, each on a fresh Hardhat state per system. Every member deposits 5 POL and self-delegates; SAGE members also register a DID and present an EIP-712 VC with eight skills. Voting delay ${SCHEDULE.votingDelayBlocks} block, period ${SCHEDULE.votingPeriodBlocks} blocks, Timelock delay ${SCHEDULE.timelockDelaySeconds} s, quorum 20%, threshold 0 (SAGE adds a 70% topic superquorum).`,
    "Ballots alternate For/Abstain so that all members can vote before SAGE's superquorum closes the vote (the single-voter scenario reaches it on its only ballot); the proposal is then mined past its deadline, queued and executed. Both systems govern the same `MarketRegistry.registerMarket` call with identical arguments.", "",
    "## Comparison", "", header, ...main, "",
    "## Vote cost by electorate size", "", "Median [min–max] per ballot; means in the label (baseline / SAGE).", "", header, ...votes, "",
    "## SAGE-only operations", "", "| Operation | SAGE gas | SAGE USD |", "|---|---:|---:|", ...sageOnly, "",
    "## Notes on fairness", "",
    "- Baseline governance deployment: TimelockController (final delay set at construction), BaselineToken, BaselineGovernor, two grantRole and one revokeRole.",
    "- SAGE governance deployment: TimelockController, GovernanceToken, DaoSkillCalculator (ten-topic catalog), DaoGovernanceSkill, MarketGovernor, setTreasury, setTrustedIssuer, the bootstrap market registration and updateDelay through the zero-delay Timelock, two grantRole and three revokeRole. MarketGovernor bytecode also carries the Polymarket action validation and redemption reimbursement code.",
    "- `deployment:application` (SAGE only) is OrderVault, SafeMandateHandler and GovernanceAutomation: deployDao needs them because MarketGovernor checks the vault and handler, but no Polymarket operation is measured here.",
    "- SAGE propose includes MarketGovernor action validation and the topic lookup; SAGE vote, queue and execute include the topic quorum/superquorum reads through MarketRegistry and DaoGovernanceSkill. Both tokens are ERC20Votes with ERC20Permit, and both forward deposits to a treasury (SAGE vault, baseline Timelock).",
    "- Checkpoint lookups grow with the number of members, so vote, queue and execute vary slightly with N in both systems. The first For and first Abstain ballot of a proposal write fresh tally slots and cost more than later ballots.",
    "- The baseline MarketRegistry checks domains against a constant ten-topic stub; the SAGE registry calls DaoGovernanceSkill, which reads the calculator. Proposal targets differ only by registry address.", "",
  ].join("\n") + "\n";
}

async function main() {
  assert.equal(network.name, "hardhat", "Baseline benchmark is local only");
  mkdirSync(OUT, { recursive: true });
  for (const voters of COUNTS) {
    await scenario("baseline", baselineSystem, voters);
    await scenario("sage", sageSystem, voters);
    console.log(`Baseline benchmark: N = ${voters} complete`);
  }
  const rows = aggregate();
  writeFileSync(`${OUT}/operations.json`, JSON.stringify(receipts, null, 2) + "\n");
  writeFileSync(`${OUT}/aggregate.csv`, csv(rows));
  writeFileSync(`${OUT}/results.md`, markdown(rows));
  console.log(markdown(rows));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
