import "dotenv/config";
import { Contract, JsonRpcProvider, getAddress, isHexString } from "ethers";
import { OrderVault__factory, OrderWallet__factory } from "../typechain-types";
import { POLYGON, printJson, sameAddress } from "./polymarket";
import { orderObject } from "./order";

const orderTuple = "(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder,bytes signature)";

async function main() {
  const [vaultAddress, id] = process.argv.slice(2);
  if (!vaultAddress || !isHexString(id, 32) || !process.env.POLYGON_RPC_URL) throw new Error("Usage: set POLYGON_RPC_URL; npm run contract-order -- VAULT_ADDRESS AUTHORIZATION_ID");
  const provider = new JsonRpcProvider(process.env.POLYGON_RPC_URL);
  try { await inspectOrder(); } finally { provider.destroy(); }

  async function inspectOrder() {
    if ((await provider.getNetwork()).chainId !== POLYGON.chainId) throw new Error("Expected Polygon");
    const vault = OrderVault__factory.connect(getAddress(vaultAddress), provider);
    const wallet = OrderWallet__factory.connect(await vault.orderWallets(id), provider);
    const [treasury, collateral, positions, exchangeAddress, digest, state, deadline, block] = await Promise.all([wallet.treasury(), wallet.collateral(), wallet.positions(), wallet.exchange(), wallet.orderHash(), wallet.state(), wallet.deadline(), provider.getBlock("latest")]);
    if (!sameAddress(treasury, vaultAddress) || !sameAddress(collateral, POLYGON.collateral) || !sameAddress(positions, POLYGON.positions)) throw new Error("Unexpected treasury or assets");
    if (![POLYGON.exchange, POLYGON.negRiskExchange].some(address => sameAddress(address, exchangeAddress))) throw new Error("Unsupported exchange");
    if (state !== 0n || !block || BigInt(block.timestamp) > deadline) throw new Error("Order is inactive or expired");
    const order = orderObject(await wallet.getOrder());
    const exchange = new Contract(exchangeAddress, [`function hashOrder(${orderTuple} order) view returns (bytes32)`, `function validateOrderSignature(bytes32 orderHash,${orderTuple} order) view`], provider);
    if (await exchange.hashOrder(order) !== digest) throw new Error("Exchange digest mismatch");
    await exchange.validateOrderSignature(digest, order);
    printJson({ chainId: POLYGON.chainId, vault: await vault.getAddress(), wallet: await wallet.getAddress(), exchange: exchangeAddress, id, digest, deadline, order, signatureCheck: "Passed eth_call against configured exchange at read time", apiAdmission: "UNVERIFIED: no CLOB request has been sent", note: "Protocol order only. Preserve every integer exactly. HTTP authentication, wallet admission, tick/size checks and transport remain separate. The 0x01 signature is a public marker; do not replace it with a keeper signature." });
  }
}

main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
