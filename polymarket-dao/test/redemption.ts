import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployDao, verifyDeployment } from "../scripts/deployment";

describe("Vault redemption", function () {
  async function fixture() {
    const [controller, caller] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("GovernanceToken")).deploy(controller, 5000, 5000);
    const calculator = await (await ethers.getContractFactory("SkillCalculator")).deploy();
    const skills = await (await ethers.getContractFactory("GovernanceSkill")).deploy(token, controller, 5000, calculator);
    const registry = await (await ethers.getContractFactory("MarketRegistry")).deploy(controller, skills);
    const collateral = await (await ethers.getContractFactory("MockCollateral")).deploy();
    const positions = await (await ethers.getContractFactory("MockResolvedPositions")).deploy();
    const adapter = await (await ethers.getContractFactory("MockRedemptionAdapter")).deploy(collateral, positions);
    const args = [controller.address, await collateral.getAddress(), await positions.getAddress(), await registry.getAddress(), await adapter.getAddress(), await adapter.getAddress(), await adapter.getAddress()] as const;
    const vault = await (await ethers.getContractFactory("RedeemableOrderVault")).deploy(...args);
    const condition = ethers.id("redemption fixture"), market = BigInt(condition), closesAt = await time.latest() + 3600;
    const ids = await Promise.all([1, 2].map(async i => positions.getPositionId(collateral, await positions.getCollectionId(ethers.ZeroHash, condition, i))));
    await positions.prepare(condition, 2);
    await registry.registerMarket(market, { yesToken: ids[0], noToken: ids[1], skillTopic: 2, closesAt, exists: true }, "fixture");
    await positions.mint(vault, ids[0], 100_001);
    await positions.mint(vault, ids[1], 80_001);
    await collateral.mint(vault, 200_000);
    return { controller, caller, positions, collateral, registry, adapter, vault, condition, market, ids, closesAt, args };
  }

  it("restricts redemption to the Timelock and clears adapter approval", async function () {
    const { controller, caller, positions, collateral, adapter, vault, condition, market, ids } = await loadFixture(fixture);
    await positions.resolve(condition, 1, 0);
    await expect(vault.connect(caller).redeem(market)).to.be.revertedWith("Only timelock");
    await expect(vault.redeem(market)).to.emit(vault, "PositionRedeemed").withArgs(market, controller.address, 100_001, 80_001, 100_001);
    expect(await collateral.balanceOf(vault)).to.equal(300_001);
    expect(await collateral.balanceOf(caller)).to.equal(0);
    for (const id of ids) expect(await positions.balanceOf(vault, id)).to.equal(0);
    expect(await positions.isApprovedForAll(vault, adapter)).to.equal(false);
    await expect(vault.redeem(market)).to.be.revertedWith("No position");
  });

  it("rounds each payout down for a fractional resolution and preserves reservations", async function () {
    const { positions, collateral, vault, condition, market, ids, closesAt } = await loadFixture(fixture);
    await vault.authorizeBuy(ethers.id("reserved"), { market, tokenId: ids[0], shares: 200_000, payment: 150_000, deadline: closesAt - 10, executor: ethers.ZeroAddress });
    await positions.resolve(condition, 1, 2);
    await vault.redeem(market);
    expect(await collateral.balanceOf(vault)).to.equal(286_667);
    expect(await vault.reserved()).to.equal(150_000);
  });

  it("burns an entirely losing position without inventing a payout", async function () {
    const { positions, collateral, vault, condition, market, ids } = await loadFixture(fixture);
    await vault.transferPosition((await ethers.getSigners())[0], ids[0], 100_001);
    await positions.resolve(condition, 1, 0);
    await vault.redeem(market);
    expect(await collateral.balanceOf(vault)).to.equal(200_000);
  });

  it("rejects unresolved and unknown markets", async function () {
    const { vault, market } = await loadFixture(fixture);
    await expect(vault.redeem(market)).to.be.revertedWith("Market unresolved");
    await expect(vault.redeem(market + 1n)).to.be.revertedWith("Unknown market");
  });

  it("rejects invalid registry mappings and non-binary conditions", async function () {
    const { registry, positions, vault, condition, market, ids, closesAt } = await loadFixture(fixture);
    const other = ethers.id("wrong mapping");
    await positions.prepare(other, 2);
    await registry.registerMarket(BigInt(other), { yesToken: ids[0], noToken: ids[1], skillTopic: 2, closesAt, exists: true }, "wrong");
    await expect(vault.redeem(BigInt(other))).to.be.revertedWith("Wrong condition outcomes");
    await positions.prepare(condition, 3);
    await expect(vault.redeem(market)).to.be.revertedWith("Not a binary condition");
  });

  for (const [mode, reason] of [[1, "Missing vault payout"], [2, "Position not consumed"], [4, "Adapter failed"]] as const) {
    it(`rolls back assets and approval when ${reason.toLowerCase()}`, async function () {
      const { positions, collateral, adapter, vault, condition, market, ids } = await loadFixture(fixture);
      await positions.resolve(condition, 1, 0);
      await adapter.setMode(mode);
      await expect(vault.redeem(market)).to.be.revertedWith(reason);
      expect(await collateral.balanceOf(vault)).to.equal(200_000);
      expect(await positions.balanceOf(vault, ids[0])).to.equal(100_001);
      expect(await positions.isApprovedForAll(vault, adapter)).to.equal(false);
    });
  }

  it("rejects adapter reentry while completing the original redemption", async function () {
    const { positions, adapter, vault, condition, market } = await loadFixture(fixture);
    await positions.resolve(condition, 1, 0);
    await adapter.setMode(3);
    await vault.redeem(market);
    expect(await adapter.reentryAccepted()).to.equal(false);
  });

  it("rejects a fixed adapter configured for different assets", async function () {
    const { positions, args } = await loadFixture(fixture);
    const other = await (await ethers.getContractFactory("MockCollateral")).deploy();
    const wrong = await (await ethers.getContractFactory("MockRedemptionAdapter")).deploy(other, positions);
    await expect((await ethers.getContractFactory("RedeemableOrderVault")).deploy(args[0], args[1], args[2], args[3], args[4], args[5], wrong)).to.be.revertedWith("Wrong adapter assets");
  });

  it("wires redemption into the full DAO deployment and hands authority to governance", async function () {
    const { controller, collateral, positions, adapter, condition, ids, closesAt } = await loadFixture(fixture);
    const plan = { timelockDelaySeconds: 30, votingDelayBlocks: 1, votingPeriodBlocks: 30, skillWeightBps: 5000, trustedIssuer: controller.address, markets: [{ conditionId: condition, yesToken: String(ids[0]), noToken: String(ids[1]), skillTopic: 2, closesAt: new Date(closesAt * 1000).toISOString(), uri: "fixture" }] };
    const assets = { collateral: await collateral.getAddress(), positions: await positions.getAddress(), exchange: await adapter.getAddress(), negRiskExchange: await adapter.getAddress(), collateralAdapter: await adapter.getAddress() };
    const dao = await deployDao(plan, assets, controller);
    const checks = await verifyDeployment(dao, plan, assets, controller.address);
    expect(Object.values(checks).every(Boolean)).to.equal(true);
    const vault = await ethers.getContractAt("RedeemableOrderVault", await dao.vault.getAddress());
    expect(await vault.redemptionAdapter()).to.equal(await adapter.getAddress());
    expect(await dao.governor.betVault()).to.equal(await vault.getAddress());
  });
});
