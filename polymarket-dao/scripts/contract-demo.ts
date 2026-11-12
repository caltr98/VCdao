import { ethers } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import { localSystem, proposal, MARKET, UNIT } from "./local";
import { printJson } from "./polymarket";
import { orderObject } from "./order";

async function main() {
  const { vault, governor, automation, exchange, collateral, positions, alice, bob, executor: caller } = await localSystem();
  const id = ethers.id("contract-order-demo");
  const buy = { market: MARKET, tokenId: 11, principal: 50n * UNIT, shares: 100n * UNIT, feeBudget: 2n * UNIT, deadline: (await time.latest()) + 3600, exchange: await exchange.getAddress() };
  const action = await proposal(governor, alice, await vault.getAddress(), vault.interface.encodeFunctionData("authorizeOrder", [id, buy]));
  await voteAndTrigger();
  const wallet = await ethers.getContractAt("OrderWallet", await vault.orderWallets(id));
  const order = orderObject(await wallet.getOrder());
  await exchange.fill(order, buy.principal, buy.shares, UNIT);
  const [ready, payload] = await automation.collectionChecker(wallet);
  if (!ready) throw new Error("Settlement did not make the position collectible");
  await caller.sendTransaction({ to: await wallet.getAddress(), data: payload });
  printJson({ mode: "Local simulation; mock matching and assets", proposalState: await governor.state(action.id), orderWallet: await wallet.getAddress(), orderHash: await wallet.orderHash(), daoShares: await positions.balanceOf(vault, buy.tokenId), daoCollateral: await collateral.balanceOf(vault), walletCollateral: await collateral.balanceOf(wallet), exchangeAllowance: await collateral.allowance(wallet, exchange), callerPayment: await collateral.balanceOf(caller.address), note: "100 shares acquired for 50 principal + 1 fee; 1 unused fee budget returned. CLOB transport is not simulated by an HTTP call." });

  async function voteAndTrigger() {
    for (const voter of [alice, bob]) if (await governor.state(action.id) === 1n) await governor.connect(voter).castVote(action.id, 1);
    await mine(31);
    await trigger();
    await time.increase(10);
    await trigger();
  }

  async function trigger() {
    const [ready, payload] = await automation.checker(action.targets, action.values, action.calldatas, action.hash);
    if (!ready) throw new Error("Governance stage is not ready");
    await caller.sendTransaction({ to: await automation.getAddress(), data: payload });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
