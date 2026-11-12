import { ethers } from "hardhat";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Contract } from "ethers";
import { POLYGON, printJson } from "./polymarket";
import { forkPolygon } from "./fork";
import { SENTINEL, UNIT, USDC_E, chooseMarket, collateral, createSafe, erc1155, erc20, findHolder, findOperator, funded, impersonated, match, outcome, ownerExec, positions, resolve, signed, usdce, type Fork, type Market } from "./safe-fork";

// Polygon-fork test of the Safe route: a Polymarket factory Safe (signature type 2) owned by a
// trading EOA, guarded by SafeTraderGuard, with a DAO Timelock stand-in and SafeSweeper as
// modules. Everything runs on the in-process
// fork; the only network reads are public Gamma/CLOB market data and forked Polygon state.

async function main() {
  const market = await chooseMarket();
  const fork = await forkPolygon();
  try {
    const report = { checkedAt: new Date().toISOString(), forkedFrom: fork.block, market: { slug: market.slug, conditionId: market.conditionId }, ...await rehearse(market, fork) };
    mkdirSync("output", { recursive: true });
    writeFileSync("output/fork-safe.json", JSON.stringify(report, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
    printJson(report);
  } finally { fork.remote.destroy(); }
}

async function rehearse(market: Market, fork: Fork) {
  const [, timelock, treasury, anyone] = await ethers.getSigners(); // DAO Timelock and Treasury stand-ins; anyone = unprivileged caller
  const operator = await impersonated(await findOperator(fork.remote, fork.block));
  const trader = await funded(), counterparty = await funded();
  const principal = 5n * UNIT, shares = 10n * UNIT;
  const guard = await (await ethers.getContractFactory("SafeTraderGuard")).deploy(POLYGON.collateral, POLYGON.exchange);
  const sweeper = await (await ethers.getContractFactory("SafeSweeper")).deploy(treasury.address, USDC_E, POLYGON.positions, ethers.ZeroAddress);
  const handler = await (await ethers.getContractFactory("SafeReceiverHandler")).deploy();

  // 1. Polymarket Safe for the trader EOA, created through the factory.
  const { safe, safeAddress, self } = await createSafe(trader);
  const created = { safe: safeAddress, codeDeployed: (await ethers.provider.getCode(safeAddress)) !== "0x", owners: await safe.getOwners(), threshold: await safe.getThreshold() };

  // 2. Setup, guard last: DAO modules, exchange approval, ERC1155-only fallback handler, trader guard.
  await self("enableModule", [timelock.address]);
  await self("enableModule", [await sweeper.getAddress()]);
  await ownerExec(safe, trader, POLYGON.collateral, erc20.encodeFunctionData("approve", [POLYGON.exchange, ethers.MaxUint256]));
  await self("setFallbackHandler", [await handler.getAddress()]);
  await self("setGuard", [await guard.getAddress()]);

  // 3. The Treasury funds the Safe with four principals; the counterparty gets the complementary principals.
  const holder = await impersonated(await findHolder(fork.remote, fork.block, 8n * principal));
  await (await (collateral.connect(holder) as Contract).getFunction("transfer")(safeAddress, 4n * principal)).wait();
  await (await (collateral.connect(holder) as Contract).getFunction("transfer")(counterparty.address, 4n * principal)).wait();
  await (await (collateral.connect(counterparty) as Contract).getFunction("approve")(POLYGON.exchange, ethers.MaxUint256)).wait();

  // 4. Approved order: maker = Safe, signer = trader, type 2, matched by the real operator, with guard and receiver-only handler.
  const approvedSafeOrder = await outcome(async () => match(market, await signed(trader, safeAddress, market.yes, principal, shares, 2), counterparty, operator));
  const afterFill = { safeYes: await positions.balanceOf(safeAddress, market.yes), safeCollateral: await collateral.balanceOf(safeAddress) };

  // 5. Binding checks: type 2 with a maker that is not the signer's factory Safe; the Safe as maker under type 0.
  const foreignMakerType2 = await outcome(async () => match(market, await signed(trader, treasury.address, market.yes, principal, shares, 2), counterparty, operator));
  const safeMakerEoaType = await outcome(async () => match(market, await signed(trader, safeAddress, market.yes, principal, shares, 0), counterparty, operator));

  // 6. The guard: every owner transaction except an exchange approval reverts.
  const traderAttempts = {
    transferCollateral: await outcome(() => ownerExec(safe, trader, POLYGON.collateral, erc20.encodeFunctionData("transfer", [trader.address, 1n]))),
    approveSelf: await outcome(() => ownerExec(safe, trader, POLYGON.collateral, erc20.encodeFunctionData("approve", [trader.address, ethers.MaxUint256]))),
    transferShares: await outcome(() => ownerExec(safe, trader, POLYGON.positions, erc1155.encodeFunctionData("safeTransferFrom", [safeAddress, trader.address, market.yes, 1n, "0x"]))),
    removeGuard: await outcome(() => self("setGuard", [ethers.ZeroAddress])),
    disableDaoModule: await outcome(() => self("disableModule", [SENTINEL, timelock.address])),
    addOwner: await outcome(() => self("addOwnerWithThreshold", [anyone.address, 1])),
    restoreFallbackHandler: await outcome(() => self("setFallbackHandler", [trader.address])),
    approveExchange: await outcome(() => ownerExec(safe, trader, POLYGON.collateral, erc20.encodeFunctionData("approve", [POLYGON.exchange, ethers.MaxUint256]))),
  };
  const erc1271Answer = await outcome(() => new ethers.Contract(safeAddress, ["function isValidSignature(bytes32,bytes) view returns (bytes4)"], ethers.provider).isValidSignature(ethers.ZeroHash, "0x"));

  // 7. Residual trust: the trader signs an order governance never approved (the other outcome).
  const unapprovedOrder = await outcome(async () => match(market, await signed(trader, safeAddress, market.no, principal, shares, 2), counterparty, operator));

  // 8. Revocation: the Timelock module swaps the trader out as owner; does a trader-signed order still fill?
  const asTimelock = safe.connect(await impersonated(timelock.address)) as Contract;
  await (await asTimelock.getFunction("execTransactionFromModule")(safeAddress, 0, safe.interface.encodeFunctionData("swapOwner", [SENTINEL, trader.address, timelock.address]), 0)).wait();
  const orderAfterTraderRemoved = await outcome(async () => match(market, await signed(trader, safeAddress, market.yes, principal, shares, 2), counterparty, operator));
  // Effective revocation: the Timelock zeroes the exchange allowance; the remaining principal cannot be spent.
  await (await asTimelock.getFunction("execTransactionFromModule")(POLYGON.collateral, 0, erc20.encodeFunctionData("approve", [POLYGON.exchange, 0]), 0)).wait();
  const orderAfterAllowanceRevoked = await outcome(async () => match(market, await signed(trader, safeAddress, market.yes, principal, shares, 2), counterparty, operator));
  const redeemBeforeResolution = await outcome(async () => (await sweeper.connect(anyone).redeem(safeAddress, market.conditionId)).wait());

  // 9. Resolution (oracle impersonated, first outcome wins), then an unprivileged caller redeems to the Treasury;
  // the unspent pUSD principal stays in the Safe for the Timelock.
  const resolution = await resolve(market, fork, [1n, 0n]);
  const beforeRedeem = { safeYes: await positions.balanceOf(safeAddress, market.yes), safeNo: await positions.balanceOf(safeAddress, market.no), safeCollateral: await collateral.balanceOf(safeAddress), treasuryUsdce: await usdce.balanceOf(treasury.address) };
  const redeem = await outcome(async () => (await sweeper.connect(anyone).redeem(safeAddress, market.conditionId)).wait());
  const afterRedeem = { safeYes: await positions.balanceOf(safeAddress, market.yes), safeNo: await positions.balanceOf(safeAddress, market.no), safeCollateral: await collateral.balanceOf(safeAddress), treasuryCollateral: await collateral.balanceOf(treasury.address), treasuryUsdce: await usdce.balanceOf(treasury.address), safeUsdce: await usdce.balanceOf(safeAddress) };

  return { created, ownersAtEnd: await safe.getOwners(), modules: { timelock: await safe.isModuleEnabled(timelock.address), sweeper: await safe.isModuleEnabled(await sweeper.getAddress()) }, approvedSafeOrder, afterFill, foreignMakerType2, safeMakerEoaType, traderAttempts, erc1271Answer, unapprovedOrder, orderAfterTraderRemoved, orderAfterAllowanceRevoked, redeemBeforeResolution, resolution, beforeRedeem, redeem, afterRedeem };
}

main().catch(e => { console.error(e); process.exitCode = 1; });
