import { Contract, FetchRequest, JsonRpcProvider, Network, Wallet, id, keccak256, type Log, type Provider, type TransactionReceipt, type TransactionRequest } from "ethers";
import governorArtifact from "../../artifacts/contracts/MarketGovernor.sol/MarketGovernor.json";
import automationArtifact from "../../artifacts/contracts/GovernanceAutomation.sol/GovernanceAutomation.json";
import vaultArtifact from "../../artifacts/contracts/OrderVault.sol/OrderVault.json";
import walletArtifact from "../../artifacts/contracts/OrderWallet.sol/OrderWallet.json";
import { POLYGON, sameAddress } from "../../scripts/addresses";
import { CheckFailure, notice, type DaoConfig, type Journal, type PendingTransaction, type RunnerState, type TransactionVersion } from "./config";

export const orderTuple = "(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder,bytes signature)";
// V2 checks used before posting, plus the exchange's per-digest fill status.
const exchangeAbi = [
  `function hashOrder(${orderTuple} order) view returns (bytes32)`,
  `function validateOrder(${orderTuple} order) view`,
  "function orderStatus(bytes32 orderHash) view returns (bool filled, uint248 remaining)",
];

/// Chain, assets and exchanges a deployment must use. The hosted Worker always passes POLYGON;
/// local tests pass their mock addresses in the same shape.
export type NetworkProfile = typeof POLYGON;

export type ChainProvider = Provider & { send(method: string, params: unknown[]): Promise<any> };

export function polygonProvider(url: string) {
  const request = new FetchRequest(url);
  request.timeout = 15_000;
  // A plain Network keeps fee data on this RPC. Ethers' Polygon preset asks an external gas
  // station first, and an outage there would block cleanup transactions.
  return new JsonRpcProvider(request, new Network("polygon", POLYGON.chainId), { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
}

export function contracts(config: DaoConfig, provider: Provider) {
  return {
    governor: new Contract(config.governor, governorArtifact.abi, provider),
    automation: new Contract(config.automation, automationArtifact.abi, provider),
    vault: new Contract(config.vault, vaultArtifact.abi, provider),
    wallet: (address: string) => new Contract(address, walletArtifact.abi, provider),
    exchange: (address: string) => new Contract(address, exchangeAbi, provider),
  };
}

// The static network skips eth_chainId, so ask the RPC itself before trusting anything else.
export async function validateDeployment(config: DaoConfig, provider: ChainProvider, network: NetworkProfile) {
  if (BigInt(await provider.send("eth_chainId", [])) !== network.chainId) throw new CheckFailure("Unexpected chain");
  const { governor, automation, vault } = contracts(config, provider);
  const [gov, treasury, collateral, positions, standard, negativeRisk] = await Promise.all([automation.governor(), governor.betVault(), vault.collateral(), vault.positions(), vault.standardExchange(), vault.negativeRiskExchange()]);
  if (!sameAddress(gov, config.governor) || !sameAddress(treasury, config.vault)) throw new CheckFailure("Wrong governance deployment");
  if (!sameAddress(collateral, network.collateral) || !sameAddress(positions, network.positions)) throw new CheckFailure("Unexpected treasury assets");
  if (!sameAddress(standard, network.exchange) || !sameAddress(negativeRisk, network.negRiskExchange)) throw new CheckFailure("Unexpected exchanges");
}

// Public RPCs accept this eth_getLogs window. A rewind goes far below the confirmation depth.
const DISCOVERY_RANGE = 500;
const REORG_REWIND_BLOCKS = 1_000;

export async function discover(config: DaoConfig, provider: Provider, state: RunnerState, journal: Journal) {
  await rewindAfterReorganization(config, provider, state);
  const fromBlock = state.cursor ? state.cursor.number + 1 : config.startBlock;
  const toBlock = Math.min(await provider.getBlockNumber() - config.confirmations, fromBlock + DISCOVERY_RANGE - 1);
  if (toBlock < fromBlock) return;
  const logs = await provider.getLogs({ address: [config.governor, config.vault], fromBlock, toBlock });
  for (const log of logs) recordEvent(contracts(config, provider), config, state, log);
  const block = await provider.getBlock(toBlock);
  if (!block?.hash) throw new CheckFailure("Missing confirmed block");
  state.cursor = { number: toBlock, hash: block.hash };
  await journal.save(state);
}

// A changed confirmed block means a deep reorganization. Rescanning is idempotent, and every
// discovered proposal or wallet is read again onchain before any action.
async function rewindAfterReorganization(config: DaoConfig, provider: Provider, state: RunnerState) {
  if (!state.cursor || (await provider.getBlock(state.cursor.number))?.hash === state.cursor.hash) return;
  notice(state, `confirmed block ${state.cursor.number} changed; rescanning`);
  const number = state.cursor.number - REORG_REWIND_BLOCKS;
  const block = number >= config.startBlock ? await provider.getBlock(number) : null;
  state.cursor = block?.hash ? { number, hash: block.hash } : undefined;
}

function recordEvent(chain: ReturnType<typeof contracts>, config: DaoConfig, state: RunnerState, log: Log) {
  const event = (sameAddress(log.address, config.governor) ? chain.governor : chain.vault).interface.parseLog(log);
  if (event?.name === "ProposalCreated") addProposal(state, event.args);
  if (event?.name === "ContractOrderAuthorized" && !state.wallets.includes(event.args.wallet)) state.wallets.push(event.args.wallet);
}

function addProposal(state: RunnerState, args: any) {
  const proposalId = args.proposalId.toString();
  if (state.proposals.some(item => item.id === proposalId)) return;
  // args[3] is `values`: Result.values is a method name.
  state.proposals.push({ id: proposalId, targets: [...args.targets], values: [...args[3]].map(String), calldatas: [...args.calldatas], descriptionHash: id(args.description) });
}

/// One tick's transaction settings. Without `live` (EXECUTION_ENABLED) nothing is broadcast,
/// including a rebroadcast of bytes persisted by an earlier tick.
export type TransactionContext = { provider: ChainProvider; config: DaoConfig; state: RunnerState; journal: Journal; capWei: bigint; live: boolean; signer?: Wallet };
export type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

export const GAS_LIMIT_MARGIN_PERCENT = 120n;
// About one one-minute cron interval of two-second Polygon blocks.
const REPLACE_AFTER_BLOCKS = 30;
// +12.5%, above the 10% bump nodes require to accept a same-nonce replacement.
const FEE_BUMP_PER_MILLE = 125n;
// A plain self-transfer: it only consumes the nonce.
const CANCEL_GAS_LIMIT = 21_000n;

// The gas signer is built from this package's ethers so tests and the Worker share one Wallet class.
export function signerFor(key: string, provider: Provider) {
  return new Wallet(key, provider);
}

export function availableWei(state: RunnerState, capWei: bigint) {
  return capWei - BigInt(state.spentWei) - BigInt(state.pending?.reservedWei ?? 0);
}

function larger(...values: bigint[]) {
  return values.reduce((a, b) => a > b ? a : b);
}

/// EIP-1559 fees from the configured RPC. The tip is at least the node's legacy gas price minus the
/// base fee: without eth_maxPriorityFeePerGas, ethers falls back to 1 gwei, below Polygon's minimum.
export async function currentFees(provider: Provider) {
  const [block, fees] = await Promise.all([provider.getBlock("latest"), provider.getFeeData()]);
  if (!block?.baseFeePerGas) throw new CheckFailure("Expected EIP-1559 fees");
  const tip = larger(fees.maxPriorityFeePerGas ?? 0n, (fees.gasPrice ?? 0n) - block.baseFeePerGas);
  return { block: block.number, baseFee: block.baseFeePerGas, maxPriorityFeePerGas: tip, maxFeePerGas: 2n * block.baseFeePerGas + tip };
}

/// Simulate, price, reserve and persist before broadcasting. `keepWei` must stay available, now
/// and whenever the transaction is repriced; collection passes zero.
export async function sendAction(ctx: TransactionContext, label: string, to: string, data: string, keepWei = 0n) {
  if (ctx.state.pending) throw new CheckFailure("Pending transaction must be reconciled first");
  const signer = requireSigner(ctx);
  await ctx.provider.call({ from: signer.address, to, data, value: 0 });
  const request = await pricedRequest(ctx, signer, to, data, keepWei);
  await persistAndBroadcast(ctx, signer, label, request, keepWei);
}

function requireSigner(ctx: TransactionContext) {
  if (!ctx.signer) throw new CheckFailure("Missing gas signer");
  return ctx.signer;
}

// The reservation is the worst case the transaction can cost: gas limit × fee cap.
async function pricedRequest(ctx: TransactionContext, signer: Wallet, to: string, data: string, keepWei: bigint) {
  const { maxFeePerGas, maxPriorityFeePerGas } = await currentFees(ctx.provider);
  const request = await signer.populateTransaction({ to, data, value: 0, type: 2, maxFeePerGas, maxPriorityFeePerGas });
  request.gasLimit = BigInt(request.gasLimit!) * GAS_LIMIT_MARGIN_PERCENT / 100n;
  if (BigInt(request.gasLimit) * maxFeePerGas + keepWei > availableWei(ctx.state, ctx.capWei)) throw new CheckFailure("Authorized gas budget exceeded");
  return request;
}

async function persistAndBroadcast(ctx: TransactionContext, signer: Wallet, label: string, request: TransactionRequest, keepWei: bigint) {
  const version = await signVersion(ctx, signer, request);
  const reservedWei = (BigInt(request.gasLimit!) * BigInt(request.maxFeePerGas!)).toString();
  const pending = { label, from: signer.address, to: String(request.to), data: String(request.data), nonce: Number(request.nonce), gasLimit: String(request.gasLimit), reservedWei, keepWei: keepWei.toString(), versions: [version] };
  ctx.state.pending = pending;
  await ctx.journal.save(ctx.state);
  await broadcast(ctx, pending, version.raw, true);
}

async function signVersion(ctx: TransactionContext, signer: Wallet, request: TransactionRequest): Promise<TransactionVersion> {
  const raw = await signer.signTransaction(request);
  return { hash: keccak256(raw), raw, maxFeePerGas: String(request.maxFeePerGas), maxPriorityFeePerGas: String(request.maxPriorityFeePerGas), sentBlock: await ctx.provider.getBlockNumber() };
}

// Codes of a node that answered and refused the bytes. A network error or timeout leaves delivery
// uncertain instead, and the same bytes are sent again.
const REFUSALS = ["INSUFFICIENT_FUNDS", "NONCE_EXPIRED", "REPLACEMENT_UNDERPRICED", "UNKNOWN_ERROR"];

// A failure is recorded, not thrown; the next tick resends or reprices. Only the first broadcast of
// a nonce refused for funds proves that no node holds it, so only then is the nonce released.
async function broadcast(ctx: TransactionContext, pending: PendingTransaction, raw: string, first = false) {
  try { await ctx.provider.broadcastTransaction(raw); delete pending.refused; }
  catch (error) { failedBroadcast(ctx, pending, String((error as { code?: unknown })?.code ?? "UNKNOWN_ERROR")); }
  if (first && pending.refused === "INSUFFICIENT_FUNDS") delete ctx.state.pending;
  await ctx.journal.save(ctx.state);
}

function failedBroadcast(ctx: TransactionContext, pending: PendingTransaction, code: string) {
  notice(ctx.state, `broadcast of ${pending.label} failed: ${code}`);
  if (REFUSALS.includes(code)) pending.refused = code;
}

/// Returns true while the gas signer's pending nonce is still occupied.
export async function reconcilePending(ctx: TransactionContext): Promise<boolean> {
  const pending = ctx.state.pending;
  if (!pending) return false;
  const receipt = await minedVersion(ctx.provider, pending);
  if (receipt) return !await settleWhenConfirmed(ctx, pending, receipt);
  if (await nonceUsedElsewhere(ctx, pending)) return release(ctx, `nonce of ${pending.label} was used by another transaction`);
  if (ctx.live) await keepPropagating(ctx, pending);
  return true;
}

async function minedVersion(provider: Provider, pending: PendingTransaction) {
  for (const version of pending.versions) {
    const receipt = await provider.getTransactionReceipt(version.hash);
    if (receipt) return receipt;
  }
  return null;
}

// At the configured depth: count the actual fee, release the reservation and remember a revert.
async function settleWhenConfirmed(ctx: TransactionContext, pending: PendingTransaction, receipt: TransactionReceipt) {
  if (await receipt.confirmations() < ctx.config.confirmations) return false;
  ctx.state.spentWei = (BigInt(ctx.state.spentWei) + receipt.fee).toString();
  if (receipt.status !== 1) ctx.state.reverts[pending.label] = (ctx.state.reverts[pending.label] ?? 0) + 1;
  delete ctx.state.pending;
  await ctx.journal.save(ctx.state);
  return true;
}

// The nonce is used at confirmed depth, no version has a receipt and the RPC knows none of them:
// another sender used this key. A lagging node that lost a receipt still knows the transaction.
async function nonceUsedElsewhere(ctx: TransactionContext, pending: PendingTransaction) {
  const confirmed = await ctx.provider.getBlockNumber() - ctx.config.confirmations;
  if (confirmed <= 0 || await ctx.provider.getTransactionCount(pending.from, confirmed) <= pending.nonce) return false;
  for (const version of pending.versions) if (await ctx.provider.getTransaction(version.hash)) return false;
  return true;
}

async function release(ctx: TransactionContext, reason: string) {
  notice(ctx.state, reason);
  delete ctx.state.pending;
  await ctx.journal.save(ctx.state);
  return false;
}

function latestVersion(pending: PendingTransaction) {
  return pending.versions[pending.versions.length - 1];
}

// Resend bytes the RPC lost; reprice a refused version at once and a waiting one when it is
// underpriced. A refusal for funds or for an already used nonce is not a pricing problem.
async function keepPropagating(ctx: TransactionContext, pending: PendingTransaction) {
  const latest = latestVersion(pending);
  if (pending.refused === "NONCE_EXPIRED") return;
  if (pending.refused && pending.refused !== "INSUFFICIENT_FUNDS") return reprice(ctx, pending, latest, await currentFees(ctx.provider));
  if (!await ctx.provider.getTransaction(latest.hash)) return broadcast(ctx, pending, latest.raw);
  await repriceIfUnderpriced(ctx, pending, latest);
}

async function repriceIfUnderpriced(ctx: TransactionContext, pending: PendingTransaction, latest: TransactionVersion) {
  const fees = await currentFees(ctx.provider);
  if (fees.block - latest.sentBlock < REPLACE_AFTER_BLOCKS) return;
  if (BigInt(latest.maxPriorityFeePerGas) >= fees.maxPriorityFeePerGas && BigInt(latest.maxFeePerGas) >= fees.baseFee + fees.maxPriorityFeePerGas) return;
  await reprice(ctx, pending, latest, fees);
}

function bumpedFees(latest: TransactionVersion, fees: Fees): Fees {
  const bump = (value: string) => BigInt(value) + (BigInt(value) * FEE_BUMP_PER_MILLE + 999n) / 1000n;
  const maxPriorityFeePerGas = larger(bump(latest.maxPriorityFeePerGas), fees.maxPriorityFeePerGas);
  return { maxPriorityFeePerGas, maxFeePerGas: larger(bump(latest.maxFeePerGas), fees.maxFeePerGas, maxPriorityFeePerGas) };
}

// Same nonce, target, data and gas limit with higher fees; the reservation grows by the difference.
// If that would spend the cleanup reserve, a governance transaction is cancelled instead.
async function reprice(ctx: TransactionContext, pending: PendingTransaction, latest: TransactionVersion, fees: Fees) {
  const next = bumpedFees(latest, fees);
  const cost = BigInt(pending.gasLimit) * next.maxFeePerGas;
  if (cost - BigInt(pending.reservedWei) + BigInt(pending.keepWei) <= availableWei(ctx.state, ctx.capWei)) return sendVersion(ctx, pending, next, cost);
  if (BigInt(pending.keepWei) > 0n) return cancelInstead(ctx, pending, next);
  await blockedRepricing(ctx, pending);
}

// A self-transfer on the same nonce frees the signer for cleanup, and the governance action is
// retried when it is ready again. Older versions stay mineable, so the reservation cannot shrink.
async function cancelInstead(ctx: TransactionContext, pending: PendingTransaction, fees: Fees) {
  const cost = larger(BigInt(pending.reservedWei), CANCEL_GAS_LIMIT * fees.maxFeePerGas);
  if (cost - BigInt(pending.reservedWei) > availableWei(ctx.state, ctx.capWei)) return blockedRepricing(ctx, pending);
  Object.assign(pending, { label: `cancel:${pending.label}`, to: pending.from, data: "0x", gasLimit: CANCEL_GAS_LIMIT.toString(), keepWei: "0" });
  await sendVersion(ctx, pending, fees, cost);
}

async function sendVersion(ctx: TransactionContext, pending: PendingTransaction, fees: Fees, reservedWei: bigint) {
  const signer = requireSigner(ctx);
  const request = await signer.populateTransaction({ to: pending.to, data: pending.data, value: 0, nonce: pending.nonce, gasLimit: BigInt(pending.gasLimit), type: 2, ...fees });
  pending.versions.push(await signVersion(ctx, signer, request));
  pending.reservedWei = reservedWei.toString();
  delete pending.blocked;
  await ctx.journal.save(ctx.state);
  await broadcast(ctx, pending, latestVersion(pending).raw);
}

// The earlier version stays pending and may still be mined; the report flags the stalled nonce.
async function blockedRepricing(ctx: TransactionContext, pending: PendingTransaction) {
  pending.blocked = "gas budget blocks repricing";
  notice(ctx.state, `gas budget blocks repricing of ${pending.label}`);
  await ctx.journal.save(ctx.state);
}
