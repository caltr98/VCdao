import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, mine, impersonateAccount, setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { localSystem, proposal, approveAndExecute, MARKET, OTHER_MARKET, UNIT } from "../scripts/local";
import { orderObject } from "../scripts/order";

async function orderSystem() {
  const system = await localSystem();
  const controllerAddress = await system.timelock.getAddress();
  await impersonateAccount(controllerAddress);
  await setBalance(controllerAddress, ethers.parseEther("1"));
  const controller = await ethers.getSigner(controllerAddress);
  const id = ethers.id("contract-order-test");
  const buy = { market: MARKET, tokenId: 11, principal: 50n * UNIT, shares: 100n * UNIT, feeBudget: 2n * UNIT, deadline: (await time.latest()) + 3600, exchange: await system.exchange.getAddress() };
  return { ...system, controller, id, buy };
}

async function authorizedOrder() {
  const system = await orderSystem();
  await system.vault.connect(system.controller).authorizeOrder(system.id, system.buy);
  const wallet = await ethers.getContractAt("OrderWallet", await system.vault.orderWallets(system.id));
  return { ...system, wallet, order: orderObject(await wallet.getOrder()) };
}

describe("DAO contract orders", function () {
  it("binds the exact typed order to the wallet, chain and exchange", async function () {
    const { wallet, order, exchange, negativeRiskExchange, alice } = await loadFixture(authorizedOrder);
    expect(await wallet.isValidSignature(await exchange.hashOrder(order), "0x01")).to.equal("0x1626ba7e");
    for (const change of [{ makerAmount: order.makerAmount + 1n }, { takerAmount: 1n }, { tokenId: 12n }, { maker: alice.address }, { side: 1 }, { salt: 123 }]) {
      expect(await wallet.isValidSignature(await exchange.hashOrder({ ...order, ...change }), "0x01")).to.equal("0xffffffff");
    }
    expect(await wallet.isValidSignature(await negativeRiskExchange.hashOrder(order), "0x01")).to.equal("0xffffffff");
    const types = { Order: ["salt:uint256", "maker:address", "signer:address", "tokenId:uint256", "makerAmount:uint256", "takerAmount:uint256", "side:uint8", "signatureType:uint8", "timestamp:uint256", "metadata:bytes32", "builder:bytes32"].map(field => { const [name, type] = field.split(":"); return { name, type }; }) };
    const domain = { name: "Polymarket CTF Exchange", version: "2", chainId: 31337, verifyingContract: await exchange.getAddress() };
    expect(ethers.TypedDataEncoder.hash(domain, types, order)).to.equal(await wallet.orderHash());
    expect(await wallet.isValidSignature(ethers.TypedDataEncoder.hash({ ...domain, chainId: 137 }, types, order), "0x01")).to.equal("0xffffffff");
  });

  it("gives callers no authorization, cancellation or matching privilege", async function () {
    const { vault, wallet, exchange, alice, id, buy, order } = await loadFixture(authorizedOrder);
    await expect(vault.connect(alice).authorizeOrder(ethers.id("unauthorized"), buy)).to.be.revertedWith("Only timelock");
    await expect(vault.connect(alice).cancelOrder(id)).to.be.revertedWith("Only timelock");
    await expect(wallet.connect(alice).cancel()).to.be.revertedWith("Only active treasury order");
    await expect(exchange.connect(alice).fill(order, buy.principal, buy.shares, 0)).to.be.revertedWith("Only operator");
  });

  it("isolates the approved budget and sends filled positions and change to the DAO", async function () {
    const { vault, wallet, exchange, collateral, positions, alice, buy, order } = await loadFixture(authorizedOrder);
    expect(await collateral.balanceOf(wallet)).to.equal(52n * UNIT);
    expect(await collateral.allowance(wallet, exchange)).to.equal(52n * UNIT);
    await exchange.fill(order, buy.principal, buy.shares, UNIT);
    await wallet.connect(alice).collect();
    expect(await positions.balanceOf(vault, buy.tokenId)).to.equal(buy.shares);
    expect(await collateral.balanceOf(vault)).to.equal(949n * UNIT);
    expect(await collateral.balanceOf(alice)).to.equal(0);
    expect(await collateral.allowance(wallet, exchange)).to.equal(0);
    expect(await wallet.state()).to.equal(1);
    await expect(exchange.fill(order, 1, 2, 0)).to.be.revertedWith("Invalid signature");
  });

  it("rejects premature collection, altered terms, an excessive fee and duplicate fills", async function () {
    const { wallet, exchange, buy, order } = await loadFixture(authorizedOrder);
    await expect(wallet.collect()).to.be.revertedWith("Order still active");
    await expect(exchange.fill({ ...order, makerAmount: buy.principal + 1n }, buy.principal, buy.shares, 0)).to.be.revertedWith("Invalid signature");
    await expect(exchange.fill(order, buy.principal, buy.shares, 3n * UNIT)).to.be.reverted;
    const digest = await wallet.orderHash();
    expect(await exchange.orderStatus(digest)).to.deep.equal([false, 0n]);
    await exchange.fill(order, buy.principal, buy.shares, UNIT);
    expect(await exchange.orderStatus(digest)).to.deep.equal([true, 0n]);
    await expect(exchange.validateOrder(order)).to.be.revertedWith("Order already filled");
    await expect(exchange.fill(order, 1, 2, 0)).to.be.revertedWith("Order overfilled");
  });

  it("returns partial fills and unspent collateral on expiry", async function () {
    const { vault, wallet, exchange, collateral, positions, buy, order } = await loadFixture(authorizedOrder);
    await exchange.fill(order, 20n * UNIT, 40n * UNIT, UNIT);
    await time.increaseTo(buy.deadline + 1);
    await expect(exchange.fill(order, 1, 2, 0)).to.be.revertedWith("Invalid signature");
    await wallet.collect();
    expect(await wallet.state()).to.equal(2);
    expect(await positions.balanceOf(vault, buy.tokenId)).to.equal(40n * UNIT);
    expect(await collateral.balanceOf(vault)).to.equal(979n * UNIT);
    expect(await collateral.allowance(wallet, exchange)).to.equal(0);
  });

  it("shows that a cached approval can fill after the deadline until cleanup lands", async function () {
    const { wallet, exchange, buy, order } = await loadFixture(authorizedOrder);
    await exchange.preapprove(order);
    await time.increaseTo(buy.deadline + 1);
    expect(await wallet.isValidSignature(await wallet.orderHash(), "0x01")).to.equal("0xffffffff");
    await exchange.fill({ ...order, signature: "0x" }, UNIT, 2n * UNIT, 0);
    await wallet.collect();
    await expect(exchange.fill({ ...order, signature: "0x" }, UNIT, 2n * UNIT, 0)).to.be.reverted;
  });

  it("revokes cached spending on cancellation, including after late donations", async function () {
    const { vault, wallet, controller, exchange, collateral, positions, alice, buy, id, order } = await loadFixture(authorizedOrder);
    await exchange.preapprove(order);
    await vault.connect(controller).cancelOrder(id);
    expect(await wallet.state()).to.equal(3);
    await collateral.mint(wallet, 10n * UNIT);
    await positions.mint(wallet, buy.tokenId, UNIT);
    await expect(exchange.fill({ ...order, signature: "0x" }, UNIT, 2n * UNIT, 0)).to.be.reverted;
    await wallet.connect(alice).recover();
    expect(await collateral.balanceOf(vault)).to.equal(1010n * UNIT);
    expect(await positions.balanceOf(vault, buy.tokenId)).to.equal(UNIT);
    expect(await collateral.allowance(wallet, exchange)).to.equal(0);
  });

  it("rejects an unsupported exchange, outcome and deadline", async function () {
    const { vault, controller, alice, id, buy } = await loadFixture(orderSystem);
    await expect(vault.connect(controller).authorizeOrder(id, { ...buy, exchange: alice.address })).to.be.revertedWith("Unsupported exchange");
    await expect(vault.connect(controller).authorizeOrder(id, { ...buy, tokenId: 21 })).to.be.revertedWith("Wrong market outcome");
    await expect(vault.connect(controller).authorizeOrder(id, { ...buy, deadline: await time.latest() })).to.be.revertedWith("Invalid execution deadline");
  });

  it("preserves delivery reservations and rejects invalid contract budgets", async function () {
    const { vault, controller, executor, id, buy } = await loadFixture(orderSystem);
    for (const change of [{ principal: 0 }, { feeBudget: 50n * UNIT }]) await expect(vault.connect(controller).authorizeOrder(id, { ...buy, ...change })).to.be.revertedWith("Invalid order budget");
    await vault.connect(controller).authorizeBuy(ethers.id("delivery"), { market: MARKET, tokenId: 11, payment: 960n * UNIT, shares: 2000n * UNIT, executor: executor.address, deadline: buy.deadline });
    await expect(vault.connect(controller).authorizeOrder(id, buy)).to.be.revertedWith("Insufficient free collateral");
  });

  it("cannot reuse IDs across contract and delivery routes", async function () {
    const { vault, controller, executor, buy, id } = await loadFixture(authorizedOrder);
    const delivery = { market: MARKET, tokenId: 11, payment: 50n * UNIT, shares: 100n * UNIT, executor: executor.address, deadline: buy.deadline };
    await expect(vault.connect(controller).authorizeBuy(id, delivery)).to.be.revertedWith("Repeated authorization");
    const otherId = ethers.id("delivery");
    await vault.connect(controller).authorizeBuy(otherId, delivery);
    await expect(vault.connect(controller).authorizeOrder(otherId, buy)).to.be.revertedWith("Repeated authorization");
    await vault.connect(controller).cancelOrder(id);
    await expect(vault.connect(controller).authorizeOrder(id, buy)).to.be.revertedWith("Repeated authorization");
  });
});

describe("Permissionless governance automation", function () {
  async function pending() {
    const system = await orderSystem();
    const data = system.vault.interface.encodeFunctionData("authorizeOrder", [system.id, system.buy]);
    const action = await proposal(system.governor, system.alice, await system.vault.getAddress(), data);
    return { ...system, action, data };
  }

  it("queues and executes only ready governance stages without a privileged caller", async function () {
    const { governor, automation, vault, timelock, alice, bob, executor, id, action } = await loadFixture(pending);
    const args = [action.targets, action.values, action.calldatas, action.hash] as const;
    expect((await automation.checker(...args))[0]).to.equal(false);
    await expect(automation.advance(...args)).to.be.revertedWith("Governance not ready");
    for (const voter of [alice, bob]) if (await governor.state(action.id) === 1n) await governor.connect(voter).castVote(action.id, 1);
    await mine(31);
    const [ready, payload] = await automation.checker(...args);
    expect(ready).to.equal(true);
    expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), automation)).to.equal(false);
    await executor.sendTransaction({ to: await automation.getAddress(), data: payload });
    expect((await automation.checker(...args))[0]).to.equal(false);
    await expect(automation.advance(...args)).to.be.revertedWith("Governance not ready");
    await time.increase(10);
    await automation.connect(executor).advance(...args);
    expect(await governor.state(action.id)).to.equal(7);
    expect(await vault.orderWallets(id)).not.to.equal(ethers.ZeroAddress);
    await expect(automation.advance(...args)).to.be.revertedWith("Governance not ready");
  });

  it("leaves defeated proposals unauthorized", async function () {
    const { governor, automation, vault, alice, bob, id, action } = await loadFixture(pending);
    await governor.connect(alice).castVote(action.id, 0);
    await governor.connect(bob).castVote(action.id, 0);
    await mine(31);
    expect((await automation.checker(action.targets, action.values, action.calldatas, action.hash))[0]).to.equal(false);
    await expect(automation.advance(action.targets, action.values, action.calldatas, action.hash)).to.be.revertedWith("Governance not ready");
    expect(await vault.orderWallets(id)).to.equal(ethers.ZeroAddress);
  });

  it("binds contract authorizations and cancellations to their actual market", async function () {
    const { governor, vault, alice, bob, id, action, data } = await loadFixture(pending);
    await expect(governor.connect(alice).proposeWithTopic([vault], [0], [data], "Wrong topic", OTHER_MARKET)).to.be.revertedWith("Proposal market mismatch");
    await approveAndExecute(governor, [alice, bob], action);
    const cancellation = vault.interface.encodeFunctionData("cancelOrder", [id]);
    await expect(governor.connect(alice).proposeWithTopic([vault], [0], [cancellation], "Wrong cancel topic", OTHER_MARKET)).to.be.revertedWith("Cancellation market mismatch");
    const cancelAction = await proposal(governor, alice, await vault.getAddress(), cancellation, MARKET, "Cancel order");
    await approveAndExecute(governor, [alice, bob], cancelAction);
    const wallet = await ethers.getContractAt("OrderWallet", await vault.orderWallets(id));
    expect(await wallet.state()).to.equal(3);
  });

  it("offers a collection payload only when assets can be returned", async function () {
    const { automation, wallet, vault, exchange, positions, executor, buy, order } = await loadFixture(authorizedOrder);
    expect((await automation.collectionChecker(wallet))[0]).to.equal(false);
    await exchange.fill(order, buy.principal, buy.shares, 0);
    const [ready, payload] = await automation.collectionChecker(wallet);
    expect(ready).to.equal(true);
    await executor.sendTransaction({ to: await wallet.getAddress(), data: payload });
    expect(await positions.balanceOf(vault, buy.tokenId)).to.equal(buy.shares);
    expect((await automation.collectionChecker(wallet))[0]).to.equal(false);
  });
});
