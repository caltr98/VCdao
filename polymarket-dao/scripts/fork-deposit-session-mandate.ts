import { ethers, network } from "hardhat";
import { strict as assert } from "assert";
import { readFileSync, writeFileSync } from "fs";
import { forkPolygon } from "./fork";
import { POLYGON } from "./addresses";
import { exchange } from "./safe-fork";

const state = JSON.parse(readFileSync("output/deposit-from-dao-2.json", "utf8"));
const orderTypes = { Order: [
  { name: "salt", type: "uint256" }, { name: "maker", type: "address" }, { name: "signer", type: "address" },
  { name: "tokenId", type: "uint256" }, { name: "makerAmount", type: "uint256" }, { name: "takerAmount", type: "uint256" },
  { name: "side", type: "uint8" }, { name: "signatureType", type: "uint8" }, { name: "timestamp", type: "uint256" },
  { name: "metadata", type: "bytes32" }, { name: "builder", type: "bytes32" }
] };
const nestedTypes = { ...orderTypes, TypedDataSign: [
  { name: "contents", type: "Order" }, { name: "name", type: "string" }, { name: "version", type: "string" },
  { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }, { name: "salt", type: "bytes32" }
] };
const magic = "0x6492649264926492649264926492649264926492649264926492649264926492";

function order(makerAmount: number) {
  return { salt: state.order.salt, maker: state.wallet, signer: state.wallet,
    tokenId: state.order.token_id, makerAmount, takerAmount: state.order.taker_amount,
    side: 0, signatureType: 3, timestamp: state.order.timestamp,
    metadata: state.order.metadata, builder: state.order.builder };
}

async function sessionSignature(signer: any, contents: ReturnType<typeof order>) {
  const appDomain = { name: "Polymarket CTF Exchange", version: "2", chainId: 137, verifyingContract: POLYGON.exchange };
  const message = { contents, name: "DepositWallet", version: "1", chainId: 137,
    verifyingContract: state.wallet, salt: ethers.ZeroHash };
  const inner = await signer.signTypedData(appDomain, nestedTypes, message);
  const description = ethers.toUtf8Bytes(ethers.TypedDataEncoder.from(orderTypes).encodeType("Order"));
  const wrapped = ethers.concat([inner, ethers.TypedDataEncoder.hashDomain(appDomain),
    ethers.TypedDataEncoder.hashStruct("Order", orderTypes, contents), description,
    ethers.toBeHex(description.length, 2)]);
  const envelope = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "bytes"], [signer.address, 0, wrapped]);
  return ethers.concat([envelope, magic]);
}

async function main() {
  const fork = await forkPolygon();
  const wallet = new ethers.Contract(state.wallet, [
    "function owner() view returns(address)", "function sessionSignerAuthorizedUntil(address) view returns(uint256)",
    "function isValidSignature(bytes32,bytes) view returns(bytes4)"], ethers.provider);
  assert.equal((await wallet.owner()).toLowerCase(), state.controller.toLowerCase());
  const signer = ethers.Wallet.createRandom();
  const baseSlot = BigInt(ethers.id("DepositWallet.sessionSignerAuthorizedUntil")) - 1n;
  const slot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [signer.address, baseSlot]));
  const altered = order(Number(state.order.maker_amount) + 1);
  const signature = await sessionSignature(signer, altered);
  const hash = await exchange.hashOrder({ ...altered, signature });
  const call = { gasPrice: (await ethers.provider.getFeeData()).gasPrice! };
  assert.equal(await wallet.isValidSignature(hash, signature, call), "0xffffffff");
  const expiry = fork.timestamp + 3600;
  await network.provider.send("hardhat_setStorageAt", [state.wallet, slot, ethers.toBeHex(expiry, 32)]);
  assert.equal(await wallet.sessionSignerAuthorizedUntil(signer.address), BigInt(expiry));
  assert.equal(await wallet.isValidSignature(hash, signature, call), "0x1626ba7e");
  assert.equal(await new ethers.Contract(state.controller,
    ["function isValidSignature(bytes32,bytes) view returns(bytes4)"], ethers.provider)
    .isValidSignature(hash, signature), "0xffffffff");
  const report = { block: fork.block, wallet: state.wallet, owner: state.controller,
    alteredMakerAmount: altered.makerAmount, unauthorizedSessionRejected: true,
    authorizedSessionAlteredOrderAccepted: true, daoControllerAlteredOrderRejected: true,
    authorizationMethod: "fork-only storage injection matching DepositWallet._setSessionSigner",
    liveTransactions: 0 };
  writeFileSync("output/deposit-session-mandate-fork.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  fork.remote.destroy();
}

main().catch(error => {
  console.error(error.code === "ERR_ASSERTION" ? error.message : String(error.shortMessage ?? error.message).replace(/https?:\/\/\S+/g, "[RPC redacted]"));
  process.exitCode = 1;
});
