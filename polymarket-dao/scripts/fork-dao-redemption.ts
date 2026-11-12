import { ethers } from "hardhat";
import { impersonateAccount } from "@nomicfoundation/hardhat-network-helpers";
import { writeFileSync } from "node:fs";
import { forkPolygon } from "./fork";
import { artifactHashes, runDaoRedemption, type DaoRedemptionPlan } from "./dao-redemption";
import { REDEMPTION, redemptionMarket } from "./redemption";
import { json, RedemptionSigner, type RedemptionJournal } from "./redemption-journal";
import { verifyDaoRedemption } from "./verify-dao-redemption";

async function main() {
  const fork = await forkPolygon();
  try {
    const market = redemptionMarket(), fees = await fork.remote.getFeeData();
    const price = [fees.gasPrice ?? 0n, fees.maxPriorityFeePerGas ?? 0n].reduce((a, b) => a > b ? a : b);
    if (price === 0n || price * 3n / 2n > ethers.parseUnits("10000", "gwei")) throw new Error("No acceptable Polygon fee estimate");
    const plan: DaoRedemptionPlan = {
      deployment: { timelockDelaySeconds: 30, votingDelayBlocks: 1, votingPeriodBlocks: 5, skillWeightBps: 5000, trustedIssuer: REDEMPTION.owner, markets: [{ conditionId: market.conditionId, yesToken: market.yes, noToken: market.no, skillTopic: 2, closesAt: new Date((fork.timestamp + 7 * 86400) * 1000).toISOString(), uri: `https://polymarket.com/market/${market.slug}` }] },
      market, principal: String(REDEMPTION.principal), membershipDeposit: String(ethers.parseEther("0.1")), gasAllocation: String(ethers.parseEther("0.5")), maxRefund: String(ethers.parseEther("0.5")), gasPriceCap: String(price * 3n / 2n), gasUnitsCap: 1_200_000, overhead: 100_000, totalGasBudget: String(ethers.parseEther("100")), artifactHashes: await artifactHashes(),
    };
    await impersonateAccount(REDEMPTION.owner);
    const state: RedemptionJournal = { planHash: ethers.id(json(plan)), snapshots: {}, transactions: {} };
    const signer = new RedemptionSigner(await ethers.getSigner(REDEMPTION.owner), state, () => {}, false, BigInt(plan.gasPriceCap), BigInt(plan.totalGasBudget), price);
    const result = await runDaoRedemption(plan, signer);
    const nonce = await signer.getNonce();
    const resumedSigner = new RedemptionSigner(await ethers.getSigner(REDEMPTION.owner), state, () => {}, false, BigInt(plan.gasPriceCap), BigInt(plan.totalGasBudget), price);
    await runDaoRedemption(plan, resumedSigner);
    const fullScenarioResumeNoBroadcast = await resumedSigner.getNonce() === nonce;
    if (!fullScenarioResumeNoBroadcast) throw new Error("Resumed scenario sent a duplicate transaction");
    const independentVerification = await verifyDaoRedemption(result, state);
    const entries = Object.values(state.transactions), gasUsed = entries.reduce((sum, entry) => sum + BigInt(entry.receipt!.gasUsed), 0n), gasLimit = entries.reduce((sum, entry) => sum + BigInt(entry.gasLimit), 0n);
    const networkFee = entries.reduce((sum, entry) => sum + BigInt(entry.receipt!.fee), 0n), worstCase = gasLimit * BigInt(plan.gasPriceCap);
    plan.totalGasBudget = String(worstCase * 11n / 10n);
    const proposal = { planHash: ethers.id(json(plan)), plan, estimate: { transactions: entries.length, gasUsed: String(gasUsed), summedGasLimits: String(gasLimit), snapshotGasPrice: String(price), gasPriceCeiling: plan.gasPriceCap, feesAtSnapshotPrice: String(gasUsed * price), forkNetworkFee: String(networkFee), worstCaseNetworkFee: String(worstCase), approvalNetworkFeeLimit: plan.totalGasBudget, initialNativeFunding: String(BigInt(plan.membershipDeposit) + BigInt(plan.gasAllocation)), principalPusd: "0.1", fundingSources: { gasAndNativeAllocation: REDEMPTION.owner, principal: REDEMPTION.safe }, deployments: Object.keys(plan.artifactHashes) } };
    const report = { forkBlock: fork.block, forkHash: fork.blockHash, ...result, fullScenarioResumeNoBroadcast, independentVerification, estimate: proposal.estimate, transactions: state.transactions };
    writeFileSync("output/fork-dao-funded-redemption.json", json(report));
    writeFileSync("output/dao-funded-redemption-live-plan.json", json(proposal));
    console.log(json({ forkBlock: fork.block, payout: result.payout, refund: result.refund, checks: result.checks, preservation: result.preservation, estimate: proposal.estimate, planHash: proposal.planHash }));
  } finally { fork.remote.destroy(); }
}

main().catch(error => { console.error("DAO redemption fork failed:", error.code ?? (String(error.message).includes("http") ? "provider diagnostics suppressed" : error.message)); process.exitCode = 1; });
