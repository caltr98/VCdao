import { ethers } from "hardhat";
import { writeFileSync } from "node:fs";
import { forkPolygon } from "./fork";
import { POLYGON } from "./addresses";
import { collateral, erc20, impersonated } from "./safe-fork";
import { REDEMPTION, redemptionMarket, registration, verifyRedemptionAssets } from "./redemption";

async function main() {
  const fork = await forkPolygon();
  try {
    const market = redemptionMarket(), { adapter, ctf } = await verifyRedemptionAssets(market);
    const [owner, stranger] = await ethers.getSigners();
    const oldBefore = await ctf.balanceOf(REDEMPTION.oldVault, REDEMPTION.oldToken);
    const timelock = await (await ethers.getContractFactory("TimelockController")).deploy(0, [owner.address], [ethers.ZeroAddress], owner.address);
    const registry = await (await ethers.getContractFactory("MarketRegistry")).deploy(timelock, REDEMPTION.skills);
    const vault = await (await ethers.getContractFactory("RedeemableOrderVault")).deploy(timelock, POLYGON.collateral, POLYGON.positions, registry, POLYGON.exchange, POLYGON.negRiskExchange, REDEMPTION.adapter);
    const data = registry.interface.encodeFunctionData("registerMarket", registration(market, fork.timestamp + 86_400));
    await timelock.schedule(registry, 0, data, ethers.ZeroHash, ethers.id("fixture registration"), 0);
    await timelock.execute(registry, 0, data, ethers.ZeroHash, ethers.id("fixture registration"));
    // Only acquisition funding is impersonated on this fork; resolution and adapter code are real.
    await collateral.connect(await impersonated(REDEMPTION.safe)).getFunction("transfer")(owner, REDEMPTION.principal);
    await owner.sendTransaction({ to: POLYGON.collateral, data: erc20.encodeFunctionData("approve", [REDEMPTION.adapter, REDEMPTION.principal]) });
    await adapter.connect(owner).getFunction("splitPosition")(POLYGON.collateral, ethers.ZeroHash, market.conditionId, [1, 2], REDEMPTION.principal);
    await ctf.connect(owner).getFunction("safeBatchTransferFrom")(owner, vault, [market.yes, market.no], [REDEMPTION.principal, REDEMPTION.principal], "0x");
    const before = await collateral.balanceOf(vault);
    const redeem = vault.interface.encodeFunctionData("redeem", [BigInt(market.conditionId)]), salt = ethers.id("fixture redemption");
    await timelock.schedule(vault, 0, redeem, ethers.ZeroHash, salt, 0);
    await timelock.connect(stranger).execute(vault, 0, redeem, ethers.ZeroHash, salt);
    const payout = BigInt(await collateral.balanceOf(vault)) - BigInt(before);
    const checks = { exactPayout: payout === REDEMPTION.principal, callerReceivesNothing: await collateral.balanceOf(stranger) === 0n, sharesConsumed: await ctf.balanceOf(vault, market.yes) === 0n && await ctf.balanceOf(vault, market.no) === 0n, approvalRevoked: !await ctf.isApprovedForAll(vault, REDEMPTION.adapter), oldPositionUnchanged: await ctf.balanceOf(REDEMPTION.oldVault, REDEMPTION.oldToken) === oldBefore };
    if (Object.values(checks).some(passed => !passed)) throw new Error("Fork redemption verification failed");
    const report = { environment: "Polygon fork; funding impersonated, real pre-existing resolution; no oracle manipulation", block: fork.block, market, payout: String(payout), checks };
    writeFileSync("output/fork-redemption-timelock.json", JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally { fork.remote.destroy(); }
}
main().catch((error: any) => { console.error("Fork redemption failed:", error.reason ?? error.code ?? "provider details suppressed"); process.exitCode = 1; });
