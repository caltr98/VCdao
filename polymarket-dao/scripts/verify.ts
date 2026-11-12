import { Contract, JsonRpcProvider, TransactionReceipt, isHexString } from "ethers";
import vaultArtifact from "../artifacts/contracts/BetVault.sol/BetVault.json";
import { POLYGON, assetAbi, sameAddress, verifyPurchaseLogs, printJson } from "./polymarket";

async function confirmedReceipt(provider: JsonRpcProvider, hash: string): Promise<TransactionReceipt> {
  if (!isHexString(hash, 32)) throw new Error("Expected a transaction hash");
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt || receipt.status !== 1 || await receipt.confirmations() < 32) throw new Error("Receipt absent, failed, or below 32 confirmations");
  if ((await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) throw new Error("Receipt is not on the current canonical chain");
  return receipt;
}

async function main() {
  const [vaultAddress, id, authorizationTx, settlementTx, orderHash] = process.argv.slice(2);
  if (!orderHash || !process.env.POLYGON_RPC_URL) throw new Error("Usage: npm run verify -- VAULT ID AUTHORIZATION_TX SETTLEMENT_TX ORDER_HASH; set POLYGON_RPC_URL");
  const provider = new JsonRpcProvider(process.env.POLYGON_RPC_URL);
  if ((await provider.getNetwork()).chainId !== POLYGON.chainId) throw new Error("Expected Polygon mainnet");
  const vault = new Contract(vaultAddress, vaultArtifact.abi, provider);
  await validateAssets(vault);
  const buy = await vault.buys(id);
  const authorization = await confirmedReceipt(provider, authorizationTx);
  const settlement = await confirmedReceipt(provider, settlementTx);
  validateAuthorization(vault, id, authorization, settlement);
  const timestamp = (await provider.getBlock(settlement.blockNumber))!.timestamp;
  if (BigInt(timestamp) > buy.deadline) throw new Error("Trade settled after the execution deadline");
  const evidence = verifyPurchaseLogs(settlement.logs, { executor: buy.executor, tokenId: buy.tokenId, shares: buy.shares, payment: buy.payment, orderHash });
  const calls = await deliveryCalls(vault, id, settlementTx, orderHash);
  printJson({ verified: "Historical Polymarket purchase; RPC-backed offchain verification", chainId: 137, vault: vaultAddress, id, authorizationTx, settlementTx, orderHash, executor: buy.executor, ...evidence, calls });
}

async function validateAssets(vault: Contract) {
  if (!sameAddress(await vault.collateral(), POLYGON.collateral) || !sameAddress(await vault.positions(), POLYGON.positions)) {
    throw new Error("Vault is not configured for the supported Polymarket assets");
  }
}

function validateAuthorization(vault: Contract, id: string, authorization: TransactionReceipt, settlement: TransactionReceipt) {
  const event = authorization.logs.filter(log => sameAddress(log.address, vault.target.toString()))
    .map(log => vault.interface.parseLog(log)).find(log => log?.name === "BuyAuthorized" && log.args.id.toLowerCase() === id.toLowerCase());
  if (!event) throw new Error("Authorization receipt does not authorize this intent");
  if (settlement.blockNumber < authorization.blockNumber || (settlement.blockNumber === authorization.blockNumber && settlement.index <= authorization.index)) throw new Error("Purchase predates the authorization");
}

async function deliveryCalls(vault: Contract, id: string, settlement: string, orderHash: string) {
  if (await vault.status(id) !== 1n || await vault.usedOrderHash(orderHash)) return [];
  return [
    { to: POLYGON.positions, value: "0", data: assetAbi.encodeFunctionData("setApprovalForAll", [vault.target, true]) },
    { to: vault.target, value: "0", data: vault.interface.encodeFunctionData("fulfill", [id, settlement, orderHash]) },
    { to: POLYGON.positions, value: "0", data: assetAbi.encodeFunctionData("setApprovalForAll", [vault.target, false]) },
  ];
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
