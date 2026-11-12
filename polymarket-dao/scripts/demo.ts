import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { localSystem, proposal, approveAndExecute, MARKET, UNIT } from "./local";

async function main() {
  const system = await localSystem();
  const { governor, vault, alice, bob, executor, collateral, positions } = system;
  const id = ethers.id("demo-buy-1");
  const buy = { market: MARKET, tokenId: 11n, shares: 100n * UNIT, payment: 55n * UNIT, deadline: (await time.latest()) + 3600, executor: executor.address };
  const data = vault.interface.encodeFunctionData("authorizeBuy", [id, buy]);
  const action = await proposal(governor, alice, await vault.getAddress(), data);
  await approveAndExecute(governor, [alice, bob], action);
  console.log("Vote approved; timelock authorized 100 YES shares for a fixed 55 mock pUSD.");
  // A local mint substitutes for an external Polymarket fill in this offline demonstration.
  await positions.mint(executor.address, buy.tokenId, buy.shares);
  await positions.connect(executor).setApprovalForAll(vault, true);
  await vault.connect(executor).fulfill(id, ethers.id("SIMULATED settlement"), ethers.id("SIMULATED order"));
  console.log("DAO shares:", ethers.formatUnits(await positions.balanceOf(vault, 11), 6));
  console.log("Executor payment:", ethers.formatUnits(await collateral.balanceOf(executor), 6));
  console.log("Reserved collateral:", (await vault.reserved()).toString());
  console.log("Local Hardhat simulation complete. No Polymarket order was submitted.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
