import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { MARKET, OTHER_MARKET, UNIT } from "../scripts/local";

describe("Treasury boundaries", function () {
  async function treasury() {
    const [controller, executor, other] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("GovernanceToken")).deploy(controller, 5000, 5000);
    const calculator = await (await ethers.getContractFactory("SkillCalculator")).deploy();
    const skills = await (await ethers.getContractFactory("GovernanceSkill")).deploy(token, controller, 5000, calculator);
    const registry = await (await ethers.getContractFactory("MarketRegistry")).deploy(controller, skills);
    const collateral = await (await ethers.getContractFactory("MockCollateral")).deploy();
    const positions = await (await ethers.getContractFactory("MockPositions")).deploy();
    const vault = await (await ethers.getContractFactory("BetVault")).deploy(controller, collateral, positions, registry);
    const closesAt = (await time.latest()) + 3600;
    await registry.registerMarket(MARKET, { yesToken: 11, noToken: 12, skillTopic: 2, closesAt, exists: true }, "local");
    await collateral.mint(vault, 100n * UNIT);
    const id = ethers.id("intent");
    const buy = { market: MARKET, tokenId: 11, shares: 100n * UNIT, payment: 55n * UNIT, deadline: closesAt - 10, executor: executor.address };
    return { controller, executor, other, registry, collateral, positions, vault, closesAt, id, buy };
  }

  it("rejects unregistered markets and mismatched outcomes", async function () {
    const { vault, id, buy } = await loadFixture(treasury);
    for (const change of [{ market: OTHER_MARKET }, { tokenId: 13 }]) {
      await expect(vault.authorizeBuy(id, { ...buy, ...change })).to.be.revertedWith("Wrong market outcome");
    }
  });

  it("rejects zero amounts, non-binary prices and the vault as executor", async function () {
    const { vault, id, buy } = await loadFixture(treasury);
    for (const change of [{ shares: 0 }, { payment: 0 }, { payment: buy.shares }]) {
      await expect(vault.authorizeBuy(id, { ...buy, ...change })).to.be.revertedWith("Invalid quote");
    }
    await expect(vault.authorizeBuy(id, { ...buy, executor: await vault.getAddress() })).to.be.revertedWith("Invalid executor");
  });

  it("requires a future execution deadline within the market's registered cutoff", async function () {
    const { vault, id, buy, closesAt } = await loadFixture(treasury);
    for (const deadline of [await time.latest(), closesAt + 1]) {
      await expect(vault.authorizeBuy(id, { ...buy, deadline })).to.be.revertedWith("Invalid execution deadline");
    }
  });

  it("prevents two live authorizations from reserving the same money", async function () {
    const { vault, id, buy } = await loadFixture(treasury);
    await vault.authorizeBuy(id, buy);
    await expect(vault.authorizeBuy(ethers.id("second"), buy)).to.be.revertedWith("Insufficient free collateral");
    await expect(vault.authorizeBuy(id, buy)).to.be.revertedWith("Repeated authorization");
  });

  it("allows withdrawals only from unreserved funds", async function () {
    const { vault, id, buy, other, collateral } = await loadFixture(treasury);
    await vault.authorizeBuy(id, buy);
    await expect(vault.withdrawCollateral(other.address, 46n * UNIT)).to.be.revertedWith("Collateral reserved");
    await vault.withdrawCollateral(other.address, 45n * UNIT);
    expect(await collateral.balanceOf(vault)).to.equal(buy.payment);
    await expect(vault.connect(other).withdrawCollateral(other.address, 1)).to.be.revertedWith("Only timelock");
  });

  it("cancellation releases funds and prevents execution or reopening the same ID", async function () {
    const { vault, id, buy, executor } = await loadFixture(treasury);
    await vault.authorizeBuy(id, buy);
    await expect(vault.connect(executor).cancel(id)).to.be.revertedWith("Only timelock");
    await vault.cancel(id);
    expect(await vault.reserved()).to.equal(0);
    expect(await vault.status(id)).to.equal(4);
    await expect(vault.connect(executor).fulfill(id, ethers.id("tx"), ethers.id("order"))).to.be.revertedWith("Not authorized");
    await expect(vault.authorizeBuy(id, buy)).to.be.revertedWith("Repeated authorization");
  });

  it("cannot satisfy delivery with tokens previously donated to the vault", async function () {
    const { vault, id, buy, positions, executor } = await loadFixture(treasury);
    await vault.authorizeBuy(id, buy);
    await positions.mint(vault, buy.tokenId, buy.shares);
    await positions.connect(executor).setApprovalForAll(vault, true);
    await expect(vault.connect(executor).fulfill(id, ethers.id("tx"), ethers.id("order"))).to.be.reverted;
    expect(await vault.status(id)).to.equal(1);
  });

  it("prevents reuse of an order reference across two authorizations", async function () {
    const { vault, id, buy, positions, collateral, executor } = await loadFixture(treasury);
    await collateral.mint(vault, 100n * UNIT);
    await vault.authorizeBuy(id, buy);
    const next = ethers.id("next");
    await vault.authorizeBuy(next, buy);
    await positions.mint(executor, buy.tokenId, buy.shares * 2n);
    await positions.connect(executor).setApprovalForAll(vault, true);
    await vault.connect(executor).fulfill(id, ethers.id("tx"), ethers.id("order"));
    await expect(vault.connect(executor).fulfill(next, ethers.id("other tx"), ethers.id("order"))).to.be.revertedWith("Order reference reused");
  });

  it("keeps a registered market's outcomes and expertise mapping immutable", async function () {
    const { registry, closesAt } = await loadFixture(treasury);
    await expect(registry.registerMarket(MARKET, { yesToken: 21, noToken: 22, skillTopic: 0, closesAt, exists: true }, "changed")).to.be.revertedWith("Invalid market");
  });

  it("opens delivery to any solver at a Dutch-auction price rising to the approved payment", async function () {
    const { vault, id, buy, positions, collateral, other } = await loadFixture(treasury);
    const open = { ...buy, executor: ethers.ZeroAddress };
    await vault.authorizeBuy(id, open);
    const start = BigInt(await vault.authorizedAt(id));
    const span = BigInt(open.deadline) - start;
    await positions.mint(other, buy.tokenId, buy.shares);
    await positions.connect(other).setApprovalForAll(vault, true);
    await time.setNextBlockTimestamp(start + span / 4n);
    await vault.connect(other).fulfill(id, ethers.id("tx"), ethers.id("order"));
    const price = buy.payment * (span / 4n) / span;
    expect(await collateral.balanceOf(other)).to.equal(price);
    expect(await positions.balanceOf(vault, buy.tokenId)).to.equal(buy.shares);
    expect(await vault.reserved()).to.equal(0);
    expect(await collateral.balanceOf(vault)).to.equal(100n * UNIT - price);
  });

  it("pays the full approved amount to an open solver at the deadline and keeps fixed quotes fixed", async function () {
    const { vault, id, buy } = await loadFixture(treasury);
    const named = ethers.id("named");
    await vault.authorizeBuy(id, { ...buy, executor: ethers.ZeroAddress, payment: buy.payment / 2n });
    await vault.authorizeBuy(named, { ...buy, payment: buy.payment / 2n });
    expect(await vault.currentPayment(named)).to.equal(buy.payment / 2n);
    await time.increaseTo(buy.deadline);
    expect(await vault.currentPayment(id)).to.equal(buy.payment / 2n);
  });

  it("accepts push delivery with the buy id in the transfer data and rejects a wrong amount", async function () {
    const { vault, id, buy, positions, collateral, other } = await loadFixture(treasury);
    await vault.authorizeBuy(id, { ...buy, executor: ethers.ZeroAddress });
    await positions.mint(other, buy.tokenId, buy.shares * 2n);
    const data = (order: string) => ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32", "bytes32"], [id, ethers.id("tx"), ethers.id(order)]);
    await expect(positions.connect(other).safeTransferFrom(other, vault, buy.tokenId, buy.shares - 1n, data("a"))).to.be.revertedWith("Wrong delivery");
    await positions.connect(other).safeTransferFrom(other, vault, buy.tokenId, buy.shares, data("b"));
    expect(await vault.status(id)).to.equal(2n);
    expect(await collateral.balanceOf(other)).to.be.greaterThan(0n);
    await expect(positions.connect(other).safeTransferFrom(other, vault, buy.tokenId, buy.shares, data("c"))).to.be.revertedWith("Not authorized");
    await positions.connect(other).safeTransferFrom(other, vault, buy.tokenId, 1n, "0x");
  });
});
