import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import { POLYGON } from "./addresses";
import { ctfAbi } from "./redemption";

async function main() {
  const state = JSON.parse(readFileSync("output/share-recovery.json", "utf8"));
  if (!state.completed || !state.result.executeTx) throw new Error("Share recovery is incomplete");
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  try {
    const prepared = state.prepared, receipt = await provider.getTransactionReceipt(state.result.executeTx);
    if (!receipt || receipt.status !== 1) throw new Error("No successful execution receipt");
    const ctf = new ethers.Contract(POLYGON.positions, ctfAbi, provider);
    const pusd = new ethers.Contract(POLYGON.collateral, ["function balanceOf(address) view returns(uint256)"], provider);
    const events = new ethers.Interface(["event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)"]);
    const transfers = receipt.logs.filter(log => log.address.toLowerCase() === POLYGON.positions.toLowerCase()).map(log => { try { return events.parseLog(log); } catch { return null; } });
    const exactTransfer = transfers.some(e => e && e.args.from.toLowerCase() === prepared.vault.toLowerCase() && e.args.to.toLowerCase() === prepared.recipient.toLowerCase() && String(e.args.id) === prepared.tokenId && String(e.args.value) === prepared.shares);
    const balances = { vaultShares: await ctf.balanceOf(prepared.vault, prepared.tokenId), safeShares: await ctf.balanceOf(prepared.recipient, prepared.tokenId), vaultPusd: await pusd.balanceOf(prepared.vault), safePusd: await pusd.balanceOf(prepared.recipient) };
    const checks = { successfulReceipt: receipt.status === 1, exactFiveShareTransfer: exactTransfer, vaultHasNoShares: balances.vaultShares === 0n, safeReceivedFiveShares: balances.safeShares === BigInt(prepared.before.safeShares) + BigInt(prepared.shares), collateralUnchanged: String(balances.vaultPusd) === prepared.before.vaultPusd && String(balances.safePusd) === prepared.before.safePusd };
    if (Object.values(checks).some(ok => !ok)) throw new Error("Independent share recovery verification failed");
    const report = { executeTx: receipt.hash, receiptBlock: receipt.blockNumber, verifiedAtBlock: await provider.getBlockNumber(), confirmations: await receipt.confirmations(), recipient: prepared.recipient, vault: prepared.vault, tokenId: prepared.tokenId, transferredShares: prepared.shares, balances, checks };
    const text = JSON.stringify(report, (_, value) => typeof value === "bigint" ? String(value) : value, 2) + "\n";
    writeFileSync("output/share-recovery-verification.json", text);
    console.log(text);
  } finally { provider.destroy(); }
}
main().catch((error: any) => { console.error("Share verification failed:", error.code ?? (String(error.message).includes("http") ? "provider details suppressed" : error.message)); process.exitCode = 1; });
