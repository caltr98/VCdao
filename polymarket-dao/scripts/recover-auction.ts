import { ethers, network } from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import { POLYGON } from "./addresses";

const path = "output/auction-recovery.json";
const state: Record<string, string> = {};
const save = () => writeFileSync(path, JSON.stringify(state, null, 2) + "\n");

async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 15 * 60_000;
  while (!await check()) {
    if (Date.now() > end) throw new Error("Recovery wait timed out");
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

async function main() {
  if (network.name !== "polygon" || process.env.CONFIRM_RECOVERY !== "yes") throw new Error("Recovery authorization required");
  const prepared = JSON.parse(readFileSync("output/auction-recovery-prepared.json", "utf8"));
  const [signer] = await ethers.getSigners();
  if (signer.address !== prepared.signer) throw new Error("Wrong signer");
  const vault = await ethers.getContractAt("OrderVault", prepared.vault, signer);
  const governor = await ethers.getContractAt("MarketGovernor", prepared.governor, signer);
  const journal = JSON.parse(readFileSync("output/live-auction-1.json", "utf8"));
  if (await vault.status(journal.authorizeBuy.id) === 1n) {
    state.expire = (await (await signer.sendTransaction({ to: prepared.vault, data: prepared.expireCalldata })).wait())!.hash;
    save();
  }
  const { targets, values, calldatas, descriptionHash, proposal } = prepared;
  // Resume by on-chain proposal state; a repeated run never proposes or executes twice.
  try { await governor.proposalSnapshot(proposal); } catch { throw new Error("Cannot inspect proposal"); }
  if (await governor.proposalSnapshot(proposal) === 0n) {
    state.propose = (await (await governor.proposeWithTopic(targets, values, calldatas, prepared.description, prepared.topic)).wait())!.hash;
    save();
  }
  await until(async () => await governor.state(proposal) !== 0n);
  if (await governor.state(proposal) === 1n && !await governor.hasVoted(proposal, signer.address)) {
    state.vote = (await (await governor.castVote(proposal, 1)).wait())!.hash;
    save();
  }
  await until(async () => await governor.state(proposal) !== 1n);
  if (await governor.state(proposal) === 4n) {
    state.queue = (await (await governor.queue(targets, values, calldatas, descriptionHash)).wait())!.hash;
    save();
  }
  if (await governor.state(proposal) === 5n) {
    await until(async () => BigInt((await ethers.provider.getBlock("latest"))!.timestamp) >= await governor.proposalEta(proposal));
    state.execute = (await (await governor.execute(targets, values, calldatas, descriptionHash)).wait())!.hash;
    save();
  }
  if (await governor.state(proposal) !== 7n) throw new Error("Proposal did not execute");
  const collateral = new ethers.Contract(POLYGON.collateral, ["function balanceOf(address) view returns(uint256)"], ethers.provider);
  state.vaultBalance = (await collateral.balanceOf(prepared.vault)).toString();
  state.recipientBalance = (await collateral.balanceOf(prepared.recipient)).toString();
  state.recipient = prepared.recipient;
  if (state.vaultBalance !== "0") throw new Error("Unexpected remaining vault balance");
  save();
  console.log(JSON.stringify(state, null, 2));
}

main().catch(() => { console.error("Recovery stopped; inspect the public journal and on-chain state before resuming. Provider details suppressed."); process.exitCode = 1; });
