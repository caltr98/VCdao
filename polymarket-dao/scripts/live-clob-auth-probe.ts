import { ethers, network } from "hardhat";
import { readFileSync, writeFileSync } from "fs";

const path = "output/clob-contract-auth.json";
const state = { ...JSON.parse(readFileSync("output/deposit-from-dao-2.json", "utf8")),
  ...(() => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; } })() };
const save = () => writeFileSync(path, JSON.stringify({ transport: state.transport, probe: state.probe,
  transaction: state.transaction }, null, 2) + "\n");

async function main() {
  if (network.name !== "polygon" || process.env.CONFIRM_DEPOSIT_DAO !== "yes") throw new Error("Live Polygon task required");
  const signer = new ethers.Wallet(`0x${process.env.DEPLOYER_PRIVATE_KEY!.replace(/^0x/, "")}`, ethers.provider);
  const contract = await ethers.getContractFactory("ClobAuth1271Probe", signer);
  const nonce = await ethers.provider.getTransactionCount(signer.address, "pending");
  const predicted = ethers.getCreateAddress({ from: signer.address, nonce });
  if (state.probe && state.probe.toLowerCase() !== predicted.toLowerCase() && !state.transaction) throw new Error("Deployment nonce changed");
  if (!state.transaction) {
    const tx = await contract.getDeployTransaction(state.transport);
    const fees = await ethers.provider.getFeeData();
    const gasLimit = await ethers.provider.estimateGas({ from: signer.address, data: tx.data });
    const populated = await signer.populateTransaction({ data: tx.data, nonce,
      gasLimit: gasLimit * 12n / 10n, maxFeePerGas: fees.maxFeePerGas!,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas!, type: 2 });
    const raw = await signer.signTransaction(populated);
    state.probe = predicted;
    state.transaction = { hash: ethers.keccak256(raw), raw, nonce, status: "signed" };
    save();
    await ethers.provider.broadcastTransaction(raw);
  }
  let receipt = await ethers.provider.getTransactionReceipt(state.transaction.hash);
  for (let i = 0; !receipt && i < 15; ++i) {
    await new Promise(resolve => setTimeout(resolve, 4000));
    receipt = await ethers.provider.getTransactionReceipt(state.transaction.hash);
  }
  if (!receipt || receipt.status !== 1) throw new Error("Probe deployment pending or reverted");
  state.transaction = { hash: receipt.hash, block: receipt.blockNumber, status: "confirmed" };
  save();
  const verified = await ethers.getContractAt("ClobAuth1271Probe", state.probe);
  if ((await verified.transport()).toLowerCase() !== state.transport.toLowerCase()) throw new Error("Probe signer mismatch");
  console.log(JSON.stringify({ probe: state.probe, transactionHash: receipt.hash, status: "confirmed" }));
}

main().catch(error => { console.error(String(error.shortMessage ?? error.message).replace(/https?:\/\/\S+/g, "[RPC redacted]")); process.exitCode = 1; });
