import { ethers } from "ethers";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";

const walletAddress = "0x03360EEC0D055a915e5cBf075447Ef36C6B6Ffb6";
const create = process.env.CLOB_AUTH_ACTION === "create";
const reportPath = create ? "output/clob-wallet-auth-wrapped-create.json" : "output/clob-wallet-auth-wrapped.json";
const authTypes = { ClobAuth: [
  { name: "address", type: "address" }, { name: "timestamp", type: "string" },
  { name: "nonce", type: "uint256" }, { name: "message", type: "string" }
] };
const nestedTypes = { ...authTypes, TypedDataSign: [
  { name: "contents", type: "ClobAuth" }, { name: "name", type: "string" },
  { name: "version", type: "string" }, { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" }, { name: "salt", type: "bytes32" }
] };

function secrets() {
  const rows: Record<string, string> = {};
  for (const line of readFileSync("C:/Users/iperc/polymarket-dao-secrets.md", "utf8").split(/\r?\n/)) {
    const match = line.match(/^\| ([^|]+) \| `([^`]+)` \|/);
    if (match) rows[match[1].trim()] = match[2];
  }
  return rows;
}

async function main() {
  if (existsSync(reportPath) && readFileSync(reportPath, "utf8").includes('"status": "accepted"')) throw new Error("Already accepted");
  const rows = secrets();
  const key = ethers.keccak256(ethers.concat([`0x${rows["Main EOA private key"].replace(/^0x/, "")}`,
    ethers.toUtf8Bytes("polymarket-dao relayer admission probe 3")]));
  const signer = new ethers.Wallet(key);
  const provider = new ethers.JsonRpcProvider(rows["Polygon RPC (Alchemy)"]);
  const wallet = new ethers.Contract(walletAddress, ["function owner() view returns(address)",
    "function isValidSignature(bytes32,bytes) view returns(bytes4)"], provider);
  if ((await wallet.owner()).toLowerCase() !== signer.address.toLowerCase()) throw new Error("Control wallet owner mismatch");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const contents = { address: walletAddress, timestamp, nonce: 0,
    message: "This message attests that I control the given wallet" };
  const appDomain = { name: "ClobAuthDomain", version: "1", chainId: 137 };
  const inner = await signer.signTypedData(appDomain, nestedTypes, { contents, name: "DepositWallet", version: "1",
    chainId: 137, verifyingContract: walletAddress, salt: ethers.ZeroHash });
  const description = ethers.toUtf8Bytes(ethers.TypedDataEncoder.from(authTypes).encodeType("ClobAuth"));
  const signature = ethers.concat([inner, ethers.TypedDataEncoder.hashDomain(appDomain),
    ethers.TypedDataEncoder.hashStruct("ClobAuth", authTypes, contents), description,
    ethers.toBeHex(description.length, 2)]);
  const digest = ethers.TypedDataEncoder.hash(appDomain, authTypes, contents);
  const gasPrice = (await provider.getFeeData()).gasPrice! * 2n;
  if (await wallet.isValidSignature(digest, signature, { gasPrice, gasLimit: 5_000_000 }) !== "0x1626ba7e") {
    throw new Error("On-chain wrapped ClobAuth check failed");
  }
  const endpoint = create ? "/auth/api-key" : "/auth/derive-api-key";
  const response = await fetch(`https://clob.polymarket.com${endpoint}`, { method: create ? "POST" : "GET", headers: {
    POLY_ADDRESS: walletAddress, POLY_SIGNATURE: signature, POLY_TIMESTAMP: timestamp, POLY_NONCE: "0"
  }, redirect: "manual" });
  const body: any = await response.json();
  const accepted = response.ok && ["apiKey", "secret", "passphrase"].every(name => typeof body[name] === "string");
  if (accepted) {
    appendFileSync("C:/Users/iperc/polymarket-dao-secrets.md", "\n# EOA-owned control Deposit Wallet CLOB credentials\n\n" +
      ["apiKey", "secret", "passphrase"].map(name => `| Control wallet CLOB ${name} | \`${body[name]}\` |`).join("\n") + "\n");
  }
  const report = { wallet: walletAddress, signer: signer.address, onchainERC1271: true,
    endpoint, httpStatus: response.status,
    status: accepted ? "accepted" : "rejected", error: accepted ? undefined : String(body.error ?? body.message ?? "unknown").slice(0, 200),
    credentialsStoredOutsideProject: accepted };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(String(error.shortMessage ?? error.message).replace(/https?:\/\/\S+/g, "[URL redacted]")); process.exitCode = 1; });
