import type { Contract } from "ethers";
import { availableWei, contracts, currentFees, discover, reconcilePending, sendAction, signerFor, validateDeployment, type ChainProvider, type NetworkProfile, type TransactionContext } from "./chain";
import { CheckFailure, describeError, emptyState, type Credentials, type DaoConfig, type Issue, type Journal, type OrderAttempt, type Proposal, type RunnerState, type Settings } from "./config";
import { parseCredentials, postOnce, readVenueOrder, validateBook } from "./transport";
import { orderObject, type OrderFields } from "../../scripts/order";
import { sameAddress } from "../../scripts/addresses";

export type Storage = Journal & { load(): Promise<RunnerState | undefined> };
export type RunnerDeps = { provider: ChainProvider; storage: Storage; network: NetworkProfile; request?: typeof fetch };

/// Public status: addresses, digests, codes and revert reasons, never keys, credentials or RPC URLs.
export type Report = {
  checkedAt: string;
  status: "needs-deployment-config" | "run-failed" | "ok" | "attention";
  mode?: "read-only" | "execution" | "execution+submission";
  phase?: string; errorCode?: string; reason?: string;
  gasSigner?: string;
  transaction?: { label: string; hash: string };
  pending?: { label: string; nonce: number; hashes: string[] };
  ready?: { collection: string[]; governance: string[] };
  orderPosted?: string;
  orders?: Record<string, Omit<OrderAttempt, "digest">>;
  gas?: { capWei: string; spentWei: string; reservedWei: string };
  counts?: { proposals: number; orderWallets: number };
  issues: Issue[];
  notices?: string[];
};

const WALLET_ACTIVE = 0n;
// Governor states Canceled, Defeated, Expired and Executed.
const FINISHED_PROPOSALS = [2n, 3n, 6n, 7n];
// After a second mined revert an action waits for review. Governance labels include the proposal
// state, so queue and execute are counted separately.
const MAX_REVERTS = 2;
// Gas reserved for one OrderWallet.collect(): a bound on the gas limit the Worker signs, estimate × 1.2.
// On the Polygon fork the estimate was 129,012 (a 154,814 limit) and the first collection used 109,361.
export const CLEANUP_GAS_LIMIT = 200_000n;

type Tick = {
  settings: Settings; config: DaoConfig; state: RunnerState; storage: Storage; provider: ChainProvider;
  network: NetworkProfile; request: typeof fetch; chain: ReturnType<typeof contracts>;
  tx: TransactionContext; busy: boolean; report: Report & Required<Pick<Report, "ready">>;
};

export async function runTick(settings: Settings, deps: RunnerDeps): Promise<Report> {
  const report = startReport(settings);
  if (!settings.config) return { ...report, status: "needs-deployment-config" };
  let tick: Tick;
  try { tick = await openTick(settings, settings.config, deps, report); }
  catch (error) { return failedRun("deployment-validation", error, report); }
  await runStages(tick);
  return finishReport(tick);
}

export function failedRun(phase: string, error: unknown, report: Report = { checkedAt: new Date().toISOString(), status: "run-failed", issues: [] }): Report {
  const { code, reason } = describeError(error);
  return { ...report, status: "run-failed", phase, errorCode: code, reason };
}

function startReport(settings: Settings): Report & Required<Pick<Report, "ready">> {
  const mode = !settings.execution ? "read-only" : settings.submission ? "execution+submission" : "execution";
  return { checkedAt: new Date().toISOString(), status: "ok", mode, ready: { collection: [], governance: [] }, issues: [] };
}

async function openTick(settings: Settings, config: DaoConfig, deps: RunnerDeps, report: Tick["report"]): Promise<Tick> {
  const state = await deps.storage.load() ?? emptyState();
  const signer = settings.gasKey ? signerFor(settings.gasKey, deps.provider) : undefined;
  report.gasSigner = signer?.address;
  await validateDeployment(config, deps.provider, deps.network);
  const tx = { provider: deps.provider, config, state, journal: deps.storage, capWei: settings.gasCapWei, live: settings.execution, signer };
  return { settings, config, state, storage: deps.storage, provider: deps.provider, network: deps.network, request: deps.request ?? fetch.bind(globalThis), chain: contracts(config, deps.provider), tx, busy: Boolean(state.pending), report };
}

// Stages fail independently. Discovery, governance or transport problems are reported without
// preventing cleanup of wallets that are already known.
async function runStages(tick: Tick) {
  await stage(tick, "pending-transaction", () => reconcileStage(tick));
  await stage(tick, "event-discovery", () => discover(tick.config, tick.provider, tick.state, tick.storage));
  await stage(tick, "collection", () => collectionStage(tick));
  await stage(tick, "governance", () => governanceStage(tick));
  await stage(tick, "order-transport", () => transportStage(tick));
}

// A refused or unrepriceable transaction holds the only nonce, so it is an issue, not a notice.
async function reconcileStage(tick: Tick) {
  tick.busy = await reconcilePending(tick.tx);
  const problem = tick.state.pending?.refused ?? tick.state.pending?.blocked;
  if (problem) throw new CheckFailure(`${tick.state.pending!.label} is stalled: ${problem}`);
}

async function stage(tick: Tick, name: string, work: () => Promise<void>) {
  try { await work(); } catch (error) { tick.report.issues.push({ stage: name, ...describeError(error) }); }
}

// One failing wallet, proposal or order must not stop the others.
async function item(tick: Tick, stageName: string, id: string, work: () => Promise<unknown>) {
  try { await work(); } catch (error) { tick.report.issues.push({ stage: stageName, item: id, ...describeError(error) }); }
}

async function collectionStage(tick: Tick) {
  for (const address of [...tick.state.wallets]) await item(tick, "collection", address, () => collectWallet(tick, address));
}

async function collectWallet(tick: Tick, address: string) {
  const wallet = tick.chain.wallet(address);
  if (await wallet.state() !== WALLET_ACTIVE) return forgetWallet(tick, address);
  if (!await wallet.canCollect()) return;
  tick.report.ready.collection.push(address);
  await trySend(tick, `collect:${address}`, address, wallet.interface.encodeFunctionData("collect"));
}

async function forgetWallet(tick: Tick, address: string) {
  tick.state.wallets = tick.state.wallets.filter(item => item !== address);
  await tick.storage.save(tick.state);
}

async function governanceStage(tick: Tick) {
  const keepWei = await cleanupReserve(tick, 0);
  for (const proposal of [...tick.state.proposals]) await item(tick, "governance", proposal.id, () => advanceProposal(tick, proposal, keepWei));
}

async function advanceProposal(tick: Tick, proposal: Proposal, keepWei: bigint) {
  const current: bigint = await tick.chain.governor.state(proposal.id);
  if (FINISHED_PROPOSALS.includes(current)) return forgetProposal(tick, proposal.id);
  const [ready, payload] = await tick.chain.automation.checker(proposal.targets, proposal.values, proposal.calldatas, proposal.descriptionHash);
  if (!ready) return;
  tick.report.ready.governance.push(proposal.id);
  await trySend(tick, `advance:${proposal.id}:${current}`, tick.config.automation, payload, keepWei);
}

async function forgetProposal(tick: Tick, id: string) {
  tick.state.proposals = tick.state.proposals.filter(item => item.id !== id);
  await tick.storage.save(tick.state);
}

// Ready work is reported in every mode; only live execution with a free nonce sends it.
async function trySend(tick: Tick, label: string, to: string, data: string, keepWei = 0n) {
  if ((tick.state.reverts[label] ?? 0) >= MAX_REVERTS) throw new CheckFailure(`${label} reverted ${MAX_REVERTS} times; waiting for review`);
  if (!tick.settings.execution || tick.busy) return;
  await sendAction(tick.tx, label, to, data, keepWei);
  tick.busy = Boolean(tick.state.pending);
  if (tick.state.pending) tick.report.transaction = { label, hash: tick.state.pending.versions[0].hash };
}

// Gas kept for collecting every open wallet whose order was posted, plus `extra` wallets, so a
// governance action or another post cannot spend what cleanup of a filled or cached order needs.
async function cleanupReserve(tick: Tick, extra: number) {
  const posted = openAttempts(tick).length;
  if (!tick.settings.execution || posted + extra === 0) return 0n;
  return BigInt(posted + extra) * CLEANUP_GAS_LIMIT * (await currentFees(tick.provider)).maxFeePerGas;
}

function openAttempts(tick: Tick) {
  return Object.values(tick.state.attempts).filter(attempt => tick.state.wallets.some(address => sameAddress(address, attempt.wallet)));
}

async function transportStage(tick: Tick) {
  if (!tick.settings.submission) return;
  if (!tick.settings.execution) throw new CheckFailure("Order submission requires execution and cleanup to be enabled");
  const credentials = parseCredentials(tick.settings.clobCredentials);
  for (const attempt of openAttempts(tick)) await item(tick, "order-reconciliation", attempt.digest, () => reconcileAttempt(tick, attempt, credentials));
  if (tick.state.pending?.refused || tick.state.pending?.blocked) throw new CheckFailure("No new order while the gas signer's transaction is stalled");
  for (const address of tick.state.wallets) if (!tick.report.orderPosted) await item(tick, "order-transport", address, () => postWalletOrder(tick, address, credentials));
}

// The exchange's status shows what actually filled; the CLOB record can settle an uncertain post.
async function reconcileAttempt(tick: Tick, attempt: OrderAttempt, credentials: Credentials) {
  const checkedAt = new Date().toISOString();
  const [filled, remaining] = await tick.chain.exchange(attempt.exchange).orderStatus(attempt.digest);
  attempt.settlement = { filled, remaining: remaining.toString(), checkedAt };
  attempt.venue = { ...await readVenueOrder(attempt.digest, credentials, tick.request), checkedAt };
  if (attempt.venue.status !== "not-found" && (attempt.status === "posting" || attempt.status === "unknown")) attempt.status = "accepted";
  await tick.storage.save(tick.state);
}

async function postWalletOrder(tick: Tick, address: string, credentials: Credentials) {
  const wallet = tick.chain.wallet(address);
  const digest: string = await wallet.orderHash();
  if (tick.state.attempts[digest] || !await openForSubmission(wallet)) return;
  const order = orderObject(await wallet.getOrder());
  const exchange: string = await wallet.exchange();
  await checkBeforePosting(tick, order, digest, exchange);
  if (!await openForSubmission(wallet)) return;
  await postOnce(order, { digest, wallet: address, exchange }, credentials, tick.state, tick.storage, tick.request);
  tick.report.orderPosted = digest;
}

async function openForSubmission(wallet: Contract) {
  return await wallet.state() === WALLET_ACTIVE && !await wallet.canCollect();
}

// Immediately before the POST: the exact digest at a configured exchange, the live book, the
// exchange's own validation (fill status, signature, maker pause) and gas for later cleanup.
async function checkBeforePosting(tick: Tick, order: OrderFields, digest: string, exchangeAddress: string) {
  const negativeRisk = sameAddress(exchangeAddress, tick.network.negRiskExchange);
  if (!negativeRisk && !sameAddress(exchangeAddress, tick.network.exchange)) throw new CheckFailure("Unsupported exchange");
  const exchange = tick.chain.exchange(exchangeAddress);
  if (await exchange.hashOrder(order) !== digest) throw new CheckFailure("Order digest mismatch");
  await validateBook(order, negativeRisk, tick.request);
  await exchange.validateOrder(order);
  if (availableWei(tick.state, tick.settings.gasCapWei) < await cleanupReserve(tick, 1)) throw new CheckFailure("Gas budget cannot cover cleanup of another posted order");
}

function finishReport(tick: Tick): Report {
  const { report, state } = tick;
  report.pending = state.pending && { label: state.pending.label, nonce: state.pending.nonce, hashes: state.pending.versions.map(version => version.hash) };
  report.orders = Object.fromEntries(Object.values(state.attempts).map(({ digest, ...attempt }) => [digest, attempt]));
  report.gas = { capWei: tick.settings.gasCapWei.toString(), spentWei: state.spentWei, reservedWei: state.pending?.reservedWei ?? "0" };
  report.counts = { proposals: state.proposals.length, orderWallets: state.wallets.length };
  report.notices = state.notices.slice(-5);
  return { ...report, status: report.issues.length ? "attention" : "ok" };
}
