import { expect } from "chai";
import { ethers, network } from "hardhat";
import { impersonateAccount, loadFixture, mine, setBalance, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployDao, verifyDeployment } from "../scripts/deployment";
import { proposal } from "../scripts/local";
import { mkdirSync, writeFileSync } from "node:fs";

describe("DAO-funded governed redemption", function () {
  const budget = ethers.parseEther("0.5"), maxRefund = ethers.parseEther("0.1");
  const priceCap = ethers.parseUnits("2", "gwei"), gasCap = 1_200_000n, overhead = 100_000n;

  async function fixture() {
    const [owner, caller, other] = await ethers.getSigners();
    const collateral = await (await ethers.getContractFactory("MockCollateral")).deploy();
    const positions = await (await ethers.getContractFactory("MockResolvedPositions")).deploy();
    const adapter = await (await ethers.getContractFactory("MockRedemptionAdapter")).deploy(collateral, positions);
    const condition = ethers.id("governed redemption"), market = BigInt(condition), closesAt = await time.latest() + 86400;
    const ids = await Promise.all([1, 2].map(async i => positions.getPositionId(collateral, await positions.getCollectionId(ethers.ZeroHash, condition, i))));
    const second = ethers.id("other redemption topic");
    const markets = [condition, second].map(conditionId => ({ conditionId, yesToken: String(ids[0]), noToken: String(ids[1]), skillTopic: 2, closesAt: new Date(closesAt * 1000).toISOString(), uri: "fixture" }));
    const plan = { timelockDelaySeconds: 30, votingDelayBlocks: 1, votingPeriodBlocks: 30, skillWeightBps: 5000, trustedIssuer: owner.address, markets };
    const assets = { collateral: await collateral.getAddress(), positions: await positions.getAddress(), exchange: await adapter.getAddress(), negRiskExchange: await adapter.getAddress(), collateralAdapter: await adapter.getAddress() };
    const dao = await deployDao(plan, assets, owner);
    const vault = await ethers.getContractAt("RedeemableOrderVault", await dao.vault.getAddress());
    await dao.token.joinDAO({ value: ethers.parseEther("1") });
    await dao.token.delegate(owner);
    await positions.prepare(condition, 2);
    await positions.resolve(condition, 1, 0);
    await positions.mint(vault, ids[0], 100_000);
    await positions.mint(vault, ids[1], 100_000);
    await collateral.mint(vault, 200_000);
    return { ...dao, vault, owner, caller, other, collateral, positions, adapter, condition, market, second: BigInt(second), ids, closesAt, plan, assets };
  }

  async function queueAction(s: Awaited<ReturnType<typeof fixture>>, data: string, description: string) {
    const action = await proposal(s.governor, s.owner, await s.vault.getAddress(), data, s.market, description);
    await s.governor.castVote(action.id, 1);
    await mine(31);
    await queueWithoutFee(s, action);
    await time.increase(30);
    return action;
  }

  // Execution-only regressions isolate the execution payment; queue payments have their own tests below.
  async function queueWithoutFee(s: Awaited<ReturnType<typeof fixture>>, action: Awaited<ReturnType<typeof proposal>>) {
    await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
    await s.governor.queue(action.targets, action.values, action.calldatas, action.hash, { gasPrice: 0 });
    await network.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x3b9aca00"]);
    await mine();
  }

  async function configure(s: Awaited<ReturnType<typeof fixture>>, caps: [bigint, bigint, bigint, bigint, bigint] = [budget, maxRefund, priceCap, gasCap, overhead]) {
    const action = await queueAction(s, s.vault.interface.encodeFunctionData("configureRedemptionGas", caps), `Allocate redemption gas ${caps}`);
    await s.governor.execute(action.targets, action.values, action.calldatas, action.hash);
    return action;
  }

  async function ready() {
    const s = await fixture();
    await configure(s);
    const action = await queueAction(s, s.vault.interface.encodeFunctionData("redeem", [s.market]), "Redeem this resolved market");
    return { ...s, action };
  }

  async function execute(s: Awaited<ReturnType<typeof ready>>, gasPrice = priceCap * 2n) {
    const { action: a } = s;
    const tx = await s.governor.connect(s.caller).execute(a.targets, a.values, a.calldatas, a.hash, { gasPrice });
    const receipt = (await tx.wait())!;
    const refund = receipt.logs.map(log => { try { return s.vault.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === "RedemptionRefund")!;
    return { tx, receipt, refund };
  }

  it("reimburses separate queue and execution callers and records five local gas samples", async function () {
    const records: object[] = [];
    const gasPrice = ethers.parseUnits("278.395338579", "gwei");
    for (let sample = 1; sample <= 5; sample++) {
      const s = await fixture();
      await configure(s, [budget, maxRefund, gasPrice, gasCap, overhead]);
      const data = s.vault.interface.encodeFunctionData("redeem", [s.market]);
      const description = `Queue reimbursement sample ${sample}`, hash = ethers.id(description);
      const a = { targets: [await s.vault.getAddress()], values: [0], calldatas: [data], hash };
      await record("redemption.propose", await s.governor.proposeWithTopic(a.targets, a.values, a.calldatas, description, s.market, { gasPrice }));
      const id = await s.governor.hashProposal(a.targets, a.values, a.calldatas, hash);
      await mine(2);
      await record("redemption.vote", await s.governor.castVote(id, 1, { gasPrice }));
      const [ready, target, payload] = await s.automation.redemptionChecker(a.targets, a.values, a.calldatas, hash);
      expect(ready).to.equal(true);
      expect(target).to.equal(await s.governor.getAddress());
      expect(payload).to.equal(s.governor.interface.encodeFunctionData("queue", [a.targets, a.values, a.calldatas, hash]));
      expect((await s.automation.checker(a.targets, a.values, a.calldatas, hash))[0]).to.equal(false);
      await expect(s.automation.advance(a.targets, a.values, a.calldatas, hash)).to.be.revertedWith("Execute redemption directly on governor");
      const before = await ethers.provider.getBalance(s.caller);
      const queued = await record("redemption.queue", await s.governor.connect(s.caller).queue(a.targets, a.values, a.calldatas, hash, { gasPrice }));
      expect(await ethers.provider.getBalance(s.caller)).to.equal(before - queued.receipt.fee + queued.amount);
      expect(queued.caller).to.equal(s.caller.address);
      await expect(s.governor.queue(a.targets, a.values, a.calldatas, hash)).to.be.reverted;
      await time.increase(30);
      const executed = await record("redemption.execute", await s.governor.connect(s.other).execute(a.targets, a.values, a.calldatas, hash, { gasPrice }));
      expect(executed.caller).to.equal(s.other.address);
      expect(await s.vault.redemptionGasBudget()).to.equal(budget - queued.amount - executed.amount);
      expect(await s.vault.redemptionRefunded(id)).to.equal(true);

      async function record(operation: string, tx: Awaited<ReturnType<typeof s.governor.queue>>) {
        const receipt = (await tx.wait())!;
        const refund = receipt.logs.map(log => { try { return s.vault.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === "RedemptionRefund");
        const amount = refund?.args.amount ?? 0n, caller = refund?.args.caller;
        expect(receipt.status).to.equal(1);
        if (refund) expect(amount).to.equal([refund.args.gasUnits * gasPrice, maxRefund, await s.vault.redemptionGasBudget() + amount].reduce((a, b) => a < b ? a : b));
        records.push({ sample, operation, environment: "local mocks", transaction: tx.hash, payer: tx.from, gasUsed: String(receipt.gasUsed), gasPrice: String(gasPrice), fee: String(receipt.fee), reimbursement: String(amount), refundCaller: caller ?? null });
        return { receipt, amount: BigInt(amount), caller };
      }
    }
    mkdirSync("output/queue-reimbursement", { recursive: true });
    writeFileSync("output/queue-reimbursement/operations.json", JSON.stringify(records, null, 2) + "\n");
  });

  it("executes a voted Timelock redemption, pays the vault and refunds the actual caller once", async function () {
    const s = await loadFixture(ready);
    const beforeCaller = await ethers.provider.getBalance(s.caller), beforeVault = await ethers.provider.getBalance(s.vault);
    const { receipt, refund } = await execute(s);
    const amount = refund.args.amount;
    expect(refund.args.proposal).to.equal(s.action.id);
    expect(refund.args.market).to.equal(s.market);
    expect(refund.args.caller).to.equal(s.caller.address);
    expect(refund.args.gasPrice).to.equal(priceCap);
    expect(refund.args.gasUnits).to.be.at.most(gasCap);
    expect(amount).to.equal(refund.args.gasUnits * priceCap).and.to.be.greaterThan(0);
    expect(await ethers.provider.getBalance(s.caller)).to.equal(beforeCaller - receipt.gasUsed * receipt.gasPrice + amount);
    expect(await ethers.provider.getBalance(s.vault)).to.equal(beforeVault - amount);
    expect(await s.vault.redemptionGasBudget()).to.equal(budget - amount);
    expect(await s.collateral.balanceOf(s.vault)).to.equal(300_000);
    expect(await s.collateral.balanceOf(s.caller)).to.equal(0);
    for (const id of s.ids) expect(await s.positions.balanceOf(s.vault, id)).to.equal(0);
    expect(await s.positions.isApprovedForAll(s.vault, s.adapter)).to.equal(false);
    expect(await s.governor.state(s.action.id)).to.equal(7);
    expect(await s.vault.redemptionRefunded(s.action.id)).to.equal(true);
    await expect(execute(s)).to.be.reverted;
    expect(await s.vault.redemptionGasBudget()).to.equal(budget - amount);
  });

  it("reserves rejected queue payments, rejects queue reentry and preserves credit after failed execution", async function () {
    const s = await loadFixture(fixture);
    await configure(s);
    const action = await proposal(s.governor, s.owner, await s.vault.getAddress(), s.vault.interface.encodeFunctionData("redeem", [s.market]), s.market, "Contract queue caller");
    await s.governor.castVote(action.id, 1);
    const receiver = await (await ethers.getContractFactory("RedemptionCaller")).deploy();
    const callback = s.governor.interface.encodeFunctionData("queue", [[], [], [], ethers.ZeroHash]);
    await receiver.configure(false, await s.governor.getAddress(), callback);
    await receiver.queue(s.governor, action.targets, action.values, action.calldatas, action.hash, { gasPrice: priceCap });
    expect(await receiver.reentryAttempted()).to.equal(true);
    expect(await receiver.reentryAccepted()).to.equal(false);
    const paid = budget - await s.vault.redemptionGasBudget();
    expect(paid).to.be.greaterThan(0);
    expect(await ethers.provider.getBalance(receiver) + await s.vault.refundCredit(receiver)).to.equal(paid);
    await s.positions.resolve(s.condition, 0, 0);
    await time.increase(30);
    await expect(s.governor.execute(action.targets, action.values, action.calldatas, action.hash)).to.be.revertedWith("Market unresolved");
    expect(await s.vault.redemptionGasBudget()).to.equal(budget - paid);
    expect(await s.vault.redemptionRefunded(action.id)).to.equal(false);
  });

  it("caps queue payment, reserves a rejected transfer and allows execution with depleted allocation", async function () {
    const s = await loadFixture(fixture);
    await configure(s, [777n, 1000n, priceCap, 100n, 0n]);
    const action = await proposal(s.governor, s.owner, await s.vault.getAddress(), s.vault.interface.encodeFunctionData("redeem", [s.market]), s.market, "Queue consumes allocation");
    await s.governor.castVote(action.id, 1);
    const receiver = await (await ethers.getContractFactory("RedemptionCaller")).deploy();
    await receiver.configure(true, ethers.ZeroAddress, "0x");
    await receiver.queue(s.governor, action.targets, action.values, action.calldatas, action.hash, { gasPrice: priceCap * 2n });
    expect(await s.vault.refundCredit(receiver)).to.equal(777);
    expect(await s.vault.refundLiability()).to.equal(777);
    expect(await s.vault.redemptionGasBudget()).to.equal(0);
    await time.increase(30);
    const { refund } = await execute({ ...s, action });
    expect(refund.args.amount).to.equal(0);
    expect(await s.vault.refundCredit(receiver)).to.equal(777);
    await receiver.configure(false, ethers.ZeroAddress, "0x");
    await receiver.claim(s.vault);
    expect(await ethers.provider.getBalance(receiver)).to.equal(777);
    expect(await s.vault.refundLiability()).to.equal(0);
  });

  it("seals deployment wiring and rejects caller-controlled refund, budget or direct redemption", async function () {
    const s = await loadFixture(ready);
    expect(Object.values(await verifyDeployment(s, s.plan, s.assets, s.owner.address)).every(Boolean)).to.equal(true);
    await expect(s.vault.connect(s.caller).redeem(s.market)).to.be.revertedWith("Only timelock");
    await expect(s.vault.connect(s.caller).configureRedemptionGas(budget, maxRefund, priceCap, gasCap, overhead)).to.be.revertedWith("Only timelock");
    await expect(s.vault.connect(s.caller).reimburseRedemption(s.action.id, s.market, s.other, gasCap)).to.be.revertedWith("Only redemption governor");
    await expect(s.vault.connect(s.caller).bindRedemptionGovernor(s.governor)).to.be.revertedWith("Only timelock");
    await impersonateAccount(await s.timelock.getAddress());
    await setBalance(await s.timelock.getAddress(), ethers.parseEther("1"));
    await expect(s.vault.connect(await ethers.getSigner(await s.timelock.getAddress())).bindRedemptionGovernor(s.governor)).to.be.revertedWith("Governor already bound");
    const bind = s.vault.interface.encodeFunctionData("bindRedemptionGovernor", [await s.governor.getAddress()]);
    await expect(s.governor.proposeWithTopic([s.vault], [0], [bind], "Replace governor", s.market)).to.be.revertedWith("Unsupported vault action");
  });

  it("requires exact redemption calldata, its market electorate, and zero call value", async function () {
    const s = await loadFixture(fixture), data = s.vault.interface.encodeFunctionData("redeem", [s.market]);
    await expect(s.governor.proposeWithTopic([s.vault], [0], [data], "Wrong topic", s.second)).to.be.revertedWith("Redemption market mismatch");
    for (const malformed of [data + "00", data.slice(0, -2)])
      await expect(s.governor.proposeWithTopic([s.vault], [0], [malformed], "Malformed", s.market)).to.be.revertedWith("Redemption market mismatch");
    await expect(s.governor.proposeWithTopic([s.vault], [1], [data], "Value", s.market)).to.be.revertedWith("Invalid action");
    const config = s.vault.interface.encodeFunctionData("configureRedemptionGas", [budget, maxRefund, priceCap, gasCap, overhead]);
    await expect(s.governor.proposeWithTopic([s.vault], [0], [config + "00"], "Bad config", s.market)).to.be.revertedWith("Invalid gas allocation calldata");
  });

  it("waits for the delay and genuine resolution without refunding a failed attempt", async function () {
    const s = await loadFixture(fixture);
    await configure(s);
    await s.positions.resolve(s.condition, 0, 0);
    const action = await proposal(s.governor, s.owner, await s.vault.getAddress(), s.vault.interface.encodeFunctionData("redeem", [s.market]), s.market, "Wait for resolution");
    await s.governor.castVote(action.id, 1);
    await queueWithoutFee(s, action);
    await expect(s.governor.execute(action.targets, action.values, action.calldatas, action.hash)).to.be.reverted;
    await time.increase(30);
    await expect(execute({ ...s, action })).to.be.revertedWith("Market unresolved");
    expect((await s.automation.redemptionChecker(action.targets, action.values, action.calldatas, action.hash))[0]).to.equal(false);
    expect(await s.vault.redemptionGasBudget()).to.equal(budget);
    expect(await s.vault.redemptionRefunded(action.id)).to.equal(false);
    expect(await s.governor.state(action.id)).to.equal(5);
    await s.positions.resolve(s.condition, 1, 0);
    expect((await s.automation.redemptionChecker(action.targets, action.values, action.calldatas, action.hash))[0]).to.equal(true);
    await execute({ ...s, action });
    expect(await s.governor.state(action.id)).to.equal(7);
  });

  it("does not refund a rejected proposal or an adapter failure", async function () {
    const s = await loadFixture(ready);
    await s.adapter.setMode(4);
    await expect(execute(s)).to.be.revertedWith("Adapter failed");
    expect(await s.vault.redemptionGasBudget()).to.equal(budget);
    expect(await s.vault.redemptionRefunded(s.action.id)).to.equal(false);
    expect(await s.positions.balanceOf(s.vault, s.ids[0])).to.equal(100_000);
    const rejected = await proposal(s.governor, s.owner, await s.vault.getAddress(), s.vault.interface.encodeFunctionData("redeem", [s.market]), s.market, "Rejected redemption");
    await s.governor.castVote(rejected.id, 0);
    await mine(31);
    await expect(s.governor.execute(rejected.targets, rejected.values, rejected.calldatas, rejected.hash)).to.be.reverted;
    expect(await s.vault.redemptionGasBudget()).to.equal(budget);
  });

  for (const [label, caps, expected] of [
    ["per-execution cap", [budget, 1000n, priceCap, gasCap, overhead], 1000n],
    ["remaining allocation", [777n, maxRefund, priceCap, gasCap, overhead], 777n],
    ["gas-unit cap", [budget, maxRefund, priceCap, 100n, 0n], 100n * priceCap],
    ["empty allocation", [0n, maxRefund, priceCap, gasCap, overhead], 0n],
    ["zero gas-price cap", [budget, maxRefund, 0n, gasCap, overhead], 0n],
  ] as const) {
    it(`bounds the refund by ${label} and still completes redemption`, async function () {
      const s = await loadFixture(fixture);
      await configure(s, [...caps]);
      const action = await queueAction(s, s.vault.interface.encodeFunctionData("redeem", [s.market]), label);
      const { refund } = await execute({ ...s, action });
      expect(refund.args.amount).to.equal(expected);
      expect(await s.vault.redemptionGasBudget()).to.equal(caps[0] - expected);
      expect(await s.collateral.balanceOf(s.vault)).to.equal(300_000);
    });
  }

  it("uses the actual transaction gas price below the approved cap", async function () {
    const s = await loadFixture(ready);
    const { refund } = await execute(s, priceCap / 2n);
    expect(refund.args.gasPrice).to.equal(priceCap / 2n);
    expect(refund.args.amount).to.equal(refund.args.gasUnits * priceCap / 2n);
  });

  it("protects the allocation from withdrawals and preserves collateral reservations", async function () {
    const s = await loadFixture(ready);
    const buy = { market: s.market, tokenId: s.ids[0], shares: 200_000, payment: 150_000, deadline: s.closesAt - 10, executor: ethers.ZeroAddress };
    const reserve = await queueAction(s, s.vault.interface.encodeFunctionData("authorizeBuy", [ethers.id("pending buy"), buy]), "Reserve buy funds");
    await s.governor.execute(reserve.targets, reserve.values, reserve.calldatas, reserve.hash);
    const withdrawal = await queueAction(s, s.vault.interface.encodeFunctionData("withdrawNative", [s.other.address, ethers.parseEther("0.6")]), "Withdraw allocated POL");
    await expect(s.governor.execute(withdrawal.targets, withdrawal.values, withdrawal.calldatas, withdrawal.hash)).to.be.revertedWith("Native funds reserved");
    await execute(s);
    expect(await s.vault.reserved()).to.equal(150_000);
    expect(await s.token.stakeDeposited(s.owner)).to.equal(ethers.parseEther("1"));
    const free = await queueAction(s, s.vault.interface.encodeFunctionData("withdrawNative", [s.other.address, ethers.parseEther("0.5")]), "Withdraw free POL");
    await s.governor.execute(free.targets, free.values, free.calldatas, free.hash);
    expect(await ethers.provider.getBalance(s.vault)).to.equal(await s.vault.redemptionGasBudget());
  });

  it("rejects overfunded and uncapped policies", async function () {
    const s = await loadFixture(fixture);
    for (const [caps, reason] of [
      [[ethers.parseEther("2"), maxRefund, priceCap, gasCap, overhead], "Insufficient native funds"],
      [[budget, maxRefund, priceCap, gasCap, 150_001n], "Invalid gas policy"],
      [[budget, maxRefund, priceCap, 5_000_001n, overhead], "Invalid gas policy"],
      [[budget, maxRefund, priceCap, 99n, 100n], "Invalid gas policy"],
      [[budget, maxRefund, ethers.parseUnits("10001", "gwei"), gasCap, overhead], "Invalid gas price cap"],
    ] as const) {
      const action = await queueAction(s, s.vault.interface.encodeFunctionData("configureRedemptionGas", [...caps]), reason);
      await expect(s.governor.execute(action.targets, action.values, action.calldatas, action.hash)).to.be.revertedWith(reason);
    }
  });

  it("reserves a failed refund for its contract caller, preserves execution and permits one claim", async function () {
    const s = await loadFixture(ready), receiver = await (await ethers.getContractFactory("RedemptionCaller")).deploy();
    await receiver.configure(true, ethers.ZeroAddress, "0x");
    const { action: a } = s;
    await receiver.execute(s.governor, a.targets, a.values, a.calldatas, a.hash, { gasPrice: priceCap });
    const credit = await s.vault.refundCredit(receiver);
    expect(credit).to.be.greaterThan(0);
    expect(await s.vault.refundLiability()).to.equal(credit);
    expect(await s.vault.redemptionGasBudget()).to.equal(budget - credit);
    expect(await s.vault.refundCredit(s.owner)).to.equal(0);
    expect(await s.governor.state(a.id)).to.equal(7);
    const steal = await queueAction(s, s.vault.interface.encodeFunctionData("withdrawNative", [s.other.address, ethers.parseEther("0.5") + 1n]), "Spend credit");
    await expect(s.governor.execute(steal.targets, steal.values, steal.calldatas, steal.hash)).to.be.revertedWith("Native funds reserved");
    await configure(s, [0n, maxRefund, priceCap, gasCap, overhead]);
    const excess = await queueAction(s, s.vault.interface.encodeFunctionData("withdrawNative", [s.other.address, ethers.parseEther("1") - credit + 1n]), "Spend liability after release");
    await expect(s.governor.execute(excess.targets, excess.values, excess.calldatas, excess.hash)).to.be.revertedWith("Native funds reserved");
    await expect(receiver.claim(s.vault)).to.be.revertedWith("Native transfer failed");
    expect(await s.vault.refundCredit(receiver)).to.equal(credit);
    await receiver.configure(false, ethers.ZeroAddress, "0x");
    await receiver.claim(s.vault);
    expect(await ethers.provider.getBalance(receiver)).to.equal(credit);
    expect(await s.vault.refundLiability()).to.equal(0);
    await expect(receiver.claim(s.vault)).to.be.revertedWith("No refund credit");
  });

  for (const target of ["governor", "vault"] as const) {
    it(`rejects refund reentry into the ${target} and pays a contract caller rather than tx.origin`, async function () {
      const s = await loadFixture(ready), receiver = await (await ethers.getContractFactory("RedemptionCaller")).deploy(), { action: a } = s;
      const data = target === "governor" ? s.governor.interface.encodeFunctionData("execute", [[], [], [], ethers.ZeroHash]) : s.vault.interface.encodeFunctionData("claimRedemptionRefund");
      await receiver.configure(false, await s[target].getAddress(), data);
      await receiver.execute(s.governor, a.targets, a.values, a.calldatas, a.hash, { gasPrice: priceCap, gasLimit: 1_500_000 });
      expect(await receiver.reentryAccepted()).to.equal(false);
      expect(await receiver.reentryAttempted()).to.equal(true);
      // A callback that exceeds the bounded delivery gas becomes credit rather than reverting redemption.
      expect(await ethers.provider.getBalance(receiver) + await s.vault.refundCredit(receiver)).to.be.greaterThan(0);
      expect(await s.vault.redemptionRefunded(a.id)).to.equal(true);
      expect(await s.vault.refundCredit(s.owner)).to.equal(0);
    });
  }

  it("gives a ready redemption a direct Governor resolver payload", async function () {
    const s = await loadFixture(ready), { action: a } = s;
    expect((await s.automation.checker(a.targets, a.values, a.calldatas, a.hash))[0]).to.equal(false);
    const [canExec, target, payload] = await s.automation.redemptionChecker(a.targets, a.values, a.calldatas, a.hash);
    expect(canExec).to.equal(true);
    expect(target).to.equal(await s.governor.getAddress());
    expect(payload).to.equal(s.governor.interface.encodeFunctionData("execute", [a.targets, a.values, a.calldatas, a.hash]));
    await expect(s.automation.advance(a.targets, a.values, a.calldatas, a.hash)).to.be.revertedWith("Execute redemption directly on governor");
    await s.caller.sendTransaction({ to: await s.governor.getAddress(), data: payload, gasPrice: priceCap });
    expect(await s.vault.redemptionRefunded(a.id)).to.equal(true);
  });

  it("does not reimburse unrelated operations or batched redemption", async function () {
    const s = await loadFixture(ready);
    expect(await s.vault.redemptionGasBudget()).to.equal(budget);
    const redeem = s.vault.interface.encodeFunctionData("redeem", [s.market]);
    const withdraw = s.vault.interface.encodeFunctionData("withdrawCollateral", [s.other.address, 1]);
    const hash = ethers.id("Batch without reimbursement"), targets = [await s.vault.getAddress(), await s.vault.getAddress()], values = [0, 0], calldatas = [redeem, withdraw];
    await s.governor.proposeWithTopic(targets, values, calldatas, "Batch without reimbursement", s.market);
    const id = await s.governor.hashProposal(targets, values, calldatas, hash);
    await mine(2);
    await s.governor.castVote(id, 1);
    await s.governor.queue(targets, values, calldatas, hash);
    await time.increase(30);
    await s.governor.connect(s.caller).execute(targets, values, calldatas, hash);
    expect(await s.vault.redemptionGasBudget()).to.equal(budget);
    expect(await s.vault.redemptionRefunded(id)).to.equal(false);
  });

  it("does not persist a simulated refund or refund a directly executed Timelock operation", async function () {
    const s = await loadFixture(ready), { action: a } = s;
    await s.governor.connect(s.caller).execute.staticCall(a.targets, a.values, a.calldatas, a.hash, { gasPrice: priceCap });
    expect(await s.vault.redemptionGasBudget()).to.equal(budget);
    expect(await s.vault.redemptionRefunded(a.id)).to.equal(false);
    const salt = ethers.toBeHex((BigInt(await s.governor.getAddress()) << 96n) ^ BigInt(a.hash), 32);
    await s.timelock.connect(s.caller).executeBatch(a.targets, a.values, a.calldatas, ethers.ZeroHash, salt);
    expect(await s.governor.state(a.id)).to.equal(7);
    expect(await s.vault.redemptionGasBudget()).to.equal(budget);
    await expect(execute(s)).to.be.reverted;
  });

  it("rejects an incorrect condition mapping during governed execution", async function () {
    const s = await loadFixture(fixture);
    await s.positions.prepare(ethers.toBeHex(s.second, 32), 2);
    await s.positions.resolve(ethers.toBeHex(s.second, 32), 1, 0);
    await configure(s);
    const action = await queueAction({ ...s, market: s.second }, s.vault.interface.encodeFunctionData("redeem", [s.second]), "Incorrect registered outcomes");
    await expect(execute({ ...s, action })).to.be.revertedWith("Wrong condition outcomes");
    expect(await s.vault.redemptionGasBudget()).to.equal(budget);
    expect(await s.vault.redemptionRefunded(action.id)).to.equal(false);
  });
});
