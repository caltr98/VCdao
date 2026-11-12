import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import { POLYGON } from "./addresses";
import { REDEMPTION, ctfAbi } from "./redemption";

// Independent read-only verification, including balances at the blocks around redemption.
async function main() {
  const journal = JSON.parse(readFileSync("output/live-redemption.json", "utf8"));
  if (!journal.completed) throw new Error("Live run is incomplete");
  const result = journal.result, provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  try {
    const receipt = await provider.getTransactionReceipt(result.redeemTx), tx = await provider.getTransaction(result.redeemTx);
    if (!receipt || !tx || receipt.status !== 1) throw new Error("Missing successful mainnet transaction");
    const ctf = new ethers.Contract(POLYGON.positions, ctfAbi, provider);
    const pusd = new ethers.Contract(POLYGON.collateral, ["function balanceOf(address) view returns(uint256)"], provider);
    const transfer = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
    const single = new ethers.Interface(["event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)"]);
    const vaultAbi = new ethers.Interface(["function redeem(uint256 market)", "event PositionRedeemed(uint256 indexed market,address indexed caller,uint256 yesShares,uint256 noShares,uint256 payout)"]);
    const market = result.market, prior = { blockTag: receipt.blockNumber - 1 }, after = { blockTag: receipt.blockNumber };
    // Later authorized recoveries may change current balances; verify this test at its cleanup block.
    const cleanup = { blockTag: journal.transactions.returnPrincipalExecute.receipt.block };
    const balances = {
      before: { pUsd: await pusd.balanceOf(result.vault, prior), yes: await ctf.balanceOf(result.vault, market.yes, prior), no: await ctf.balanceOf(result.vault, market.no, prior), callerPusd: await pusd.balanceOf(tx.from, prior) },
      after: { pUsd: await pusd.balanceOf(result.vault, after), yes: await ctf.balanceOf(result.vault, market.yes, after), no: await ctf.balanceOf(result.vault, market.no, after), callerPusd: await pusd.balanceOf(tx.from, after) },
    };
    const transfers = receipt.logs.filter(log => log.address.toLowerCase() === POLYGON.collateral.toLowerCase()).map(log => { try { const e = transfer.parseLog(log); return e && { from: e.args.from, to: e.args.to, amount: String(e.args.value) }; } catch { return null; } }).filter(Boolean);
    const burns = receipt.logs.filter(log => log.address.toLowerCase() === POLYGON.positions.toLowerCase()).map(log => { try { const e = single.parseLog(log); return e?.args.to === ethers.ZeroAddress ? { from: e.args.from, id: String(e.args.id), amount: String(e.args.value) } : null; } catch { return null; } }).filter(Boolean);
    const event = receipt.logs.filter(log => log.address.toLowerCase() === result.vault.toLowerCase()).map(log => { try { return vaultAbi.parseLog(log); } catch { return null; } }).find(log => log?.name === "PositionRedeemed");
    const checks = {
      correctChain: (await provider.getNetwork()).chainId === 137n,
      directVaultCall: tx.to?.toLowerCase() === result.vault.toLowerCase() && tx.data === vaultAbi.encodeFunctionData("redeem", [BigInt(market.conditionId)]),
      resolvedBeforeRedemption: await ctf.payoutDenominator(market.conditionId, prior) > 0n,
      payoutInVault: balances.before.pUsd === 0n && balances.after.pUsd === REDEMPTION.principal,
      consumedRealHoldings: balances.before.yes === REDEMPTION.principal && balances.before.no === REDEMPTION.principal && balances.after.yes === 0n && balances.after.no === 0n,
      callerUnpaid: balances.before.callerPusd === balances.after.callerPusd,
      pUsdTransferToVault: transfers.some(t => t !== null && t.to.toLowerCase() === result.vault.toLowerCase() && t.amount === String(REDEMPTION.principal)),
      bothOutcomesBurned: [market.yes, market.no].every(id => burns.some(b => b !== null && b.id === id && b.amount === String(REDEMPTION.principal) && b.from.toLowerCase() === REDEMPTION.adapter.toLowerCase())),
      approvalClearedAtRedemption: !await ctf.isApprovedForAll(result.vault, REDEMPTION.adapter, after),
      eventMatches: event?.args.market === BigInt(market.conditionId) && event.args.caller === tx.from && event.args.payout === REDEMPTION.principal,
      principalRecovered: await pusd.balanceOf(REDEMPTION.safe, cleanup) === BigInt(journal.before.safePusd) && await pusd.balanceOf(result.vault, cleanup) === 0n,
      originalPositionUnchanged: await ctf.balanceOf(REDEMPTION.oldVault, REDEMPTION.oldToken, cleanup) === BigInt(journal.before.oldShares) && await pusd.balanceOf(REDEMPTION.oldVault, cleanup) === BigInt(journal.before.oldPusd),
    };
    if (Object.values(checks).some(passed => !passed)) throw new Error("Independent live verification failed");
    const report = { verifiedAtBlock: await provider.getBlockNumber(), receiptBlock: receipt.blockNumber, confirmations: await receipt.confirmations(), transaction: result.redeemTx, vault: result.vault, caller: tx.from, balances, transfers, burns, checks };
    const text = JSON.stringify(report, (_, value) => typeof value === "bigint" ? String(value) : value, 2) + "\n";
    writeFileSync("output/live-redemption-verification.json", text);
    console.log(text);
  } finally { provider.destroy(); }
}
main().catch((error: any) => { console.error("Read-only redemption verification failed:", error.code ?? (String(error.message).includes("http") ? "provider details suppressed" : error.message)); process.exitCode = 1; });
