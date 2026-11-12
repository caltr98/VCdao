import { ethers, network } from "hardhat";
import type { Contract, Wallet } from "ethers";
import { readFileSync, writeFileSync } from "node:fs";
import { collateral, erc20, factory, ownerExec, safeAbi } from "./safe-fork";
import { POLYGON } from "./polymarket";

const path = "output/relayer-safe-probe.json";
const save = (state: any) => writeFileSync(path, JSON.stringify(state, null, 2));

async function main() {
  if (network.name !== "polygon" || process.env.CONFIRM_RELAYER_FIRST_FUNDING !== "yes") throw new Error("Explicit Polygon funding confirmation required");
  const state = JSON.parse(readFileSync(path, "utf8"));
  const payer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, ethers.provider);
  const personal = new ethers.Contract(await factory.computeProxyAddress(payer.address), safeAbi, payer);
  if (process.env.FUND_DEPOSIT_WALLET === "yes") {
    await fundDeposit(state, personal, payer);
    return;
  }
  const safe = new ethers.Contract(state.safe, safeAbi, ethers.provider);
  const owners = [...await safe.getOwners()];
  if (owners.length !== 1 || owners[0].toLowerCase() !== state.signer.toLowerCase() || await safe.getThreshold() !== 1n) throw new Error("Unexpected Safe ownership");
  let balance = await collateral.balanceOf(state.safe);
  if (balance === 0n) {
    if (state.directFunding || state.relayerFirstFunding?.outcome !== "STATE_FAILED") throw new Error("Reconcile existing funding attempts first");
    state.directFunding = { status: "pending", amount: "50000" };
    save(state);
    await ownerExec(personal, payer, POLYGON.collateral, erc20.encodeFunctionData("transfer", [state.safe, 50_000n]));
    balance = await collateral.balanceOf(state.safe);
  }
  if (balance !== 50_000n) throw new Error("Unexpected funded balance");
  const allowance = await new ethers.Contract(POLYGON.collateral, ["function allowance(address,address) view returns (uint256)"], ethers.provider).allowance(state.safe, POLYGON.exchange);
  if (allowance !== 50_000n) throw new Error("Unexpected exchange allowance");
  state.directFunding = { status: "confirmed", amount: String(balance) };
  state.relayerFirstOnchain = { safe: state.safe, owners, threshold: "1", collateral: String(balance), allowance: String(allowance), block: await ethers.provider.getBlockNumber() };
  save(state);
  console.log(JSON.stringify(state.relayerFirstOnchain, null, 2));
}

async function fundDeposit(state: any, personal: Contract, payer: Wallet) {
  const deposit = state.depositExecutor;
  const wallet = new ethers.Contract(deposit.wallet, ["function owner() view returns(address)"], ethers.provider);
  if ((await wallet.owner()).toLowerCase() !== state.signer.toLowerCase()) throw new Error("Unexpected Deposit Wallet owner");
  if (deposit.funding || await collateral.balanceOf(deposit.wallet) !== 0n) throw new Error("Reconcile existing Deposit Wallet funds first");
  deposit.funding = { status: "pending", amount: "50000" };
  save(state);
  await ownerExec(personal, payer, POLYGON.collateral, erc20.encodeFunctionData("transfer", [deposit.wallet, 50000]));
  if (await collateral.balanceOf(deposit.wallet) !== 50000n) throw new Error("Unexpected Deposit Wallet balance");
  deposit.funding.status = "confirmed";
  save(state);
  console.log("Deposit Wallet funded with exactly 0.05 pUSD");
}

main().catch(() => { console.error("Funding verification failed; reconcile before continuing."); process.exitCode = 1; });
