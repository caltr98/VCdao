import { ethers, network } from "hardhat";
import { readFileSync } from "node:fs";
import { artifactHashes, runDaoRedemption, type DaoRedemptionPlan } from "./dao-redemption";
import { json, openJournal, RedemptionSigner } from "./redemption-journal";
import { REDEMPTION } from "./redemption";
import { POLYGON } from "./addresses";
import { erc20 } from "./safe-fork";

// A new, separate journal. Historical redemption and recovery journals are never reused.
async function main() {
  const proposal = JSON.parse(readFileSync("output/dao-funded-redemption-live-plan.json", "utf8")) as { planHash: string; plan: DaoRedemptionPlan };
  const { plan, planHash } = proposal;
  if (network.name !== "polygon" || process.env.CONFIRM_DAO_REDEMPTION_PLAN !== planHash || ethers.id(json(plan)) !== planHash) throw new Error("Human approval of this exact paid deployment and funding plan is required");
  if (JSON.stringify(await artifactHashes()) !== JSON.stringify(plan.artifactHashes)) throw new Error("Contract artifacts differ from the approved fork rehearsal");
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, ethers.provider);
  if (wallet.address !== REDEMPTION.owner || (await ethers.provider.getNetwork()).chainId !== 137n) throw new Error("Wrong mainnet signer or network");
  const { state, save } = openJournal("output/live-dao-funded-redemption.json", planHash);
  if (state.completed) { console.log(json(state.result)); return; }
  if (!Object.keys(state.transactions).length) await preflight();
  const signer = new RedemptionSigner(wallet, state, save, true, BigInt(plan.gasPriceCap), BigInt(plan.totalGasBudget));
  const result = await runDaoRedemption(plan, signer);
  state.result = { ...result, totalNetworkFee: Object.values(state.transactions).reduce((sum, entry) => sum + BigInt(entry.receipt!.fee), 0n).toString(), planHash };
  state.completed = true;
  save();
  console.log(json(state.result));

  async function preflight() {
    const cutoff = Math.floor(Date.parse(plan.deployment.markets[0].closesAt) / 1000);
    if (cutoff <= (await ethers.provider.getBlock("latest"))!.timestamp + 300) throw new Error("Approved market registration cutoff expired; prepare a new plan before deployment");
    const pusd = new ethers.Contract(POLYGON.collateral, erc20, ethers.provider);
    if (await pusd.balanceOf(REDEMPTION.safe) < BigInt(plan.principal)) throw new Error("Insufficient principal in the approved funding Safe");
    if (await ethers.provider.getBalance(wallet.address) < BigInt(plan.totalGasBudget) + BigInt(plan.membershipDeposit) + BigInt(plan.gasAllocation)) throw new Error("Insufficient balance for approved maximum cost and treasury funding");
  }
}

main().catch(error => { console.error("Live DAO redemption stopped; inspect the saved journal:", error.code ?? (String(error.message).includes("http") ? "provider diagnostics suppressed" : error.message)); process.exitCode = 1; });
