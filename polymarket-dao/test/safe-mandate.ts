import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";
import { localSystem, MARKET, OTHER_MARKET, UNIT } from "../scripts/local";

// Unit check of SafeMandateHandler with mock assets: a signer stands in for the Safe (the fallback
// handler sees the Safe as msg.sender). The real Safe and exchange run in `npm run check:fork-mandate`.
describe("SafeMandateHandler", () => {
  const TOKEN = 11n, PRICE = UNIT / 2n, BUDGET = 20n * UNIT, FEE_CAP = UNIT / 10n;

  async function deploy() {
    const [, timelock, exchange, safe, sink, other] = await ethers.getSigners();
    const collateral = await (await ethers.getContractFactory("MockCollateral")).deploy();
    const positions = await (await ethers.getContractFactory("MockPositions")).deploy();
    const handler = await (await ethers.getContractFactory("SafeMandateHandler")).deploy(timelock.address, collateral, positions, exchange.address);
    await collateral.mint(safe.address, BUDGET + FEE_CAP);
    const deadline = (await time.latest()) + 3600;
    await handler.connect(timelock).setMandate(safe.address, MARKET, TOKEN, PRICE, BUDGET, FEE_CAP, deadline);
    // One fill: the Safe pays `paid`, then receives `shares` from the exchange.
    const fill = async (paid: bigint, shares: bigint, id = TOKEN, operator = exchange.address, from = exchange.address) => {
      if (paid) await collateral.connect(safe).transfer(sink.address, paid);
      await positions.mint(safe.address, id, shares);
      return handler.connect(safe).onERC1155Received(operator, from, id, shares, "0x");
    };
    return { handler, collateral, positions, timelock, exchange, safe, other, deadline, fill };
  }

  it("accepts cumulative partial fills within the price and rejects the fill that breaks it", async () => {
    const { handler, fill } = await loadFixture(deploy);
    expect(await fill(5n * UNIT + FEE_CAP, 10n * UNIT)).to.equal(handler.interface.getFunction("onERC1155Received").selector);
    await fill(5n * UNIT, 10n * UNIT);
    await expect(fill(6n * UNIT, 10n * UNIT)).to.be.revertedWithCustomError(handler, "PriceAboveLimit");
  });

  it("rejects a worse price and the wrong outcome", async () => {
    const { handler, fill } = await loadFixture(deploy);
    await expect(fill(6n * UNIT, 10n * UNIT)).to.be.revertedWithCustomError(handler, "PriceAboveLimit");
    await expect(fill(0n, 10n * UNIT, 12n)).to.be.revertedWithCustomError(handler, "WrongToken");
  });

  it("rejects a spend above budget plus fee cap even at a good price", async () => {
    const [, timelock] = await ethers.getSigners();
    const { handler, collateral, safe, fill } = await loadFixture(deploy);
    await collateral.mint(safe.address, 10n * UNIT);
    await handler.connect(timelock).setMandate(safe.address, MARKET, TOKEN, PRICE, BUDGET, FEE_CAP, (await time.latest()) + 3600);
    await expect(fill(BUDGET + FEE_CAP + 1n, 100n * UNIT)).to.be.revertedWithCustomError(handler, "BudgetExceeded");
  });

  it("accepts only transfers sent by the exchange", async () => {
    const { handler, fill, other, exchange } = await loadFixture(deploy);
    await expect(fill(0n, 1n, TOKEN, other.address, exchange.address)).to.be.revertedWithCustomError(handler, "NotExchangeSettlement");
    await expect(fill(0n, 1n, TOKEN, exchange.address, other.address)).to.be.revertedWithCustomError(handler, "NotExchangeSettlement");
  });

  it("rejects fills after the deadline, after clearing and without a mandate", async () => {
    const { handler, fill, timelock, safe, deadline, other, exchange } = await loadFixture(deploy);
    await time.increaseTo(deadline + 1);
    await expect(fill(0n, 1n)).to.be.revertedWithCustomError(handler, "NoActiveMandate");
    await handler.connect(timelock).setMandate(safe.address, MARKET, TOKEN, PRICE, BUDGET, FEE_CAP, deadline + 3600);
    await handler.connect(timelock).clearMandate(safe.address);
    await expect(fill(0n, 1n)).to.be.revertedWithCustomError(handler, "NoActiveMandate");
    await expect(handler.connect(other).onERC1155Received(exchange.address, exchange.address, TOKEN, 1, "0x")).to.be.revertedWithCustomError(handler, "NoActiveMandate");
  });

  it("lets only the Timelock set or clear a mandate, with valid terms", async () => {
    const { handler, timelock, safe, other } = await loadFixture(deploy);
    const later = (await time.latest()) + 3600;
    await expect(handler.connect(other).setMandate(safe.address, MARKET, TOKEN, PRICE, BUDGET, FEE_CAP, later)).to.be.revertedWithCustomError(handler, "OnlyTimelock");
    await expect(handler.connect(other).clearMandate(safe.address)).to.be.revertedWithCustomError(handler, "OnlyTimelock");
    await expect(handler.connect(timelock).setMandate(safe.address, MARKET, TOKEN, 0, BUDGET, FEE_CAP, later)).to.be.revertedWithCustomError(handler, "InvalidMandate");
    await expect(handler.connect(timelock).setMandate(safe.address, MARKET, TOKEN, UNIT + 1n, BUDGET, FEE_CAP, later)).to.be.revertedWithCustomError(handler, "InvalidMandate");
    await expect(handler.connect(timelock).setMandate(safe.address, MARKET, TOKEN, PRICE, BUDGET, FEE_CAP, await time.latest())).to.be.revertedWithCustomError(handler, "InvalidMandate");
  });

  it("refuses batch transfers and has no ERC-1271 entry point", async () => {
    const { handler, exchange } = await loadFixture(deploy);
    await expect(handler.onERC1155BatchReceived(exchange.address, exchange.address, [TOKEN], [1], "0x")).to.be.revertedWithCustomError(handler, "BatchNotAccepted");
    expect(await handler.supportsInterface("0x4e2312e0")).to.equal(true);
    expect(handler.interface.hasFunction("isValidSignature(bytes32,bytes)")).to.equal(false);
  });
});

describe("Mandate proposals", () => {
  it("funds the Safe and sets the mandate in one vote, bound to the proposal market", async () => {
    const { governor, vault, mandateHandler, collateral, alice, bob, executor } = await loadFixture(localSystem);
    const safe = executor.address, budget = 10n * UNIT, feeCap = UNIT / 10n, deadline = (await time.latest()) + 7200;
    const mandate = (market: bigint, tokenId: bigint) => mandateHandler.interface.encodeFunctionData("setMandate", [safe, market, tokenId, UNIT / 2n, budget, feeCap, deadline]);
    const targets = [await vault.getAddress(), await mandateHandler.getAddress()];
    const calldatas = [vault.interface.encodeFunctionData("withdrawCollateral", [safe, budget + feeCap]), mandate(MARKET, 11n)];
    await expect(governor.connect(alice).proposeWithTopic(targets, [0, 0], [calldatas[0], mandate(MARKET, 21n)], "Wrong token", MARKET)).to.be.revertedWith("Mandate token mismatch");
    await expect(governor.connect(alice).proposeWithTopic(targets, [0, 0], [calldatas[0], mandate(OTHER_MARKET, 21n)], "Wrong market", MARKET)).to.be.revertedWith("Proposal market mismatch");
    await expect(governor.connect(alice).proposeWithTopic([targets[1]], [0], [mandateHandler.interface.encodeFunctionData("clearMandate", [safe])], "Other action", MARKET)).to.be.revertedWith("Unsupported mandate action");

    const description = "Fund the Safe and set its mandate";
    await governor.connect(alice).proposeWithTopic(targets, [0, 0], calldatas, description, MARKET);
    const id = await governor.hashProposal(targets, [0, 0], calldatas, ethers.id(description));
    await mine(2);
    for (const voter of [alice, bob]) if (await governor.state(id) === 1n) await governor.connect(voter).castVote(id, 1);
    await mine(31);
    await governor.queue(targets, [0, 0], calldatas, ethers.id(description));
    await time.increase(10);
    await governor.execute(targets, [0, 0], calldatas, ethers.id(description));
    const set = await mandateHandler.mandates(safe);
    expect(set.tokenId).to.equal(11n);
    expect(set.fundedBalance).to.equal(await collateral.balanceOf(safe));
    expect(set.fundedBalance).to.equal(budget + feeCap);
  });
});
