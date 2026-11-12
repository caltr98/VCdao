import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { localSystem, issueSkill, proposal, approveAndExecute, MARKET, UNIT } from "../scripts/local";
import { calculatorArgs, classifyMarket, daoTopicPolicy, mappedRegistration } from "../scripts/topic-policy";
import { deployDao, validatePlan } from "../scripts/deployment";

describe("DAO-selected Polymarket skill catalog", function () {
  it("uses substantive classifications and lets the DAO override a market", function () {
    const event = { id: "usa", tags: [{ slug: "united-states" }, { slug: "elections" }] };
    expect(classifyMarket(event, {}).skillTopic).to.equal(4);
    expect(classifyMarket({ tags: [{ slug: "politics" }, { slug: "geopolitics" }] }, {}).skillTopic).to.equal(5);
    expect(classifyMarket({ tags: [{ slug: "united-states" }, { slug: "featured" }] }, {}).skillTopic).to.equal(null);
    expect(classifyMarket(event, { conditionId: "market" }, { ...daoTopicPolicy, overrides: { market: 5 } }).skillTopic).to.equal(5);
  });

  it("requires a DAO decision for equal-priority domains and rejects invalid overrides", function () {
    expect(classifyMarket({ tags: [{ slug: "sports" }, { slug: "ai" }] }, {}).skillTopic).to.equal(null);
    expect(() => calculatorArgs({ ...daoTopicPolicy, overrides: { market: 999 } })).to.throw("Invalid classification override");
    expect(() => calculatorArgs({ ...daoTopicPolicy, skills: [daoTopicPolicy.skills[0], daoTopicPolicy.skills[0]] })).to.throw("Invalid skill catalog");
  });

  it("binds explicit outcome labels to registration even when their order is reversed", function () {
    const market = { conditionId: ethers.id("mapped"), outcomes: '["No","Yes"]', clobTokenIds: '["11","12"]', endDate: "2027-01-01", tags: [{ slug: "geopolitics" }] };
    const mapped = mappedRegistration({}, market);
    expect(mapped.registration).to.include({ yesToken: "12", noToken: "11", skillTopic: 5 });
    expect(() => mappedRegistration({}, { ...market, outcomes: '["A","B"]' })).to.throw("explicit Yes/No");
  });

  it("verifies new topic credentials, preserves bitmap IDs and does not count repeated credentials", async function () {
    const { skills, issuer, bob } = await loadFixture(localSystem);
    const names = daoTopicPolicy.skills.slice(16, 24).map(skill => skill.name);
    await issueSkill(skills, issuer, bob, names);
    expect(await skills.memberSkillBitmap(bob.address)).to.equal(255n << 16n);
    expect((await skills.getMemberSkills(bob.address)).length).to.equal(8);
    expect(await skills.getSkillVotes(bob.address, 5)).to.equal(ethers.parseEther("50"));
    const supply = await skills.getTotalSkillSupply(5);
    await issueSkill(skills, issuer, bob, names);
    expect(await skills.getTotalSkillSupply(5)).to.equal(supply);
    await expect(issueSkill(skills, issuer, bob, ["unsupportedSkill"])).to.be.revertedWithCustomError(skills, "InvalidSkill");
    expect(await skills.memberSkillBitmap(bob.address)).to.equal(255n << 16n);
  });

  it("lets the DAO proposer deliver the approved shares and receive payment", async function () {
    const { vault, governor, alice, bob, positions, collateral } = await loadFixture(localSystem);
    const buyId = ethers.id("proposer solver");
    const buy = { market: MARKET, tokenId: 11, shares: 100n * UNIT, payment: 55n * UNIT, deadline: await time.latest() + 3600, executor: ethers.ZeroAddress };
    const action = await proposal(governor, alice, await vault.getAddress(), vault.interface.encodeFunctionData("authorizeBuy", [buyId, buy]));
    await approveAndExecute(governor, [alice, bob], action);
    await positions.mint(alice.address, 11, buy.shares);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32", "bytes32"], [buyId, ethers.id("settlement"), ethers.id("order")]);
    const before = await collateral.balanceOf(alice.address);
    await positions.connect(alice).safeTransferFrom(alice.address, await vault.getAddress(), 11, buy.shares, data);
    expect(await vault.status(buyId)).to.equal(2);
    expect(await collateral.balanceOf(alice.address)).to.be.greaterThan(before);
  });

  it("deploys a DAO-selected catalog and rejects a topic absent from that catalog before deployment", async function () {
    const system = await loadFixture(localSystem);
    const policy = { version: "selected-by-dao", topics: [{ id: 0, name: "Elections", classifications: ["elections"], priority: 1 }], skills: [{ name: "electoralAnalysis", relevance: [100] }], boosts: [], overrides: {} };
    const plan = { ...system.plan, skillPolicy: policy, markets: system.plan.markets.map(market => ({ ...market, skillTopic: 0 })) };
    expect(() => validatePlan({ ...plan, markets: system.plan.markets })).to.throw("absent from the DAO catalog");
    const dao = await deployDao(plan, system.assets, system.owner);
    await dao.token.connect(system.bob).joinDAO({ value: ethers.parseEther("5") });
    await issueSkill(dao.skills, system.issuer, system.bob, ["electoralAnalysis"]);
    expect(await dao.skills.getSupportedTopics()).to.deep.equal([0n]);
    expect(await dao.skills.memberSkillBitmap(system.bob.address)).to.equal(1n);
    expect(await dao.skills.getSkillVotes(system.bob.address, 0)).to.equal(ethers.parseEther("50"));
  });

  it("rejects duplicate skill identifiers and a malformed matrix onchain", async function () {
    const factory = await ethers.getContractFactory("DaoSkillCalculator");
    const name = ethers.id("electoralAnalysis");
    await expect(factory.deploy([name, name], 1, "0x2323", [])).to.be.revertedWith("Duplicate or empty skill");
    await expect(factory.deploy([name], 2, "0x23", [])).to.be.revertedWith("Invalid relevance matrix");
  });
});
