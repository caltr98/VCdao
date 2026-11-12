import { expect } from "chai";
import { createHmac } from "node:crypto";
import { ethers, network } from "hardhat";
import { impersonateAccount, loadFixture, mine, setBalance, time } from "@nomicfoundation/hardhat-network-helpers";
import { localSystem, proposal, MARKET, UNIT } from "../scripts/local";
import { authHeaders, boundedJson, checkOrderShape, classifyOrderResponse, orderBody, postOnce, readVenueOrder, validateBook } from "../automation/src/transport";
import { emptyState, parseConfig, parseSettings, type RunnerState, type Settings } from "../automation/src/config";
import { currentFees, discover, reconcilePending, sendAction, signerFor, type ChainProvider, type TransactionContext } from "../automation/src/chain";
import { CLEANUP_GAS_LIMIT, runTick, type Storage } from "../automation/src/runner";
import { orderObject } from "../scripts/order";

const credentials = { address: "0x1111111111111111111111111111111111111111", key: "test-key", secret: Buffer.from("test secret").toString("base64"), passphrase: "test-passphrase" };
const book = (tokenId: bigint) => ({ asset_id: tokenId.toString(), neg_risk: false, tick_size: "0.01", min_order_size: "5" });

// A store that behaves like Durable Object storage: every load returns a copy of the last save.
function memoryStorage(): Storage & { saved(): RunnerState | undefined } {
  let saved: RunnerState | undefined;
  return { load: async () => saved && structuredClone(saved), save: async state => { saved = structuredClone(state); }, saved: () => saved };
}

// Same provider, but every broadcast fails as if the RPC connection dropped.
function offline(provider: ChainProvider): ChainProvider {
  return new Proxy(provider, { get(target, key) {
    if (key === "broadcastTransaction") return async () => { throw Object.assign(new Error("connection dropped"), { code: "NETWORK_ERROR" }); };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

// The upstream superquorum can end voting early, so only vote while the proposal is Active.
async function vote(governor: Awaited<ReturnType<typeof localSystem>>["governor"], voters: Awaited<ReturnType<typeof localSystem>>["alice"][], id: bigint) {
  for (const voter of voters) if (await governor.state(id) === 1n) await governor.connect(voter).castVote(id, 1);
}

// Same provider, but the node refuses the first `count` broadcasts as underpriced.
function refusing(provider: ChainProvider, count = Infinity): ChainProvider {
  let refused = 0;
  return new Proxy(provider, { get(target, key) {
    if (key === "broadcastTransaction" && refused < count) return async () => { refused++; throw Object.assign(new Error("transaction underpriced"), { code: "UNKNOWN_ERROR" }); };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

async function fundedSigner() {
  const signer = ethers.Wallet.createRandom();
  await setBalance(signer.address, ethers.parseEther("10"));
  return signer;
}

describe("Hosted order transport boundaries", function () {
  async function ready() {
    const system = await localSystem();
    const address = await system.timelock.getAddress();
    await impersonateAccount(address);
    await setBalance(address, ethers.parseEther("1"));
    const controller = await ethers.getSigner(address);
    const id = ethers.id("transport-test");
    await system.vault.connect(controller).authorizeOrder(id, { market: MARKET, tokenId: 11, principal: 50n * UNIT, shares: 100n * UNIT, feeBudget: UNIT, deadline: (await time.latest()) + 3600, exchange: await system.exchange.getAddress() });
    const wallet = await ethers.getContractAt("OrderWallet", await system.vault.orderWallets(id));
    const digest = await wallet.orderHash();
    return { order: orderObject(await wallet.getOrder()), digest, target: { digest, wallet: await wallet.getAddress(), exchange: await system.exchange.getAddress() } };
  }

  it("posts an SDK-safe salt exactly and binds authentication to the exact HTTP bytes", async function () {
    const { order } = await loadFixture(ready);
    const body = orderBody(order, credentials.key);
    expect(order.salt <= BigInt(Number.MAX_SAFE_INTEGER)).to.equal(true);
    expect(body).to.include(`"salt":${order.salt.toString()},`);
    expect(JSON.parse(body).order.salt).to.equal(Number(order.salt));
    expect(JSON.parse(body).postOnly).to.equal(false);
    expect(JSON.parse(body).order.signature).to.equal("0x01");
    const expected = createHmac("sha256", Buffer.from("test secret")).update("100POST/order" + body).digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
    expect(authHeaders(credentials, "100", "POST", "/order", body).POLY_SIGNATURE).to.equal(expected);
  });

  it("journals before POST and never repeats an accepted order", async function () {
    const { order, digest, target } = await loadFixture(ready);
    const state = emptyState();
    let posts = 0, saves = 0;
    const journal = { async save() { saves++; } };
    const request: typeof fetch = async (_url, options) => {
      if (options?.method !== "POST") return Response.json({ blocked: false });
      expect(options.redirect).to.equal("manual");
      expect(saves).to.equal(1);
      expect(state.attempts[digest].status).to.equal("posting");
      posts++;
      return Response.json({ success: true, errorMsg: "", orderID: digest, status: "live" });
    };
    expect(await postOnce(order, target, credentials, state, journal, request)).to.equal("accepted");
    expect(await postOnce(order, target, credentials, state, journal, request)).to.equal("already-attempted");
    expect(posts).to.equal(1);
  });

  it("validates the live book's token, exchange, tick, size decimals and price range with exact arithmetic", async function () {
    const { order } = await loadFixture(ready);
    await validateBook(order, false, async () => Response.json(book(order.tokenId)));
    for (const changed of [{ asset_id: "12" }, { neg_risk: true }, { min_order_size: "101" }, { tick_size: "0.03" }]) {
      await expect(validateBook(order, false, async () => Response.json({ ...book(order.tokenId), ...changed }))).to.be.rejected;
    }
    const tick = 10_000n, minimum = 5n * UNIT;
    expect(() => checkOrderShape({ makerAmount: 50n * UNIT, takerAmount: 100n * UNIT + 1_000n }, tick, minimum)).to.throw("two decimals");
    expect(() => checkOrderShape({ makerAmount: 100n * UNIT, takerAmount: 100n * UNIT }, tick, minimum)).to.throw("tradable range");
    expect(() => checkOrderShape({ makerAmount: 5_735_000n, takerAmount: 15_500_000n }, tick, minimum)).to.throw("Principal must have at most two decimals");
    checkOrderShape({ makerAmount: 99n * UNIT, takerAmount: 100n * UNIT }, tick, minimum);
  });

  it("keeps a timed-out attempt unknown and refuses to blindly resubmit after reload", async function () {
    const { order, target } = await loadFixture(ready);
    const state = emptyState();
    let persisted = state, posts = 0;
    const journal = { async save(value: typeof state) { persisted = structuredClone(value); } };
    const request: typeof fetch = async (_url, options) => {
      if (options?.method !== "POST") return Response.json({ blocked: false });
      posts++;
      throw new Error("Connection dropped after server may have accepted order");
    };
    expect(await postOnce(order, target, credentials, state, journal, request)).to.equal("unknown");
    expect(await postOnce(order, target, credentials, persisted, journal, request)).to.equal("already-attempted");
    expect(posts).to.equal(1);
  });

  it("does not post if trading availability or durable persistence fails", async function () {
    const { order, target } = await loadFixture(ready);
    let posts = 0;
    const request: typeof fetch = async (_url, options) => { if (options?.method === "POST") posts++; return Response.json({ blocked: true }); };
    await expect(postOnce(order, target, credentials, emptyState(), { async save() {} }, request)).to.be.rejectedWith("Trading availability");
    const permitted: typeof fetch = async (_url, options) => { if (options?.method === "POST") posts++; return Response.json({ blocked: false }); };
    await expect(postOnce(order, target, credentials, emptyState(), { async save() { throw new Error("Storage unavailable"); } }, permitted)).to.be.rejectedWith("Storage unavailable");
    expect(posts).to.equal(0);
  });

  it("classifies responses like the official SDK and keeps diagnostics free of credentials", async function () {
    const digest = ethers.id("digest");
    const cases = [
      [200, { success: true, errorMsg: "", orderID: digest, status: "matched" }, "accepted", "matched"],
      [200, { success: false, errorMsg: "order couldn't be fully filled. FOK orders are fully filled or killed.", orderID: "", status: "" }, "rejected", "fok_not_filled"],
      [200, { success: true, errorMsg: "", orderID: digest, status: "unmatched" }, "rejected", "unmatched"],
      [400, { error: `invalid signer for api key ${credentials.key}` }, "rejected", "HTTP_400"],
      [503, {}, "unknown", "HTTP_503"],
      [403, undefined, "rejected", "HTTP_403"],
      [200, undefined, "unknown", "HTTP_200"],
      [200, "OK", "unknown", "HTTP_200"],
      [200, {}, "unknown", "HTTP_200"],
      [307, undefined, "unknown", "HTTP_307"],
      [200, { success: true, errorMsg: "", orderID: ethers.ZeroHash, status: "live" }, "unknown", "ORDER_ID_MISMATCH"],
    ] as const;
    for (const [httpStatus, result, status, code] of cases) {
      expect(classifyOrderResponse(httpStatus, result, digest, credentials)).to.include({ status, code });
    }
    const rejected = classifyOrderResponse(400, { error: `invalid signer for api key ${credentials.key}` }, digest, credentials);
    expect(rejected.message).to.equal("invalid signer for api key [redacted]");
  });

  it("reads the CLOB record by digest with account authentication", async function () {
    const digest = ethers.id("digest");
    let headers: Record<string, string> = {};
    const found: typeof fetch = async (url, options) => {
      headers = options?.headers as Record<string, string>;
      expect(options?.redirect).to.equal("manual");
      expect(String(url)).to.equal(`https://clob.polymarket.com/data/order/${digest}`);
      return Response.json({ id: digest, status: "MATCHED", size_matched: "100", original_size: "100" });
    };
    expect(await readVenueOrder(digest, credentials, found)).to.deep.equal({ status: "MATCHED", sizeMatched: "100", originalSize: "100" });
    expect(headers.POLY_SIGNATURE).to.equal(authHeaders(credentials, headers.POLY_TIMESTAMP, "GET", `/data/order/${digest}`).POLY_SIGNATURE);
    expect(await readVenueOrder(digest, credentials, async () => new Response("null"))).to.deep.equal({ status: "not-found" });
    expect(await readVenueOrder(digest, credentials, async () => new Response("", { status: 404 }))).to.deep.equal({ status: "not-found" });
    await expect(readVenueOrder(digest, credentials, async () => Response.json({ id: ethers.ZeroHash }))).to.be.rejectedWith("another order");
  });

  it("limits external response size and rejects unconfirmed deployment configuration", async function () {
    await expect(boundedJson(new Response("x".repeat(1_048_577)))).to.be.rejectedWith("exceeded limit");
    expect(parseConfig("")).to.equal(undefined);
    const config = { governor: credentials.address, vault: credentials.address, automation: credentials.address, startBlock: 123 };
    expect(parseConfig(JSON.stringify(config))?.confirmations).to.equal(32);
    expect(() => parseConfig(JSON.stringify({ ...config, confirmations: 0 }))).to.throw("confirmations");
    const vars = { DAO_CONFIG: "", EXECUTION_ENABLED: "true", ORDER_SUBMISSION_ENABLED: "false", MAX_TOTAL_GAS_WEI: "10" };
    expect(() => parseSettings(vars)).to.throw("Missing gas signer");
    expect(() => parseSettings({ ...vars, EXECUTION_ENABLED: "false", MAX_TOTAL_GAS_WEI: "1e18" })).to.throw("integer wei");
    expect(() => parseConfig(`{"governor":"${credentials.secret}"`)).to.throw("DAO_CONFIG is not valid JSON");
  });
});

describe("Hosted transaction lifecycle", function () {
  async function token() {
    return (await ethers.getContractFactory("MockCollateral")).deploy();
  }

  function context(provider: ChainProvider, signer: { address: string; privateKey: string }, state: RunnerState, capWei: bigint, live = true): TransactionContext {
    const config = { governor: signer.address, vault: signer.address, automation: signer.address, startBlock: 1, confirmations: 32 };
    return { provider, config, state, journal: { async save() {} }, capWei, live, signer: signerFor(signer.privateKey, provider) };
  }

  it("persists exact bytes before broadcast, reserves the worst case and settles the actual fee", async function () {
    const mock = await loadFixture(token);
    const signer = await fundedSigner();
    const data = mock.interface.encodeFunctionData("mint", [signer.address, 1]);
    const state = emptyState();
    let persisted = state;
    const balancesAtSave: bigint[] = [];
    const ctx = { ...context(ethers.provider, signer, state, 0n), journal: { async save(value: RunnerState) { persisted = structuredClone(value); balancesAtSave.push(await mock.balanceOf(signer.address)); } } };
    await expect(sendAction(ctx, "test", await mock.getAddress(), data)).to.be.rejectedWith("gas budget");
    expect(state.pending).to.equal(undefined);
    ctx.capWei = ethers.parseEther("1");
    await sendAction(ctx, "test", await mock.getAddress(), data);
    expect(persisted.pending?.versions[0].hash).to.equal(ethers.keccak256(persisted.pending!.versions[0].raw));
    // Saved before the broadcast (nothing minted yet) and again after it.
    expect(balancesAtSave).to.deep.equal([0n, 1n]);
    expect(await mock.balanceOf(signer.address)).to.equal(1);
    await expect(sendAction(ctx, "test", await mock.getAddress(), data)).to.be.rejectedWith("Pending transaction");
    expect(await reconcilePending(ctx)).to.equal(true);
    await mine(33);
    const receipt = await ethers.provider.getTransactionReceipt(state.pending!.versions[0].hash);
    expect(await reconcilePending(ctx)).to.equal(false);
    expect(state.pending).to.equal(undefined);
    expect(state.spentWei).to.equal(receipt!.fee.toString());
  });

  it("never broadcasts, or rebroadcasts, while execution is disabled", async function () {
    const mock = await loadFixture(token);
    const signer = await fundedSigner();
    const state = emptyState();
    await sendAction(context(offline(ethers.provider), signer, state, ethers.parseEther("1")), "test", await mock.getAddress(), mock.interface.encodeFunctionData("mint", [signer.address, 1]));
    const hash = state.pending!.versions[0].hash;
    expect(await ethers.provider.getTransaction(hash)).to.equal(null);
    expect(await reconcilePending(context(ethers.provider, signer, state, ethers.parseEther("1"), false))).to.equal(true);
    expect(await ethers.provider.getTransaction(hash)).to.equal(null);
    expect(await reconcilePending(context(ethers.provider, signer, state, ethers.parseEther("1")))).to.equal(true);
    expect((await ethers.provider.getTransactionReceipt(hash))?.status).to.equal(1);
  });

  it("replaces an underpriced pending transaction with the same nonce and bounded fees", async function () {
    const mock = await loadFixture(token);
    const signer = await fundedSigner();
    const state = emptyState();
    const ctx = context(ethers.provider, signer, state, ethers.parseEther("1"));
    await network.provider.send("evm_setAutomine", [false]);
    try {
      await sendAction(ctx, "test", await mock.getAddress(), mock.interface.encodeFunctionData("mint", [signer.address, 1]));
      const first = state.pending!.versions[0];
      await network.provider.send("hardhat_setNextBlockBaseFeePerGas", [ethers.toQuantity(BigInt(first.maxFeePerGas) * 100n)]);
      await mine(31);
      expect(await reconcilePending(ctx)).to.equal(true);
      const second = state.pending!.versions[1];
      expect(BigInt(second.maxFeePerGas) * 1000n).to.be.gte(BigInt(first.maxFeePerGas) * 1125n);
      expect(state.pending!.reservedWei).to.equal((BigInt(state.pending!.gasLimit) * BigInt(second.maxFeePerGas)).toString());
      await mine(1);
      expect((await ethers.provider.getTransactionReceipt(second.hash))?.status).to.equal(1);
      expect(await ethers.provider.getTransactionReceipt(first.hash)).to.equal(null);
    } finally { await network.provider.send("evm_setAutomine", [true]); }
    await mine(33);
    expect(await reconcilePending(ctx)).to.equal(false);
    expect(await mock.balanceOf(signer.address)).to.equal(1);
  });

  it("releases a nonce another sender used at confirmed depth", async function () {
    const mock = await loadFixture(token);
    const signer = await fundedSigner();
    const state = emptyState();
    await sendAction(context(offline(ethers.provider), signer, state, ethers.parseEther("1")), "test", await mock.getAddress(), mock.interface.encodeFunctionData("mint", [signer.address, 1]));
    await signer.connect(ethers.provider).sendTransaction({ to: signer.address, nonce: state.pending!.nonce });
    await mine(33);
    expect(await reconcilePending(context(ethers.provider, signer, state, ethers.parseEther("1")))).to.equal(false);
    expect(state.pending).to.equal(undefined);
    expect(state.notices[state.notices.length - 1]).to.include("used by another transaction");
  });

  it("counts a mined revert against its label and settles the fee it cost", async function () {
    const mock = await loadFixture(token);
    const [, helper] = await ethers.getSigners();
    const signer = await fundedSigner();
    await mock.mint(signer.address, 1);
    await mock.connect(signer.connect(ethers.provider)).approve(helper.address, 1);
    const state = emptyState();
    const ctx = context(ethers.provider, signer, state, ethers.parseEther("1"));
    await network.provider.send("evm_setAutomine", [false]);
    try {
      await sendAction(ctx, "test", await mock.getAddress(), mock.interface.encodeFunctionData("transfer", [helper.address, 1]));
      // A better-paying transaction takes the balance first, so the simulated transfer reverts when mined.
      await mock.connect(helper).transferFrom(signer.address, helper.address, 1, { maxPriorityFeePerGas: ethers.parseUnits("50", "gwei"), maxFeePerGas: ethers.parseUnits("100", "gwei") });
      await mine(1);
    } finally { await network.provider.send("evm_setAutomine", [true]); }
    const receipt = await ethers.provider.getTransactionReceipt(state.pending!.versions[0].hash);
    expect(receipt?.status).to.equal(0);
    await mine(33);
    expect(await reconcilePending(ctx)).to.equal(false);
    expect(state.reverts).to.deep.equal({ test: 1 });
    expect(state.spentWei).to.equal(receipt!.fee.toString());
  });

  it("reprices a transaction the node refused instead of resending the same bytes", async function () {
    const mock = await loadFixture(token);
    const signer = await fundedSigner();
    const state = emptyState();
    const provider = refusing(ethers.provider, 1);
    const ctx = context(provider, signer, state, ethers.parseEther("1"));
    await sendAction(ctx, "test", await mock.getAddress(), mock.interface.encodeFunctionData("mint", [signer.address, 1]));
    expect(state.pending!.refused).to.equal("UNKNOWN_ERROR");
    expect(await reconcilePending(ctx)).to.equal(true);
    const [first, second] = state.pending!.versions;
    expect(state.pending!.refused).to.equal(undefined);
    expect(BigInt(second.maxPriorityFeePerGas) * 1000n).to.be.gte(BigInt(first.maxPriorityFeePerGas) * 1125n);
    expect((await ethers.provider.getTransactionReceipt(second.hash))?.status).to.equal(1);
    await mine(33);
    expect(await reconcilePending(ctx)).to.equal(false);
    expect(await mock.balanceOf(signer.address)).to.equal(1);
  });

  it("cancels a governance transaction whose repricing would spend the cleanup reserve", async function () {
    const mock = await loadFixture(token);
    const signer = await fundedSigner();
    const state = emptyState();
    const keepWei = ethers.parseEther("0.001");
    const ctx = context(ethers.provider, signer, state, ethers.parseEther("1"));
    await network.provider.send("evm_setAutomine", [false]);
    try {
      await sendAction(ctx, "advance:test", await mock.getAddress(), mock.interface.encodeFunctionData("mint", [signer.address, 1]), keepWei);
      const first = state.pending!.versions[0];
      // Exactly the reservation plus the reserve: any repricing of the mint would eat into the reserve.
      ctx.capWei = BigInt(state.pending!.reservedWei) + keepWei;
      await network.provider.send("hardhat_setNextBlockBaseFeePerGas", [ethers.toQuantity(BigInt(first.maxFeePerGas) * 100n)]);
      await mine(31);
      expect(await reconcilePending(ctx)).to.equal(true);
      expect(state.pending).to.deep.include({ label: "cancel:advance:test", to: signer.address, data: "0x", gasLimit: "21000", keepWei: "0" });
      await mine(1);
      expect((await ethers.provider.getTransactionReceipt(state.pending!.versions[1].hash))?.status).to.equal(1);
    } finally { await network.provider.send("evm_setAutomine", [true]); }
    await mine(33);
    expect(await reconcilePending(ctx)).to.equal(false);
    expect(await mock.balanceOf(signer.address)).to.equal(0);
    expect(BigInt(state.spentWei)).to.be.lte(ctx.capWei - keepWei);
  });

  it("discovers Governor proposals only after the confirmation delay and rescans after a changed cursor", async function () {
    const system = await loadFixture(localSystem);
    const startBlock = await ethers.provider.getBlockNumber();
    const data = system.vault.interface.encodeFunctionData("withdrawCollateral", [system.alice.address, 1]);
    await system.governor.connect(system.alice).proposeWithTopic([system.vault], [0], [data], "Discovery test", MARKET);
    const config = { governor: await system.governor.getAddress(), vault: await system.vault.getAddress(), automation: await system.automation.getAddress(), startBlock, confirmations: 32 };
    const state = emptyState(), journal = { async save() {} };
    await discover(config, ethers.provider, state, journal);
    expect(state.proposals).to.have.length(0);
    await mine(34);
    await discover(config, ethers.provider, state, journal);
    expect(state.proposals).to.have.length(1);
    expect(state.proposals[0].values).to.deep.equal(["0"]);
    expect(state.proposals[0].descriptionHash).to.equal(ethers.id("Discovery test"));
    state.cursor!.hash = ethers.ZeroHash;
    await discover(config, ethers.provider, state, journal);
    expect(state.notices[state.notices.length - 1]).to.include("rescanning");
    expect(state.proposals).to.have.length(1);
    expect(state.cursor!.hash).to.not.equal(ethers.ZeroHash);
  });
});

describe("Configured hosted runner", function () {
  async function configured() {
    const system = await localSystem();
    const gas = await fundedSigner();
    const config = { governor: await system.governor.getAddress(), vault: await system.vault.getAddress(), automation: await system.automation.getAddress(), startBlock: await ethers.provider.getBlockNumber(), confirmations: 32 };
    const profile = { chainId: 31337n, collateral: await system.collateral.getAddress(), positions: await system.positions.getAddress(), exchange: await system.exchange.getAddress(), negRiskExchange: await system.negativeRiskExchange.getAddress() };
    const settings: Settings = { config, execution: true, submission: true, gasCapWei: ethers.parseEther("1"), gasKey: gas.privateKey, clobCredentials: JSON.stringify(credentials) };
    return { ...system, gas, config, profile, settings };
  }

  // The venue recomputes the digest from the posted JSON, so the salt must survive serialization exactly.
  function venue(exchange: Awaited<ReturnType<typeof configured>>["exchange"], tokenId: bigint) {
    const posted = new Map<string, string>();
    const request: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "polymarket.com") return Response.json({ blocked: false });
      if (url.pathname === "/book") return Response.json(book(tokenId));
      if (init?.method === "POST") return acceptOrder(String(init.body));
      const id = url.pathname.replace("/data/order/", "");
      return posted.has(id) ? Response.json({ id, status: "LIVE", size_matched: "0", original_size: "100" }) : new Response("null");
    };
    async function acceptOrder(body: string) {
      const { order } = JSON.parse(body);
      const digest = await exchange.hashOrder({ ...order, salt: BigInt(body.match(/"salt":(\d+)/)![1]), side: 0 });
      posted.set(digest, body);
      return Response.json({ success: true, errorMsg: "", orderID: digest, status: "live", makingAmount: "", takingAmount: "" });
    }
    return { request, posted };
  }

  async function tickAfter(blocks: number, settings: Settings, deps: Parameters<typeof runTick>[1]) {
    await mine(blocks);
    return runTick(settings, deps);
  }

  it("discovers, advances, posts once, reconciles and collects without a privileged caller", async function () {
    const system = await loadFixture(configured);
    const { settings, profile, vault, governor, alice, bob, collateral, positions } = system;
    const id = ethers.id("hosted-order");
    const buy = { market: MARKET, tokenId: 11n, principal: 50n * UNIT, shares: 100n * UNIT, feeBudget: 2n * UNIT, deadline: (await time.latest()) + 7200, exchange: profile.exchange };
    const action = await proposal(governor, alice, await vault.getAddress(), vault.interface.encodeFunctionData("authorizeOrder", [id, buy]));
    const storage = memoryStorage();
    const clob = venue(system.exchange, buy.tokenId);
    const deps = { provider: ethers.provider, storage, network: profile, request: clob.request };
    await vote(governor, [alice, bob], action.id);
    const queued = await tickAfter(40, settings, deps);
    expect(queued.transaction?.label).to.equal(`advance:${action.id}:4`);
    expect(await governor.state(action.id)).to.equal(5);
    await time.increase(10);
    expect((await tickAfter(33, settings, deps)).transaction?.label).to.equal(`advance:${action.id}:5`);
    const wallet = await ethers.getContractAt("OrderWallet", await vault.orderWallets(id));
    const digest = await wallet.orderHash();
    const posting = await tickAfter(33, settings, deps);
    expect(posting.issues).to.deep.equal([]);
    expect(posting.orderPosted).to.equal(digest);
    expect(clob.posted.has(digest)).to.equal(true);
    await system.exchange.fill(orderObject(await wallet.getOrder()), buy.principal, buy.shares, UNIT);
    const collecting = await runTick(settings, deps);
    expect(collecting.orders![digest]).to.deep.include({ status: "accepted" });
    expect(collecting.orders![digest].settlement).to.deep.include({ filled: true, remaining: "0" });
    expect(collecting.orders![digest].venue).to.deep.include({ status: "LIVE" });
    expect(collecting.transaction?.label).to.equal(`collect:${await wallet.getAddress()}`);
    const done = await tickAfter(33, settings, deps);
    expect(done).to.deep.include({ status: "ok", counts: { proposals: 0, orderWallets: 0 } });
    expect(done.gas).to.deep.include({ reservedWei: "0" });
    expect(clob.posted.size).to.equal(1);
    expect(await positions.balanceOf(vault, buy.tokenId)).to.equal(buy.shares);
    expect(await collateral.balanceOf(vault)).to.equal(949n * UNIT);
    const json = JSON.stringify(done);
    for (const secret of [system.gas.privateKey, credentials.key, credentials.secret, credentials.passphrase]) expect(json).to.not.include(secret);
  });

  it("reports ready work without sending anything in read-only mode", async function () {
    const system = await loadFixture(configured);
    const { profile, vault, governor, alice, bob } = system;
    const data = vault.interface.encodeFunctionData("withdrawCollateral", [alice.address, UNIT]);
    const action = await proposal(governor, alice, await vault.getAddress(), data);
    await vote(governor, [alice, bob], action.id);
    const storage = memoryStorage();
    const report = await tickAfter(40, { ...system.settings, execution: false, submission: false }, { provider: ethers.provider, storage, network: profile });
    expect(report).to.deep.include({ mode: "read-only", status: "ok" });
    expect(report.ready!.governance).to.deep.equal([action.id.toString()]);
    expect(report.transaction).to.equal(undefined);
    expect(storage.saved()!.pending).to.equal(undefined);
    expect(await governor.state(action.id)).to.equal(4);
  });

  it("keeps cleaning up when discovery fails and skips a failing proposal for the next ready one", async function () {
    const system = await loadFixture(configured);
    const { profile, vault, governor, alice, bob, settings } = system;
    const failing = await proposal(governor, alice, await vault.getAddress(), vault.interface.encodeFunctionData("withdrawCollateral", [alice.address, 2000n * UNIT]), MARKET, "Withdraw more than the treasury holds");
    const working = await proposal(governor, alice, await vault.getAddress(), vault.interface.encodeFunctionData("withdrawCollateral", [alice.address, UNIT]), MARKET, "Withdraw one unit");
    for (const action of [failing, working]) await vote(governor, [alice, bob], action.id);
    const storage = memoryStorage();
    const deps = { provider: ethers.provider, storage, network: profile };
    await tickAfter(40, settings, deps);
    await tickAfter(33, settings, deps);
    await time.increase(10);
    const executing = await tickAfter(33, settings, deps);
    expect(executing.issues.map(issue => issue.item)).to.deep.equal([failing.id.toString()]);
    // The code depends on the provider: ethers' JSON-RPC provider reports CALL_EXCEPTION, Hardhat's raw error does not.
    expect(executing.issues[0]).to.include({ stage: "governance", item: failing.id.toString() });
    expect(executing.transaction?.label).to.equal(`advance:${working.id}:5`);
    expect(await governor.state(working.id)).to.equal(7);
    // A wallet whose deadline passed must still be collected while log discovery is failing.
    const wallet = await authorizedWallet(system, 60);
    await time.increase(61);
    await mine(33);
    const state = storage.saved()!;
    await storage.save({ ...state, wallets: [await wallet.getAddress()] });
    const noLogs = new Proxy(ethers.provider, { get(target, key) {
      if (key === "getLogs") return async () => { throw Object.assign(new Error("range limit"), { code: "SERVER_ERROR" }); };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const cleanup = await runTick(settings, { ...deps, provider: noLogs });
    expect(cleanup.issues.map(issue => issue.stage)).to.include("event-discovery");
    expect(cleanup.transaction?.label).to.equal(`collect:${await wallet.getAddress()}`);
    expect(await wallet.state()).to.equal(2);
  });

  it("keeps the cleanup reserve for posted orders and stops retrying a step after two mined reverts", async function () {
    const system = await loadFixture(configured);
    const { profile, settings, automation } = system;
    const wallet = await authorizedWallet(system, 3600);
    const address = await wallet.getAddress();
    const digest = await wallet.orderHash();
    const action = await proposal(system.governor, system.alice, await system.vault.getAddress(), system.vault.interface.encodeFunctionData("withdrawCollateral", [system.alice.address, UNIT]));
    await vote(system.governor, [system.alice, system.bob], action.id);
    await mine(31);
    const cursor = { number: await ethers.provider.getBlockNumber(), hash: (await ethers.provider.getBlock("latest"))!.hash! };
    const proposals = [{ id: action.id.toString(), targets: action.targets, values: ["0"], calldatas: action.calldatas, descriptionHash: action.hash }];
    const posted = { [digest]: { digest, wallet: address, exchange: profile.exchange, status: "accepted" as const, attemptedAt: new Date().toISOString() } };
    // The cap is one wei short of the queue's reservation plus one cleanup reservation.
    const [, payload] = await automation.checker(action.targets, action.values, action.calldatas, action.hash);
    const fee = (await currentFees(ethers.provider)).maxFeePerGas;
    const queue = await ethers.provider.estimateGas({ from: system.gas.address, to: await automation.getAddress(), data: payload }) * 120n / 100n * fee;
    const tight = { ...settings, submission: false, gasCapWei: queue + CLEANUP_GAS_LIMIT * fee - 1n };
    const storage = memoryStorage();
    await storage.save({ ...emptyState(), cursor, wallets: [address], proposals, attempts: posted });
    const reserved = await runTick(tight, { provider: ethers.provider, storage, network: profile });
    expect(reserved.issues).to.deep.include({ stage: "governance", item: action.id.toString(), code: "CHECK_FAILED", reason: "Authorized gas budget exceeded" });
    expect(reserved.transaction).to.equal(undefined);
    const control = memoryStorage();
    await control.save({ ...emptyState(), cursor, wallets: [address], proposals });
    expect((await runTick(tight, { provider: ethers.provider, storage: control, network: profile })).transaction?.label).to.equal(`advance:${action.id}:4`);
    await mine(33);
    await time.increase(10);
    // Two mined reverts of the execute step hold it for review; a count on the queue step does not.
    const gated = memoryStorage();
    await gated.save({ ...emptyState(), cursor, proposals, reverts: { [`advance:${action.id}:5`]: 2 } });
    const review = await runTick(settings, { provider: ethers.provider, storage: gated, network: profile });
    expect(review.issues).to.deep.equal([{ stage: "governance", item: action.id.toString(), code: "CHECK_FAILED", reason: `advance:${action.id}:5 reverted 2 times; waiting for review` }]);
    expect(review.transaction).to.equal(undefined);
    const earlierStep = memoryStorage();
    await earlierStep.save({ ...emptyState(), cursor, proposals, reverts: { [`advance:${action.id}:4`]: 2 } });
    expect((await runTick(settings, { provider: ethers.provider, storage: earlierStep, network: profile })).transaction?.label).to.equal(`advance:${action.id}:5`);
    expect(await system.governor.state(action.id)).to.equal(7);
  });

  it("reports a stalled gas signer and posts nothing while the node refuses its transaction", async function () {
    const system = await loadFixture(configured);
    const expired = await authorizedWallet(system, 60);
    const open = await authorizedWallet(system, 3600);
    await time.increase(61);
    const storage = memoryStorage();
    await storage.save({ ...emptyState(), cursor: { number: await ethers.provider.getBlockNumber(), hash: (await ethers.provider.getBlock("latest"))!.hash! }, wallets: [await expired.getAddress(), await open.getAddress()] });
    const clob = venue(system.exchange, 11n);
    const deps = { provider: refusing(ethers.provider), storage, network: system.profile, request: clob.request };
    const first = await runTick(system.settings, deps);
    expect(first.transaction?.label).to.equal(`collect:${await expired.getAddress()}`);
    expect(first.issues).to.deep.include({ stage: "order-transport", code: "CHECK_FAILED", reason: "No new order while the gas signer's transaction is stalled" });
    const second = await runTick(system.settings, deps);
    expect(second.issues).to.deep.include({ stage: "pending-transaction", code: "CHECK_FAILED", reason: `collect:${await expired.getAddress()} is stalled: UNKNOWN_ERROR` });
    expect(storage.saved()!.pending!.versions).to.have.length(2);
    expect(clob.posted.size).to.equal(0);
    expect(await expired.state()).to.equal(0);
  });

  it("refuses to post an order the gas budget could not clean up", async function () {
    const system = await loadFixture(configured);
    const wallet = await authorizedWallet(system, 3600);
    const storage = memoryStorage();
    await storage.save({ ...emptyState(), cursor: { number: await ethers.provider.getBlockNumber(), hash: (await ethers.provider.getBlock("latest"))!.hash! }, wallets: [await wallet.getAddress()] });
    const clob = venue(system.exchange, 11n);
    const report = await runTick({ ...system.settings, gasCapWei: 1n }, { provider: ethers.provider, storage, network: system.profile, request: clob.request });
    expect(report.issues).to.deep.include({ stage: "order-transport", item: await wallet.getAddress(), code: "CHECK_FAILED", reason: "Gas budget cannot cover cleanup of another posted order" });
    expect(clob.posted.size).to.equal(0);
  });

  // Authorize directly through the Timelock: these tests start from an existing order wallet.
  async function authorizedWallet(system: Awaited<ReturnType<typeof configured>>, lifetime: number) {
    const address = await system.timelock.getAddress();
    await impersonateAccount(address);
    await setBalance(address, ethers.parseEther("1"));
    const id = ethers.id(`wallet-${lifetime}-${await ethers.provider.getBlockNumber()}`);
    await system.vault.connect(await ethers.getSigner(address)).authorizeOrder(id, { market: MARKET, tokenId: 11, principal: 50n * UNIT, shares: 100n * UNIT, feeBudget: UNIT, deadline: (await time.latest()) + lifetime, exchange: system.profile.exchange });
    return ethers.getContractAt("OrderWallet", await system.vault.orderWallets(id));
  }
});
