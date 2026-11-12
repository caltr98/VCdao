import { ethers, network } from "hardhat";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { POLYGON, COLLATERAL_ADAPTER } from "./addresses";
import { forkPolygon } from "./fork";
import { deployDao, verifyDeployment, type DeploymentPlan } from "./deployment";
import { printJson } from "./polymarket";

// DEPLOYMENT_PLAN selects the plan (default examples/deployment.json). On the in-process network
// this rehearses the deployment on a Polygon fork. `--network polygon` deploys for real and needs
// CONFIRM_POLYGON_DEPLOYER set to the deployer address.
const assets = { collateral: POLYGON.collateral, positions: POLYGON.positions, exchange: POLYGON.exchange, negRiskExchange: POLYGON.negRiskExchange, collateralAdapter: COLLATERAL_ADAPTER };

async function main() {
  const plan = JSON.parse(readFileSync(process.env.DEPLOYMENT_PLAN ?? "examples/deployment.json", "utf8")) as DeploymentPlan;
  const rehearsal = network.name === "hardhat";
  const fork = rehearsal ? await forkPolygon() : undefined;
  fork?.remote.destroy();
  const [deployer] = await ethers.getSigners();
  await confirmLiveTarget(deployer.address, plan, rehearsal);
  const dao = await deployDao(plan, assets, deployer);
  const checks = await verifyDeployment(dao, plan, assets, deployer.address);
  const addresses = Object.fromEntries(await Promise.all(Object.entries(dao).filter(([name]) => name !== "startBlock").map(async ([name, contract]) => [name, await (contract as { getAddress(): Promise<string> }).getAddress()])));
  writeManifest(rehearsal, { network: rehearsal ? "polygon-fork-rehearsal" : "polygon", forkedFrom: fork && { block: fork.block, blockHash: fork.blockHash }, deployedAt: new Date().toISOString(), deployer: deployer.address, startBlock: dao.startBlock, planHash: ethers.id(JSON.stringify(plan)), plan, assets, contracts: addresses, checks, workerConfig: JSON.stringify({ governor: addresses.governor, vault: addresses.vault, automation: addresses.automation, startBlock: dao.startBlock, confirmations: 32 }) });
}

// Placeholders are addresses or IDs made of one repeated hex digit, as in examples/.
function placeholder(value: string) {
  return /^0x(.)\1+$/i.test(value);
}

async function confirmLiveTarget(deployer: string, plan: DeploymentPlan, rehearsal: boolean) {
  if (rehearsal) return;
  if (network.name !== "polygon" || (await ethers.provider.getNetwork()).chainId !== POLYGON.chainId) throw new Error("Live deployment runs only with --network polygon");
  if (process.env.CONFIRM_POLYGON_DEPLOYER?.toLowerCase() !== deployer.toLowerCase()) throw new Error("Set CONFIRM_POLYGON_DEPLOYER to the deployer address to confirm a live deployment");
  if (placeholder(plan.trustedIssuer) || plan.markets.some(market => placeholder(market.conditionId))) throw new Error("Replace the example issuer and markets before a live deployment");
}

// A live manifest is never overwritten; a rehearsal replaces the previous rehearsal.
function writeManifest(rehearsal: boolean, manifest: Record<string, unknown>) {
  mkdirSync("output", { recursive: true });
  const path = rehearsal ? "output/deployment-rehearsal.json" : `output/deployment-polygon-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(manifest, null, 2), { flag: rehearsal ? "w" : "wx" });
  printJson({ manifest: path, ...manifest });
}

main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
