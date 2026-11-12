import { ethers, network } from "hardhat";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { mine, time, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import type { TransactionRequest } from "ethers";
import { forkPolygon } from "./fork";
import { POLYGON } from "./addresses";
import { REDEMPTION, ctfAbi } from "./redemption";

// Recover only the five existing shares, through their own market's electorate.
async function main() {
  const rehearsal = network.name === "hardhat";
  if (!rehearsal && (network.name !== "polygon" || process.env.CONFIRM_SHARE_RECOVERY !== "yes")) throw new Error("Share recovery authorization required");
  const fork = rehearsal ? await forkPolygon() : undefined;
  try { await recover(rehearsal); } finally { fork?.remote.destroy(); }
}

async function recover(rehearsal: boolean) {
  const path = rehearsal ? "output/share-recovery-fork.json" : "output/share-recovery.json";
  const state: any = existsSync(path) && !rehearsal ? JSON.parse(readFileSync(path, "utf8")) : { transactions: {} };
  const save = () => { writeFileSync(path + ".tmp", JSON.stringify(state, (_, v) => typeof v === "bigint" ? String(v) : v, 2) + "\n"); renameSync(path + ".tmp", path); };
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, ethers.provider);
  if (wallet.address !== REDEMPTION.owner || (await ethers.provider.getNetwork()).chainId !== 137n) throw new Error("Wrong signer or chain");
  if (rehearsal) await setBalance(wallet.address, ethers.parseEther("10"));
  const live = JSON.parse(readFileSync("output/live-auction.json", "utf8"));
  const vault = await ethers.getContractAt("OrderVault", live.dao.vault);
  const governor = await ethers.getContractAt("MarketGovernor", live.dao.governor);
  const ctf = new ethers.Contract(POLYGON.positions, ctfAbi, ethers.provider);
  const pusd = new ethers.Contract(POLYGON.collateral, ["function balanceOf(address) view returns(uint256)"], ethers.provider);
  const shares = 5_000_000n, tokenId = live.market.yes, recipient = REDEMPTION.safe;
  const targets = [live.dao.vault], values = [0], calldatas = [vault.interface.encodeFunctionData("transferPosition", [recipient, tokenId, shares])];
  const description = `Return all 5 existing YES shares on ${live.market.slug} from DAO 2 to the original funding Safe ${recipient}`;
  const descriptionHash = ethers.id(description), proposal = await governor.hashProposal(targets, values, calldatas, descriptionHash);
  if (!state.prepared) {
    if (await vault.timelock() !== live.dao.timelock || await governor.betVault() !== live.dao.vault) throw new Error("Wrong DAO wiring");
    state.prepared = { environment: rehearsal ? "Polygon fork" : "Polygon mainnet", signer: wallet.address, vault: live.dao.vault, governor: live.dao.governor, recipient, tokenId, shares, proposal, description, before: { vaultShares: await ctf.balanceOf(live.dao.vault, tokenId), safeShares: await ctf.balanceOf(recipient, tokenId), vaultPusd: await pusd.balanceOf(live.dao.vault), safePusd: await pusd.balanceOf(recipient) } };
    if (state.prepared.before.vaultShares !== shares) throw new Error("Vault does not hold exactly the expected five shares");
    if (await governor.proposalSnapshot(proposal) === 0n) await governor.connect(wallet).proposeWithTopic.staticCall(targets, values, calldatas, description, BigInt(live.market.conditionId));
    save();
  }
  if (String(state.prepared.proposal) !== String(proposal) || state.prepared.recipient !== recipient) throw new Error("Recovery journal does not match this action");
  if (await governor.proposalSnapshot(proposal) === 0n) await send("propose", { to: live.dao.governor, data: governor.interface.encodeFunctionData("proposeWithTopic", [targets, values, calldatas, description, BigInt(live.market.conditionId)]) });
  await until(async () => await governor.state(proposal) !== 0n, "Voting starts");
  if (await governor.state(proposal) === 1n && !await governor.hasVoted(proposal, wallet.address)) await send("vote", { to: live.dao.governor, data: governor.interface.encodeFunctionData("castVote", [proposal, 1]) });
  await until(async () => await governor.state(proposal) !== 1n, "Voting finishes");
  if (await governor.state(proposal) === 4n) await send("queue", { to: live.dao.governor, data: governor.interface.encodeFunctionData("queue", [targets, values, calldatas, descriptionHash]) });
  if (await governor.state(proposal) === 5n) {
    await until(async () => BigInt((await ethers.provider.getBlock("latest"))!.timestamp) >= await governor.proposalEta(proposal), "Timelock becomes ready");
    await send("execute", { to: live.dao.governor, data: governor.interface.encodeFunctionData("execute", [targets, values, calldatas, descriptionHash]) });
  }
  if (await governor.state(proposal) !== 7n) throw new Error("Recovery proposal did not execute");
  const after = { vaultShares: await ctf.balanceOf(live.dao.vault, tokenId), safeShares: await ctf.balanceOf(recipient, tokenId), vaultPusd: await pusd.balanceOf(live.dao.vault), safePusd: await pusd.balanceOf(recipient) };
  const before = state.prepared.before;
  if (after.vaultShares !== 0n || after.safeShares !== BigInt(before.safeShares) + shares || String(after.vaultPusd) !== String(before.vaultPusd) || String(after.safePusd) !== String(before.safePusd)) throw new Error("Recovery balance verification failed");
  state.result = { proposal, recipient, tokenId, transferredShares: shares, after, executeTx: state.transactions.execute?.hash, gasFeeWei: Object.values(state.transactions).reduce((sum: bigint, tx: any) => sum + BigInt(tx.receipt?.fee ?? 0), 0n) };
  state.completed = true;
  save();
  console.log(JSON.stringify(state.result, (_, v) => typeof v === "bigint" ? String(v) : v, 2));

  async function until(check: () => Promise<boolean>, message: string) {
    console.log(message);
    const end = Date.now() + 15 * 60_000;
    while (!await check()) {
      if (Date.now() > end) throw new Error("Governance wait timed out; resume from the journal");
      if (rehearsal) { await mine(2); await time.increase(10); }
      else await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  async function send(name: string, request: TransactionRequest) {
    if (!state.transactions[name]) {
      const estimate = await wallet.estimateGas(request), fees = await ethers.provider.getFeeData();
      const gasLimit = estimate * 12n / 10n + 20_000n, maxFeePerGas = fees.gasPrice! * 125n / 100n, maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? ethers.parseUnits("30", "gwei");
      const spent = Object.values(state.transactions).reduce((sum: bigint, tx: any) => sum + BigInt(tx.receipt?.fee ?? tx.worstCaseFee), 0n);
      if (spent + gasLimit * maxFeePerGas > ethers.parseEther("1")) throw new Error("Recovery gas budget exhausted");
      const nonce = Number(BigInt(await ethers.provider.send("eth_getTransactionCount", [wallet.address, "pending"])));
      const raw = await wallet.signTransaction({ ...request, chainId: 137, type: 2, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas });
      state.transactions[name] = { raw, hash: ethers.keccak256(raw), worstCaseFee: gasLimit * maxFeePerGas };
      save();
    }
    const tx = state.transactions[name];
    console.log(`${name}: ${tx.hash}`);
    const receipt = await ethers.provider.getTransactionReceipt(tx.hash) ?? await (await ethers.provider.broadcastTransaction(tx.raw)).wait(1, 180_000);
    if (!receipt) throw new Error("Confirmation timed out; resume only from the journal");
    tx.receipt = { block: receipt.blockNumber, status: receipt.status, fee: receipt.fee };
    save();
    if (receipt.status !== 1) throw new Error(`${name} reverted`);
  }
}
main().catch((error: any) => { console.error("Share recovery stopped:", error.code ?? (String(error.message).includes("http") ? "provider details suppressed" : error.message)); process.exitCode = 1; });
