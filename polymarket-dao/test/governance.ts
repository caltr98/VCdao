import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, mine } from "@nomicfoundation/hardhat-network-helpers";
import { localSystem, proposal, approveAndExecute, issueSkill, MARKET, OTHER_MARKET, UNIT } from "../scripts/local";
import { verifyDeployment } from "../scripts/deployment";

describe("Market governance and delivery", function () {
  async function approvedBuy() {
    const system = await localSystem();
    const { vault, governor, alice, bob, executor } = system;
    const id = ethers.id("buy-1");
    const buy = { market: MARKET, tokenId: 11n, shares: 100n * UNIT, payment: 55n * UNIT, deadline: (await time.latest()) + 3600, executor: executor.address };
    const data = vault.interface.encodeFunctionData("authorizeBuy", [id, buy]);
    const action = await proposal(governor, alice, await vault.getAddress(), data);
    await approveAndExecute(governor, [alice, bob], action);
    return { ...system, id, buy, data, action };
  }

  it("executes the vote, reserves collateral and pays only after actual delivery", async function () {
    const { vault, governor, positions, collateral, executor, id, buy, action } = await loadFixture(approvedBuy);
    expect(await governor.state(action.id)).to.equal(7);
    expect(await vault.reserved()).to.equal(buy.payment);
    await positions.mint(executor, buy.tokenId, buy.shares);
    await positions.connect(executor).setApprovalForAll(vault, true);
    await expect(vault.connect(executor).fulfill(id, ethers.id("settlement"), ethers.id("order"))).to.emit(vault, "PositionDelivered");
    expect(await positions.balanceOf(vault, buy.tokenId)).to.equal(buy.shares);
    expect(await collateral.balanceOf(executor)).to.equal(buy.payment);
    expect(await vault.reserved()).to.equal(0);
    expect(await vault.status(id)).to.equal(2);
    await expect(vault.connect(executor).fulfill(id, ethers.id("settlement"), ethers.id("order"))).to.be.revertedWith("Not authorized");
  });

  it("rolls the payment and state back when the executor cannot deliver", async function () {
    const { vault, positions, collateral, executor, id, buy } = await loadFixture(approvedBuy);
    await positions.connect(executor).setApprovalForAll(vault, true);
    await expect(vault.connect(executor).fulfill(id, ethers.id("fake"), ethers.id("fake"))).to.be.reverted;
    expect(await collateral.balanceOf(executor)).to.equal(0);
    expect(await vault.status(id)).to.equal(1);
    expect(await vault.reserved()).to.equal(buy.payment);
  });

  it("rejects unapproved execution, a different executor and missing references", async function () {
    const { vault, alice, executor, id, buy } = await loadFixture(approvedBuy);
    await expect(vault.connect(alice).authorizeBuy(ethers.id("other"), buy)).to.be.revertedWith("Only timelock");
    await expect(vault.connect(alice).fulfill(id, ethers.id("tx"), ethers.id("order"))).to.be.revertedWith("Wrong executor");
    await expect(vault.connect(executor).fulfill(id, ethers.ZeroHash, ethers.id("order"))).to.be.revertedWith("Missing audit reference");
  });

  it("releases expired reservations and permanently rejects late delivery", async function () {
    const { vault, executor, id, buy } = await loadFixture(approvedBuy);
    await time.increaseTo(buy.deadline + 1);
    await expect(vault.connect(executor).fulfill(id, ethers.id("tx"), ethers.id("order"))).to.be.revertedWith("Execution expired");
    await vault.expire(id);
    expect(await vault.status(id)).to.equal(3);
    expect(await vault.reserved()).to.equal(0);
    await expect(vault.expire(id)).to.be.revertedWith("Not expired");
  });

  it("binds buy calldata to the market used for voting", async function () {
    const { vault, governor, alice, data } = await loadFixture(approvedBuy);
    await expect(governor.connect(alice).proposeWithTopic([vault], [0], [data], "Wrong topic", OTHER_MARKET)).to.be.revertedWith("Proposal market mismatch");
    await expect(governor.connect(alice).propose([vault], [0], [data], "No topic")).to.be.revertedWithCustomError(governor, "UseProposeWithTopic");
  });

  it("preserves snapshot stake + market expertise and ignores voter-supplied topics", async function () {
    const { governor, registry, token, skills, issuer, vault, alice } = await loadFixture(localSystem);
    const data = vault.interface.encodeFunctionData("withdrawCollateral", [alice.address, 1]);
    const action = await proposal(governor, alice, await vault.getAddress(), data);
    const snapshot = await governor.proposalSnapshot(action.id);
    const expected = await token.getPastVotes(alice.address, snapshot) + await registry.getPastSkillVotes(alice.address, MARKET, snapshot);
    expect(await registry.getPastSkillVotes(alice.address, MARKET, snapshot)).to.be.greaterThan(await registry.getPastSkillVotes(alice.address, OTHER_MARKET, snapshot));
    await issueSkill(skills, issuer, alice, ["machineLearning"]);
    await governor.connect(alice).castVoteWithReasonAndParams(action.id, 1, "", ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [OTHER_MARKET]));
    expect((await governor.proposalVotes(action.id)).forVotes).to.equal(expected);
    expect(await governor.quorumForProposal(action.id)).to.equal((await token.getPastTotalSupply(snapshot) + await registry.getPastTotalSkillSupply(MARKET, snapshot)) * 20n / 100n);
  });

  it("does not authorize a defeated proposal", async function () {
    const { governor, vault, alice, bob, executor } = await loadFixture(localSystem);
    const id = ethers.id("rejected");
    const buy = { market: MARKET, tokenId: 11, shares: 100n * UNIT, payment: 55n * UNIT, deadline: (await time.latest()) + 3600, executor: executor.address };
    const action = await proposal(governor, alice, await vault.getAddress(), vault.interface.encodeFunctionData("authorizeBuy", [id, buy]));
    await governor.connect(alice).castVote(action.id, 0);
    await governor.connect(bob).castVote(action.id, 0);
    await mine(31);
    expect(await governor.state(action.id)).to.equal(3);
    await expect(governor.queue(action.targets, action.values, action.calldatas, action.hash)).to.be.reverted;
    expect(await vault.status(id)).to.equal(0);
  });

  it("reads back the deployed wiring, roles, delay and bootstrap markets", async function () {
    const system = await loadFixture(localSystem);
    const checks = await verifyDeployment(system, system.plan, system.assets, system.owner.address);
    expect(Object.values(checks).every(Boolean)).to.equal(true);
    await expect(verifyDeployment(system, { ...system.plan, timelockDelaySeconds: 11 }, system.assets, system.owner.address)).to.be.rejectedWith("timelockDelay");
  });

  it("revokes deployment privileges", async function () {
    const { timelock, owner, registry } = await loadFixture(localSystem);
    expect(await timelock.hasRole(await timelock.DEFAULT_ADMIN_ROLE(), owner.address)).to.equal(false);
    expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), owner.address)).to.equal(false);
    await expect(registry.registerMarket(123, { yesToken: 1, noToken: 2, skillTopic: 0, closesAt: (await time.latest()) + 1000, exists: true }, "")).to.be.revertedWith("Only timelock");
  });

  it("rejects indirect Timelock calls that could bypass the action's market binding", async function () {
    const { governor, alice, timelock, vault } = await loadFixture(localSystem);
    const data = timelock.interface.encodeFunctionData("schedule", [await vault.getAddress(), 0, "0x", ethers.ZeroHash, ethers.id("bypass"), 10]);
    await expect(governor.connect(alice).proposeWithTopic([timelock], [0], [data], "Indirect call", MARKET)).to.be.revertedWith("Unsupported action target");
  });
});
