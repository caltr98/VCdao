import { ethers } from "hardhat";
import type { Wallet } from "ethers";
import { POLYGON } from "./polymarket";
import { collateral, erc20, ownerExec, safeAbi } from "./safe-fork";

// LIVE: move AMOUNT pUSD units from the deployer's Polymarket Safe to TO (the solver's Deposit Wallet).
async function main() {
  const [deployer] = await ethers.getSigners();
  const to = ethers.getAddress(process.env.TO!), amount = BigInt(process.env.AMOUNT!);
  const safe = new ethers.Contract("0x7a46dCFfa7064Fe54Ee848b125a5C58c3b9f5Ddb", safeAbi, deployer);
  await ownerExec(safe, deployer as unknown as Wallet, POLYGON.collateral, erc20.encodeFunctionData("transfer", [to, amount]));
  console.log({ to, received: (await collateral.balanceOf(to)).toString(), safeLeft: (await collateral.balanceOf(safe.target)).toString() });
}
main().catch(e => { console.error(String(e.shortMessage ?? e.message).replace(/https?:\/\/\S+/g, "[RPC redacted]")); process.exitCode = 1; });
