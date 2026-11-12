import { ethers, network } from "hardhat";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { TransactionRequest, TransactionReceipt, Wallet } from "ethers";
import { POLYGON } from "./addresses";
import { erc20, safeAbi } from "./safe-fork";
import { REDEMPTION, redemptionMarket, registration, verifyRedemptionAssets } from "./redemption";

// Historical completed fixture: new paid deployments use live-dao-redemption.ts and a new approval.
// Isolated, zero-delay Timelock fixture using existing skill metadata; no Governor is deployed.
// Real Polygon shares come from splitting 0.1 pUSD on a condition already resolved by its oracle.
const path = "output/live-redemption.json";
const state: any = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { transactions: {}, gasBudgetWei: ethers.parseEther("3").toString() };
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n";
function save() { writeFileSync(path + ".tmp", json(state)); renameSync(path + ".tmp", path); }
async function snapshot(name: string, read: () => Promise<unknown>) {
  if (state[name] === undefined) { state[name] = await read(); save(); }
  return state[name];
}

async function send(name: string, request: TransactionRequest, wallet: Wallet): Promise<TransactionReceipt> {
  if (!state.transactions[name]) await prepare();
  const entry = state.transactions[name];
  let receipt = await ethers.provider.getTransactionReceipt(entry.hash);
  if (!receipt) {
    console.log(`Broadcasting ${name}: ${entry.hash}`);
    const response = await ethers.provider.broadcastTransaction(entry.raw);
    receipt = await response.wait(1, 180_000);
  }
  if (!receipt) throw new Error(`${name}: confirmation timeout; resume only from the journal`);
  entry.receipt = { hash: receipt.hash, block: receipt.blockNumber, status: receipt.status, gasUsed: receipt.gasUsed, gasPrice: receipt.gasPrice, fee: receipt.fee, contractAddress: receipt.contractAddress };
  save();
  if (receipt.status !== 1) throw new Error(`${name}: transaction reverted; inspect the journal`);
  return receipt;

  async function prepare() {
    const estimated = await wallet.estimateGas(request), fees = await ethers.provider.getFeeData();
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? ethers.parseUnits("50", "gwei");
    const ceiling = fees.gasPrice! * 125n / 100n;
    const maxFeePerGas = fees.maxFeePerGas && fees.maxFeePerGas < ceiling ? fees.maxFeePerGas : ceiling;
    const gasLimit = estimated * 12n / 10n + 20_000n;
    const spent = Object.values(state.transactions).reduce((sum: bigint, tx: any) => sum + BigInt(tx.receipt?.fee ?? tx.worstCaseFee), 0n);
    if (spent + gasLimit * maxFeePerGas > BigInt(state.gasBudgetWei)) throw new Error("Live gas budget exhausted");
    const nonce = Number(BigInt(await ethers.provider.send("eth_getTransactionCount", [wallet.address, "pending"])));
    const raw = await wallet.signTransaction({ ...request, chainId: 137, type: 2, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas });
    // Persist the exact signed bytes before any broadcast, including deployments.
    state.transactions[name] = { raw, hash: ethers.keccak256(raw), nonce, worstCaseFee: gasLimit * maxFeePerGas };
    save();
  }
}

async function main() {
  if (network.name !== "polygon" || process.env.CONFIRM_REDEMPTION !== "yes") throw new Error("Explicit live redemption authorization required");
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, ethers.provider);
  if (wallet.address !== REDEMPTION.owner || (await ethers.provider.getNetwork()).chainId !== 137n) throw new Error("Wrong live signer or network");
  if (state.completed) { console.log(json(state.result)); return; }
  throw new Error("Historical fixture retired; approve the DAO-funded live plan and use live-dao-redemption.ts");
  const market = await snapshot("market", async () => redemptionMarket());
  const { adapter, ctf } = await verifyRedemptionAssets(market);
  const pusd = new ethers.Contract(POLYGON.collateral, erc20, ethers.provider);
  const safe = new ethers.Contract(REDEMPTION.safe, safeAbi, ethers.provider);
  if (await safe.getThreshold() !== 1n || !(await safe.getOwners()).includes(wallet.address)) throw new Error("Wrong funding Safe owner");
  const before = await snapshot("before", async () => ({ safePusd: await pusd.balanceOf(REDEMPTION.safe), callerPusd: await pusd.balanceOf(wallet.address), oldShares: await ctf.balanceOf(REDEMPTION.oldVault, REDEMPTION.oldToken), oldPusd: await pusd.balanceOf(REDEMPTION.oldVault), callerPol: await ethers.provider.getBalance(wallet.address), block: await ethers.provider.getBlockNumber() }));
  if (BigInt(before.safePusd) < REDEMPTION.principal || BigInt(before.callerPol) < ethers.parseEther("3")) throw new Error("Insufficient authorized test funds");
  const timelockAddress = await deploy("timelock", "TimelockController", [0, [wallet.address], [ethers.ZeroAddress], wallet.address]);
  const registryAddress = await deploy("registry", "MarketRegistry", [timelockAddress, REDEMPTION.skills]);
  const vaultAddress = await deploy("vault", "RedeemableOrderVault", [timelockAddress, POLYGON.collateral, POLYGON.positions, registryAddress, POLYGON.exchange, POLYGON.negRiskExchange, REDEMPTION.adapter]);
  const timelock = await ethers.getContractAt("TimelockController", timelockAddress);
  const registry = await ethers.getContractAt("MarketRegistry", registryAddress);
  const vault = await ethers.getContractAt("RedeemableOrderVault", vaultAddress);
  const cutoff = await snapshot("registryCutoff", async () => (await ethers.provider.getBlock("latest"))!.timestamp + 86_400);
  await governed("register", registryAddress, registry.interface.encodeFunctionData("registerMarket", registration(market, cutoff)));
  const signature = ethers.concat([ethers.zeroPadValue(wallet.address, 32), ethers.ZeroHash, "0x01"]);
  const safeTransfer = erc20.encodeFunctionData("transfer", [wallet.address, REDEMPTION.principal]);
  await send("fund", { to: REDEMPTION.safe, data: safe.interface.encodeFunctionData("execTransaction", [POLYGON.collateral, 0, safeTransfer, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, signature]) }, wallet);
  await send("approveSplit", { to: POLYGON.collateral, data: erc20.encodeFunctionData("approve", [REDEMPTION.adapter, REDEMPTION.principal]) }, wallet);
  await send("split", { to: REDEMPTION.adapter, data: adapter.interface.encodeFunctionData("splitPosition", [POLYGON.collateral, ethers.ZeroHash, market.conditionId, [1, 2], REDEMPTION.principal]) }, wallet);
  await send("deliver", { to: POLYGON.positions, data: ctf.interface.encodeFunctionData("safeBatchTransferFrom", [wallet.address, vaultAddress, [market.yes, market.no], [REDEMPTION.principal, REDEMPTION.principal], "0x"]) }, wallet);
  const beforeRedeem = await snapshot("beforeRedeem", async () => ({ vaultPusd: await pusd.balanceOf(vaultAddress), yes: await ctf.balanceOf(vaultAddress, market.yes), no: await ctf.balanceOf(vaultAddress, market.no), callerPusd: await pusd.balanceOf(wallet.address), denominator: await ctf.payoutDenominator(market.conditionId), payouts: [await ctf.payoutNumerators(market.conditionId, 0), await ctf.payoutNumerators(market.conditionId, 1)] }));
  const receipt = await send("redeem", { to: vaultAddress, data: vault.interface.encodeFunctionData("redeem", [BigInt(market.conditionId)]) }, wallet);
  await snapshot("afterRedeem", async () => {
    const payout = BigInt(await pusd.balanceOf(vaultAddress)) - BigInt(beforeRedeem.vaultPusd);
    const checks = { realResolvedCondition: BigInt(beforeRedeem.denominator) > 0n, exactPayout: payout === REDEMPTION.principal, callerReceivesNothing: String(await pusd.balanceOf(wallet.address)) === String(beforeRedeem.callerPusd), callerIsNotTimelock: wallet.address !== timelockAddress, sharesConsumed: await ctf.balanceOf(vaultAddress, market.yes) === 0n && await ctf.balanceOf(vaultAddress, market.no) === 0n, approvalRevoked: !await ctf.isApprovedForAll(vaultAddress, REDEMPTION.adapter) };
    if (Object.values(checks).some(passed => !passed)) throw new Error("Live redemption verification failed");
    const event = receipt.logs.map(log => { try { return vault.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === "PositionRedeemed");
    if (!event || event.args.payout !== REDEMPTION.principal) throw new Error("Redemption event missing or wrong");
    return { vaultPusd: await pusd.balanceOf(vaultAddress), payout, block: receipt.blockNumber, checks };
  });
  // Return the test principal only after recording that redemption paid the vault.
  await governed("returnPrincipal", vaultAddress, vault.interface.encodeFunctionData("withdrawCollateral", [REDEMPTION.safe, REDEMPTION.principal]));
  const final = { safePusd: await pusd.balanceOf(REDEMPTION.safe), callerPusd: await pusd.balanceOf(wallet.address), vaultPusd: await pusd.balanceOf(vaultAddress), oldShares: await ctf.balanceOf(REDEMPTION.oldVault, REDEMPTION.oldToken), oldPusd: await pusd.balanceOf(REDEMPTION.oldVault) };
  if (String(final.safePusd) !== String(before.safePusd) || String(final.callerPusd) !== String(before.callerPusd) || final.vaultPusd !== 0n || String(final.oldShares) !== String(before.oldShares) || String(final.oldPusd) !== String(before.oldPusd)) throw new Error("Live cleanup or old-position verification failed");
  state.result = { network: "Polygon mainnet", fixture: "Isolated Timelock-controlled vault; no Governor voting was exercised", acquisition: "Real complete-set split on an already resolved standard market; no CLOB purchase or oracle manipulation", market, adapter: REDEMPTION.adapter, vault: vaultAddress, timelock: timelockAddress, registry: registryAddress, principal: REDEMPTION.principal, beforeRedeem, afterRedeem: state.afterRedeem, final, totalGasFeeWei: Object.values(state.transactions).reduce((sum: bigint, tx: any) => sum + BigInt(tx.receipt.fee), 0n), redeemTx: receipt.hash, oldVault: REDEMPTION.oldVault };
  state.completed = true;
  save();
  console.log(json(state.result));

  async function deploy(name: string, contract: string, args: unknown[]) {
    const factory = await ethers.getContractFactory(contract);
    const receipt = await send(name, await factory.getDeployTransaction(...args), wallet);
    if (!receipt.contractAddress) throw new Error(`${name}: no deployed address`);
    return receipt.contractAddress;
  }
  async function governed(name: string, target: string, data: string) {
    const salt = ethers.id(`live-redemption:${vaultAddress}:${name}`);
    await send(`${name}Schedule`, { to: timelockAddress, data: timelock.interface.encodeFunctionData("schedule", [target, 0, data, ethers.ZeroHash, salt, 0]) }, wallet);
    await send(`${name}Execute`, { to: timelockAddress, data: timelock.interface.encodeFunctionData("execute", [target, 0, data, ethers.ZeroHash, salt]) }, wallet);
  }
}
main().catch((error: any) => { console.error("Live redemption stopped:", error.reason ?? error.code ?? (String(error.message).includes("http") ? "provider details suppressed" : error.message)); process.exitCode = 1; });
