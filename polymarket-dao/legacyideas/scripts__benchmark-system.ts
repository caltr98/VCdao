import { ethers, network, artifacts } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { deployDao, verifyDeployment } from "./deployment";
import { issueSkill } from "./local";
import { forkPolygon } from "./fork";
import { POLYGON, COLLATERAL_ADAPTER } from "./addresses";
import { redemptionMarket, verifyRedemptionAssets, adapterAbi, ctfAbi, REDEMPTION } from "./redemption";

const OUT = "output/benchmarks-system";
const WALLET = "0x92DC8012d9C27703d9EBE7a3EdD1037eE8ac4f2a";
const walletAbi = ["function owner() view returns(address)", "function factory() view returns(address)", "function nonce() view returns(uint256)", "function execute((address wallet,uint256 nonce,uint256 deadline,(address target,uint256 value,bytes data)[] calls),bytes)"];
const stringify = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? String(v) : v, 2);
const hashFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const rows: any[] = [], runs: any[] = [];
let forkBlock = 0, sourceDigest = "", invocation = new Date().toISOString().replace(/[:.]/g, "-");

async function impersonate(address: string) {
  await network.provider.send("hardhat_impersonateAccount", [address]);
  await network.provider.send("hardhat_setBalance", [address, ethers.toBeHex(ethers.parseEther("100"))]);
  return ethers.getSigner(address);
}

async function signBatch(batch: unknown) {
  const result = spawnSync(".venv/Scripts/python.exe", ["scripts/benchmark-wallet-sign.py"], { input: stringify(batch), encoding: "utf8" });
  assert.equal(result.status, 0, "Official SDK offline signing failed; diagnostics suppressed");
  return result.stdout.trim();
}

async function batchCall(wallet: any, factory: any, calls: any[], runId: string, label: string) {
  const batch = { wallet: WALLET, nonce: await wallet.nonce(), deadline: (await time.latest()) + 600, calls };
  const signature = await signBatch(batch);
  appendFileSync(`${OUT}/${invocation}-signed-batches.jsonl`, stringify({ run_id: runId, label, batch, signature }).replace(/\n\s*/g, "") + "\n");
  return (await wallet.connect(factory).getFunction("execute")(batch, signature)).wait();
}

async function recordRange(start: number, stage: string, run: any, interfaces: any[], addresses: Map<string, string>) {
  const end = await ethers.provider.getBlockNumber();
  for (let block = start + 1; block <= end; block++) {
    const value = await ethers.provider.getBlock(block);
    for (const txhash of value!.transactions) await recordTransaction(txhash, stage, run, interfaces, addresses);
  }
}

async function recordTransaction(txhash: string, stage: string, run: any, interfaces: any[], addresses: Map<string, string>) {
  const tx = (await ethers.provider.getTransaction(txhash))!, receipt = (await tx.wait())!;
  let name = tx.to ? addresses.get(tx.to.toLowerCase()) ?? "external" : "deployment", operation = "unknown";
  if (!tx.to) { const artifact = interfaces.find(a => tx.data.startsWith(a.bytecode) && a.bytecode !== "0x"); name = artifact?.contractName ?? name; operation = `deploy.${name}`; addresses.set(receipt.contractAddress!.toLowerCase(), name); }
  else { for (const a of interfaces) { try { const decoded = new ethers.Interface(a.abi).parseTransaction(tx); if (decoded) { operation = decoded.name; break; } } catch {} } }
  const essential = !["fixture", "resolution", "diagnostic"].includes(stage);
  const row = { schema_version: "1.0", run_id: run.run_id, scenario_id: run.scenario_id, sample_id: run.sample_id, environment: "Polygon fork (in-process)", chain_id: "137", fork_block: forkBlock, source_digest: sourceDigest, contract_name: name, contract_address: tx.to ?? receipt.contractAddress, stage, operation_id: `${stage}.${operation}`, operation, actor: tx.from, payer: tx.from, sponsorship: stage === "delivery" || stage === "redemption" ? "simulated factory payer; no relayer API" : "unsponsored local execution", transaction_hash: txhash, receipt_status: receipt.status, block_number: receipt.blockNumber, gas_used: String(receipt.gasUsed), effective_gas_price_wei: String(receipt.gasPrice), fee_wei: String(receipt.gasUsed * receipt.gasPrice), fee_native: ethers.formatEther(receipt.gasUsed * receipt.gasPrice), native_token: "POL (fork fee, no mainnet spend)", batch_id: operation === "execute" ? txhash : null, measurement_method: "transaction receipt; entire batch", simulation_scope: run.simulation_scope, principal_units: tx.value ? String(tx.value) : null, trading_fee_units: null, collateral_token: run.collateral, collateral_decimals: 6, elapsed_seconds: null, included_in_essential_path: essential, notes: stage === "setup" && ["SafeMandateHandler", "GovernanceAutomation"].includes(name) ? "shared deployment overhead; unused in this route" : "No internal gas allocation" };
  rows.push(row);
  appendFileSync(`${OUT}/${invocation}-operations.jsonl`, stringify(row).replace(/\n\s*/g, "") + "\n");
}

async function scenario(real: boolean, sample: number, loser: boolean, interfaces: any[]) {
  const run: any = { run_id: `${invocation}-${real ? "real" : loser ? "loser" : "winner"}-${sample}`, scenario_id: real ? "real-resolved-preparation" : loser ? "mock-loser" : "mock-winner", sample_id: sample, simulation_scope: real ? "Real resolved CTF/adapter/wallet; impersonated funding/factory; complete-set acquisition; no CLOB" : "Mock assets/acquisition/resolution; deployed real signed Deposit Wallet; impersonated factory; no CLOB" };
  const addresses = new Map<string, string>([[WALLET.toLowerCase(), "DepositWallet"]]);
  const phase = async (stage: string, action: () => Promise<any>) => { const start = await ethers.provider.getBlockNumber(); const result = await action(); await recordRange(start, stage, run, interfaces, addresses); return result; };
  const [owner, issuer, ...signers] = await ethers.getSigners(), members = signers.slice(0, 10), seller = signers[11];
  const wallet = new ethers.Contract(WALLET, walletAbi, owner), factory = await impersonate(await wallet.factory());
  assert.equal((await wallet.owner()).toLowerCase(), "0xdc9311c53d3d1cb1d9ed87b9028fb35c2168629d");
  const market = redemptionMarket(), condition = market.conditionId;
  let collateral: any, positions: any, adapter: any, ids: bigint[];
  await phase("fixture", async () => {
    if (real) { ({ adapter, ctf: positions } = await verifyRedemptionAssets(market)); collateral = new ethers.Contract(POLYGON.collateral, ["function balanceOf(address) view returns(uint256)", "function transfer(address,uint256) returns(bool)", "function approve(address,uint256) returns(bool)"], owner); ids = [BigInt(market.yes), BigInt(market.no)]; }
    else { collateral = await (await ethers.getContractFactory("MockCollateral")).deploy(); positions = await (await ethers.getContractFactory("MockResolvedPositions")).deploy(); adapter = await (await ethers.getContractFactory("MockRedemptionAdapter")).deploy(collateral, positions); await positions.prepare(condition, 2); ids = await Promise.all([1, 2].map(async i => positions.getPositionId(collateral, await positions.getCollectionId(ethers.ZeroHash, condition, i)))); }
  });
  run.collateral = await collateral.getAddress();
  addresses.set(run.collateral.toLowerCase(), real ? "pUSD" : "MockCollateral"); addresses.set((await positions.getAddress()).toLowerCase(), real ? "CTF" : "MockResolvedPositions");
  const startTime = await time.latest(), closesAt = startTime + 172800;
  const plan = { timelockDelaySeconds: 3600, votingDelayBlocks: 1, votingPeriodBlocks: 50, skillWeightBps: 5000, trustedIssuer: issuer.address, markets: [{ conditionId: condition, yesToken: String(ids![0]), noToken: String(ids![1]), skillTopic: 2, closesAt: new Date(closesAt * 1000).toISOString(), uri: `https://polymarket.com/market/${market.slug}` }] };
  const assets = { collateral: run.collateral, positions: await positions.getAddress(), exchange: real ? POLYGON.exchange : await adapter.getAddress(), negRiskExchange: real ? POLYGON.negRiskExchange : await adapter.getAddress(), collateralAdapter: await adapter.getAddress() };
  const dao = await phase("setup", () => deployDao(plan, assets, owner));
  const deploymentChecks = await verifyDeployment(dao, plan, assets, owner.address), vaultAddress = await dao.vault.getAddress();
  const vault = await ethers.getContractAt("RedeemableOrderVault", vaultAddress);
  for (const [name, value] of Object.entries(dao)) if (typeof value === "object" && value && "getAddress" in value) addresses.set((await (value as any).getAddress()).toLowerCase(), name);
  const solverBefore = await collateral.balanceOf(WALLET), sharesBefore = await positions.balanceOf(WALLET, ids![0]);
  const shares = 100_000n, acquisition = real ? shares : 25_000n, cap = real ? 110_000n : 32_500n, funding = 200_000n;
  await phase("funding", async () => { if (real) { const holder = await impersonate(REDEMPTION.safe); await (await collateral.connect(holder).getFunction("transfer")(vaultAddress, funding)).wait(); await (await collateral.connect(holder).getFunction("transfer")(WALLET, acquisition)).wait(); } else { await collateral.mint(vaultAddress, funding); await collateral.mint(WALLET, acquisition); } });
  await phase("membership", async () => { for (const member of members) await (await dao.token.connect(member).joinDAO({ value: ethers.parseEther("5") })).wait(); for (const member of members) await (await dao.token.connect(member).delegate(member.address)).wait(); for (const member of members) await issueSkill(dao.skills, issuer, member, ["cyberSecurity", "cloudArchitecture"]); });
  const id = ethers.id(run.run_id), deadline = (await time.latest()) + 86400, buy = { market: BigInt(condition), tokenId: ids![0], shares, payment: cap, deadline, executor: ethers.ZeroAddress };
  const targets = [vaultAddress], values = [0], data = [vault.interface.encodeFunctionData("authorizeBuy", [id, buy])], description = "Benchmark approved purchase", descriptionHash = ethers.id(description);
  await phase("governance", async () => {
    await dao.governor.connect(members[0]).proposeWithTopic(targets, values, data, description, BigInt(condition));
    const proposalId = await dao.governor.hashProposal(targets, values, data, descriptionHash); await mine(2);
    const snapshot = await dao.governor.proposalSnapshot(proposalId); let expectedFor = 0n;
    for (let i = 0; i < members.length; i++) { assert.equal(await dao.governor.state(proposalId), 1n); if (i < 6) expectedFor += await dao.token.getPastVotes(members[i].address, snapshot) + await dao.registry.getPastSkillVotes(members[i].address, BigInt(condition), snapshot); await dao.governor.connect(members[i]).castVote(proposalId, i < 6 ? 1 : 0); }
    assert.equal((await dao.governor.proposalVotes(proposalId)).forVotes, expectedFor); await mine(51); await dao.governor.queue(targets, values, data, descriptionHash); await time.increase(3600); await dao.governor.execute(targets, values, data, descriptionHash); assert.equal(await dao.governor.state(proposalId), 7n); run.proposal_id = String(proposalId);
  });
  assert.equal(await vault.reserved(), cap); assert.equal(await vault.status(id), 1n);
  const ctf = new ethers.Interface([...ctfAbi, "function safeTransferFrom(address,address,uint256,uint256,bytes)"]);
  await phase("acquisition", async () => {
    if (real) await batchCall(wallet, factory, [{ target: run.collateral, value: 0, data: collateral.interface.encodeFunctionData("approve", [assets.collateralAdapter, shares]) }, { target: assets.collateralAdapter, value: 0, data: new ethers.Interface(adapterAbi).encodeFunctionData("splitPosition", [run.collateral, ethers.ZeroHash, condition, [1, 2], shares]) }, { target: run.collateral, value: 0, data: collateral.interface.encodeFunctionData("approve", [assets.collateralAdapter, 0]) }], run.run_id, "complete-set preparation");
    else { await positions.mint(WALLET, ids![0], shares); await batchCall(wallet, factory, [{ target: run.collateral, value: 0, data: collateral.interface.encodeFunctionData("transfer", [seller.address, acquisition]) }], run.run_id, "simulated acquisition payment"); }
  });
  const authorizedAt = await vault.authorizedAt(id), deliveryTime = Number(authorizedAt + (BigInt(deadline) - authorizedAt) * 96n / 100n);
  await time.setNextBlockTimestamp(deliveryTime);
  const paid = cap * (BigInt(deliveryTime) - authorizedAt) / (BigInt(deadline) - authorizedAt);
  const auditData = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32", "bytes32"], [id, ethers.id("simulated settlement"), ethers.id(run.run_id + " order")]);
  assert.equal(ethers.dataLength(auditData), 96); assert.ok(paid > acquisition && paid < cap);
  const beforePush = await collateral.balanceOf(WALLET);
  await phase("delivery", () => batchCall(wallet, factory, [{ target: awaitAddress(positions), value: 0, data: ctf.encodeFunctionData("safeTransferFrom", [WALLET, vaultAddress, ids![0], shares, auditData]) }], run.run_id, "paid push"));
  assert.equal(await collateral.balanceOf(WALLET) - beforePush, paid); assert.equal(await positions.balanceOf(vaultAddress, ids![0]), shares); assert.equal(await vault.status(id), 2n); assert.equal(await vault.reserved(), 0n);
  if (!real) await phase("resolution", async () => { await positions.resolve(condition, loser ? 0 : 1, loser ? 1 : 0); });
  const beforeRedeem = await collateral.balanceOf(vaultAddress), beforeCaller = await collateral.balanceOf(WALLET);
  await phase("redemption", () => batchCall(wallet, factory, [{ target: vaultAddress, value: 0, data: vault.interface.encodeFunctionData("redeem", [BigInt(condition)]) }], run.run_id, "permissionless redemption"));
  const payout = loser ? 0n : shares;
  assert.equal(await collateral.balanceOf(vaultAddress) - beforeRedeem, payout); assert.equal(await collateral.balanceOf(WALLET), beforeCaller); assert.equal(await positions.balanceOf(vaultAddress, ids![0]), 0n); assert.equal(await positions.balanceOf(vaultAddress, ids![1]), 0n); assert.equal(await positions.isApprovedForAll(vaultAddress, assets.collateralAdapter), false); assert.equal(await vault.reserved(), 0n); assert.equal(await collateral.balanceOf(vaultAddress), funding - paid + payout); assert.equal(await collateral.balanceOf(WALLET), solverBefore + paid); assert.equal(await positions.balanceOf(WALLET, ids![0]), sharesBefore);
  Object.assign(run, { vault: vaultAddress, authorization_id: id, condition, ids: ids!.map(String), deploymentChecks, checks: { snapshotVotes: true, paidPush: true, exactAuctionPrice: true, profitableDelivery: true, consumedVaultShares: true, directDaoPayout: true, zeroCallerPayout: true, approvalCleared: true, reservationsPreserved: true, collateralConservation: true }, acquisition_units: String(acquisition), payment_units: String(paid), payout_units: String(payout), trading_fee_units: "0", trading_fee_scope: "simulation assumption; not measured CLOB fee", stake_native_wei: String(ethers.parseEther("50")), waiting_seconds: (await time.latest()) - startTime, remainingSolverNoShares: real ? String(shares) : "0" });
  runs.push(run); writeFileSync(`${OUT}/${run.run_id}.json`, stringify(run)); console.log(`Completed ${run.scenario_id} sample ${sample}`);
}

function awaitAddress(contract: any): string { return String(contract.target); }

async function main() {
  assert.equal(network.name, "hardhat", "Benchmark never broadcasts to a live network"); mkdirSync(OUT, { recursive: true });
  if (!process.env.POLYGON_RPC_URL) { const lines = readFileSync("C:/Users/iperc/polymarket-dao-secrets.md", "utf8").split(/\r?\n/); process.env.POLYGON_RPC_URL = lines.map(line => line.split("|")).find(p => p.length === 4 && p[1].trim() === "Polygon RPC (Alchemy)")![2].trim().replace(/`/g, ""); }
  const names = await artifacts.getAllFullyQualifiedNames(), interfaces = await Promise.all(names.map(name => artifacts.readArtifact(name)));
  sourceDigest = hashFile("package-lock.json"); const fork = await forkPolygon(); forkBlock = fork.block;
  try { for (const loser of [false, true]) for (let sample = 1; sample <= 5; sample++) { const snapshot = await network.provider.send("evm_snapshot"); await scenario(false, sample, loser, interfaces); await network.provider.send("evm_revert", [snapshot]); } await scenario(true, 1, false, interfaces); }
  finally { fork.remote.destroy(); writeFileSync(`${OUT}/operations.json`, stringify(rows)); writeFileSync(`${OUT}/runs.json`, stringify(runs)); writeFileSync(`${OUT}/execution-manifest.json`, stringify({ invocation, forkBlock, forkHash: fork.blockHash, timestamp: fork.timestamp, compiler: "0.8.28", optimizer: { enabled: true, runs: 200 }, evm: "cancun", chainId: "137", node: process.version, packageLockSha256: sourceDigest, scenarios: runs.map(r => r.scenario_id), liveTransactions: 0 })); }
}
main().catch(error => { console.error("Benchmark failed:", error.code === "ERR_ASSERTION" ? error.message : error.reason ?? error.code ?? "diagnostics suppressed"); process.exitCode = 1; });
