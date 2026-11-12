import { ethers } from "hardhat";
import { mkdirSync, writeFileSync } from "node:fs";
import { POLYGON, printJson } from "./polymarket";
import { orderObject } from "./order";
import { forkPolygon } from "./fork";

const tuple = "(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder,bytes signature)";

async function main() {
  const source = await forkPolygon();
  source.remote.destroy();
  const results = [];
  for (const address of [POLYGON.exchange, POLYGON.negRiskExchange]) results.push(await checkExchange(address));
  const report = { checkedAt: new Date().toISOString(), sourceChain: 137, forkChain: (await ethers.provider.getNetwork()).chainId.toString(), block: source.block, blockHash: source.blockHash, results, scope: "Read-only Polygon fork: local wallet deployment and approval only. No live transaction, API authentication, order posting or fill." };
  mkdirSync("output", { recursive: true });
  writeFileSync("output/fork-check.json", JSON.stringify(report, null, 2));
  printJson(report);

  async function checkExchange(address: string) {
    const code = await ethers.provider.getCode(address);
    if (code === "0x") throw new Error(`No deployed exchange code at ${address}`);
    const exchange = new ethers.Contract(address, [`function hashOrder(${tuple} order) view returns (bytes32)`, `function validateOrderSignature(bytes32 digest,${tuple} order) view`], ethers.provider);
    const block = await ethers.provider.getBlock("latest");
    const buy = { market: 1, tokenId: 11, principal: 500_000, shares: 1_000_000, feeBudget: 10_000, deadline: block!.timestamp + 3600, exchange: address };
    const wallet = await (await ethers.getContractFactory("OrderWallet")).deploy(POLYGON.collateral, POLYGON.positions, ethers.id(`fork:${address}`), buy);
    const order = orderObject(await wallet.getOrder());
    const digest = await wallet.orderHash();
    if (await exchange.hashOrder(order) !== digest) throw new Error("Deployed exchange digest mismatch");
    console.log(`Checking ${address}: wallet ERC1271 returns ${await wallet.isValidSignature(digest, order.signature)}`);
    await exchange.validateOrderSignature(digest, order);
    const altered = { ...order, makerAmount: order.makerAmount + 1n };
    await mustReject(async () => exchange.validateOrderSignature(await exchange.hashOrder(altered), altered));
    const collateral = new ethers.Contract(POLYGON.collateral, ["function allowance(address,address) view returns(uint256)"], ethers.provider);
    if (await collateral.allowance(wallet, address) !== 510_000n) throw new Error("Allowance was not limited to budget");
    await wallet.cancel();
    if (await collateral.allowance(wallet, address) !== 0n) throw new Error("Cancellation did not revoke allowance");
    await mustReject(() => exchange.validateOrderSignature(digest, order));
    return { exchange: address, codeHash: ethers.keccak256(code), digest, exactSignature: "accepted", alteredOrder: "rejected", cancelledOrder: "rejected", cancelledAllowance: "0" };
  }
}

async function mustReject(call: () => Promise<unknown>) {
  try { await call(); } catch (error) { if ((error as { data?: string }).data === ethers.id("InvalidSignature()").slice(0, 10)) return; throw error; }
  throw new Error("Expected deployed exchange to reject signature");
}

main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
