import { expect } from "chai";
import { ethers } from "hardhat";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { RedemptionSigner, type RedemptionJournal } from "../scripts/redemption-journal";

// Run with hardhat.fork.config.ts: local chain 137, without a remote fork or any real key.
describe("Live redemption signed-byte journal", function () {
  const feeCap = ethers.parseUnits("10", "gwei");

  async function fixture(save?: (state: RedemptionJournal) => void, budget = ethers.parseEther("1")) {
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await setBalance(wallet.address, ethers.parseEther("10"));
    const state: RedemptionJournal = { planHash: ethers.id("journal test"), snapshots: {}, transactions: {} };
    const signer = new RedemptionSigner(wallet, state, () => save?.(state), true, feeCap, budget);
    return { wallet, state, signer, recipient: (await ethers.getSigners())[1].address };
  }

  it("saves the exact bytes before broadcasting, resumes the same nonce and rejects changed requests", async function () {
    const saved: RedemptionJournal[] = [], s = await fixture(state => saved.push(JSON.parse(JSON.stringify(state))));
    const request = { to: s.recipient, value: 123n };
    const tx = await s.signer.named("fund", () => s.signer.sendTransaction(request));
    const first = saved[0].transactions.fund;
    expect(first.receipt).to.equal(undefined);
    expect(ethers.keccak256(first.raw!)).to.equal(tx.hash);
    expect(ethers.Transaction.from(first.raw!).from).to.equal(s.wallet.address);
    expect(ethers.Transaction.from(first.raw!).chainId).to.equal(137n);
    expect(saved[1].transactions.fund.receipt!.status).to.equal(1);
    const nonce = await s.wallet.getNonce();
    const repeat = await s.signer.named("fund", () => s.signer.sendTransaction(request));
    expect(repeat.hash).to.equal(tx.hash);
    expect(await s.wallet.getNonce()).to.equal(nonce);
    await expect(s.signer.named("fund", () => s.signer.sendTransaction({ ...request, value: 124n }))).to.be.rejectedWith("request changed");
    expect(await s.wallet.getNonce()).to.equal(nonce);
  });

  it("never broadcasts when persistence fails, including another attempt in the same process", async function () {
    const s = await fixture(() => { throw new Error("Persistence failed"); });
    const nonce = await s.wallet.getNonce();
    for (let i = 0; i < 2; i++) {
      await expect(s.signer.named("fund", () => s.signer.sendTransaction({ to: s.recipient, value: 1n }))).to.be.rejectedWith("Persistence failed");
      expect(await s.wallet.getNonce()).to.equal(nonce);
      expect(Object.keys(s.state.transactions)).to.have.length(0);
    }
  });

  it("enforces the cumulative network fee limit before signing or sending", async function () {
    const s = await fixture(undefined, 0n), nonce = await s.wallet.getNonce();
    await expect(s.signer.named("fund", () => s.signer.sendTransaction({ to: s.recipient }))).to.be.rejectedWith("gas budget exhausted");
    expect(await s.wallet.getNonce()).to.equal(nonce);
    expect(Object.keys(s.state.transactions)).to.have.length(0);
  });

  it("keeps snapshots stable when a resumed run sees changed balances", async function () {
    const s = await fixture();
    expect(await s.signer.snapshot("balance", async () => "100")).to.equal("100");
    expect(await s.signer.snapshot("balance", async () => "200")).to.equal("100");
  });
});
