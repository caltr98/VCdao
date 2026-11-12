import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import { POLYGON } from "./addresses";
import { REDEMPTION, ctfAbi } from "./redemption";
import { erc20 } from "./safe-fork";
import { json, type RedemptionJournal } from "./redemption-journal";
import type { runDaoRedemption } from "./dao-redemption";

type Result = Awaited<ReturnType<typeof runDaoRedemption>>;

/// Independent read-only receipt and historical balance verification; no signer is constructed.
export async function verifyDaoRedemption(result: Result, journal: RedemptionJournal) {
  const receipt = await ethers.provider.getTransactionReceipt(result.refund.transaction), tx = await ethers.provider.getTransaction(result.refund.transaction);
  if (!receipt || !tx || receipt.status !== 1) throw new Error("Missing successful redemption receipt");
  const vault = await ethers.getContractAt("RedeemableOrderVault", result.contracts.vault), governor = await ethers.getContractAt("MarketGovernor", result.contracts.governor);
  const pusd = new ethers.Contract(POLYGON.collateral, erc20, ethers.provider), ctf = new ethers.Contract(POLYGON.positions, ctfAbi, ethers.provider);
  const logs = receipt.logs.filter(log => log.address.toLowerCase() === result.contracts.vault.toLowerCase()).map(log => { try { return vault.interface.parseLog(log); } catch { return null; } });
  const refunds = logs.filter(log => log?.name === "RedemptionRefund"), payouts = logs.filter(log => log?.name === "PositionRedeemed");
  if (refunds.length !== 1 || payouts.length !== 1) throw new Error("Expected one redemption and one refund event");
  const refund = refunds[0]!, payout = payouts[0]!, post = { blockTag: receipt.blockNumber }, pre = { blockTag: receipt.blockNumber - 1 };
  const parsed = governor.interface.parseTransaction(tx), market = payout.args.market;
  if (parsed?.name !== "execute") throw new Error("Receipt did not execute through the Governor");
  const args = parsed.args, proposalId = await governor.hashProposal([...args[0]], [...args[1]], [...args[2]], args[3]);
  const price = receipt.gasPrice < await vault.maxRedemptionGasPrice(pre) ? receipt.gasPrice : await vault.maxRedemptionGasPrice(pre);
  const expected = [BigInt(refund.args.gasUnits) * price, await vault.maxRedemptionRefund(pre), await vault.redemptionGasBudget(pre)].reduce((a, b) => a < b ? a : b);
  const registry = await ethers.getContractAt("MarketRegistry", await vault.registry()), registered = await registry.markets(market, post);
  const checks = {
    exactGovernorAction: tx.to === result.contracts.governor && tx.value === 0n && args[0].length === 1 && args[0][0] === result.contracts.vault && args[1][0] === 0n && args[2][0] === vault.interface.encodeFunctionData("redeem", [market]),
    executedMarketProposal: proposalId === refund.args.proposal && await governor.state(proposalId, post) === 7n && await governor.proposalTopic(proposalId, post) === market && refund.args.market === market,
    onlyTimelockRedeemed: payout.args.caller === result.contracts.timelock,
    callerReceivesRefund: refund.args.caller === tx.from && tx.from === REDEMPTION.owner && refund.args.delivered,
    exactRecordedRefund: String(refund.args.amount) === result.refund.amount && String(refund.args.proposal) === result.refund.proposal,
    cappedPayment: refund.args.amount === expected && refund.args.amount > 0n && refund.args.gasPrice === price && refund.args.gasUnits <= await vault.maxRedemptionGasUnits(pre),
    vaultPayout: payout.args.payout === BigInt(result.payout) && BigInt(await pusd.balanceOf(vault, post)) - BigInt(await pusd.balanceOf(vault, pre)) === BigInt(result.payout),
    realResolution: await ctf.payoutDenominator(ethers.toBeHex(market, 32), post) > 0n,
    sharesConsumed: await ctf.balanceOf(vault, registered.yesToken, post) === 0n && await ctf.balanceOf(vault, registered.noToken, post) === 0n && await ctf.balanceOf(vault, registered.yesToken, pre) === payout.args.yesShares && await ctf.balanceOf(vault, registered.noToken, pre) === payout.args.noShares,
    approvalCleared: !await ctf.isApprovedForAll(vault, REDEMPTION.adapter, post),
    treasuryPaidExactly: await ethers.provider.getBalance(vault, pre.blockTag) - await ethers.provider.getBalance(vault, post.blockTag) === refund.args.amount,
    allocationPaidExactly: await vault.redemptionGasBudget(pre) - await vault.redemptionGasBudget(post) === refund.args.amount,
    callerBalanceMatchesFeeAndRefund: await ethers.provider.getBalance(tx.from, post.blockTag) === await ethers.provider.getBalance(tx.from, pre.blockTag) - receipt.fee + refund.args.amount,
    reservationsPreserved: await vault.reserved(pre) === await vault.reserved(post),
    noUnpaidLiability: await vault.refundLiability(post) === 0n,
    refundedOnce: await vault.redemptionRefunded(proposalId, post),
  };
  const entries = Object.values(journal.transactions), receipts = await Promise.all(entries.map(entry => ethers.provider.getTransactionReceipt(entry.hash)));
  const signedEntries = entries.filter(entry => entry.raw);
  const journalChecks = {
    allTransactionsSuccessful: receipts.every(found => found?.status === 1),
    redemptionJournaled: entries.some(entry => entry.hash === receipt.hash),
    signedBytesMatchHashesAndSigner: signedEntries.every(entry => { const signed = ethers.Transaction.from(entry.raw!); return signed.hash === entry.hash && signed.from === REDEMPTION.owner && signed.chainId === 137n; }),
    liveEntriesAllSigned: result.environment !== "Polygon mainnet" || signedEntries.length === entries.length,
  };
  const failed = Object.entries({ ...checks, ...journalChecks }).filter(([, passed]) => !passed).map(([name]) => name);
  if (failed.length) throw new Error(`Independent DAO redemption verification failed: ${failed.join(", ")}`);
  return { redemptionTransaction: receipt.hash, receiptBlock: receipt.blockNumber, confirmations: await ethers.provider.getBlockNumber() - receipt.blockNumber + 1, checks, journalChecks };
}

async function main() {
  const state = JSON.parse(readFileSync("output/live-dao-funded-redemption.json", "utf8")) as RedemptionJournal;
  if (!state.completed || !state.result) throw new Error("Complete the approved live journal before verification");
  const report = await verifyDaoRedemption(state.result as Result, state);
  writeFileSync("output/live-dao-funded-redemption-verification.json", json(report));
  console.log(json(report));
}

if (require.main === module) main().catch(() => { console.error("Independent DAO redemption verification failed; provider diagnostics suppressed"); process.exitCode = 1; });
