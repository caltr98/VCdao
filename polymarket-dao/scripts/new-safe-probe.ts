import { ethers, network } from "hardhat";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { collateral, createSafe, erc20, factory, ownerExec, safeAbi } from "./safe-fork";
import { POLYGON } from "./polymarket";

const path = "output/new-safe-probe.json";
const label = "polymarket-dao admission probe 2";
const save = (state: any) => writeFileSync(path, JSON.stringify(state, null, 2));

async function main() {
  if (network.name !== "polygon") throw new Error("Polygon required");
  const payer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, ethers.provider);
  const trader = new ethers.Wallet(ethers.keccak256(ethers.concat([payer.privateKey, ethers.toUtf8Bytes(label)])), ethers.provider);
  const address = await factory.computeProxyAddress(trader.address);
  const personal = new ethers.Contract(await factory.computeProxyAddress(payer.address), safeAbi, payer);
  const safe = new ethers.Contract(address, safeAbi, trader);
  const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { trader: trader.address, safe: address, payer: payer.address, personal: await personal.getAddress(), label };
  if (state.safe !== address || state.payer !== payer.address) throw new Error("Probe identity mismatch");
  console.log(JSON.stringify({ safe: address, trader: trader.address, deployed: await ethers.provider.getCode(address) !== "0x", payerPol: ethers.formatEther(await ethers.provider.getBalance(payer.address)), personalCollateral: String(await collateral.balanceOf(personal.target)) }));
  if (process.env.CONFIRM_NEW_SAFE_PROBE !== "yes") return;
  save(state);
  if (process.env.PROBE_CLEANUP === "yes") {
    const amount = await collateral.balanceOf(address);
    if (amount > 0n) await ownerExec(safe, trader, POLYGON.collateral, erc20.encodeFunctionData("transfer", [personal.target, amount]));
    state.remainingCollateral = String(await collateral.balanceOf(address));
    save(state);
    if (!state.gasReturned) {
      const fees = await ethers.provider.getFeeData();
      const price = fees.gasPrice!;
      // The recipient has EIP-7702 delegated code, so a transfer needs an estimate.
      const gas = await trader.estimateGas({ to: payer.address, value: 1n }) * 120n / 100n;
      const amount = await ethers.provider.getBalance(trader.address) - gas * price;
      if (amount > 0n) {
        const receipt = await (await trader.sendTransaction({ to: payer.address, value: amount, gasLimit: gas, gasPrice: price })).wait();
        state.gasReturned = receipt!.hash;
        state.returnedPol = ethers.formatEther(amount);
        save(state);
      }
    }
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  if (!state.gasFunded) {
    const receipt = await (await payer.sendTransaction({ to: trader.address, value: ethers.parseEther("0.3") })).wait();
    state.gasFunded = receipt!.hash;
    save(state);
  }
  if (await ethers.provider.getCode(address) === "0x") await createSafe(trader);
  state.deployed = true;
  save(state);
  if (!state.approved) {
    await ownerExec(safe, trader, POLYGON.collateral, erc20.encodeFunctionData("approve", [POLYGON.exchange, 50_000n]));
    state.approved = true;
    save(state);
  }
  if (!state.funded) {
    await ownerExec(personal, payer, POLYGON.collateral, erc20.encodeFunctionData("transfer", [address, 50_000n]));
    state.funded = true;
    save(state);
  }
  state.collateral = String(await collateral.balanceOf(address));
  state.owners = await safe.getOwners();
  state.threshold = String(await safe.getThreshold());
  save(state);
  console.log(JSON.stringify(state, null, 2));
}

main().catch(() => { console.error("Safe probe failed; inspect public state and chain before resuming."); process.exitCode = 1; });
