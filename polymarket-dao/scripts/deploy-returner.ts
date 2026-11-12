import { ethers } from "hardhat";
async function main() {
  const r = await (await ethers.getContractFactory("ShareReturner")).deploy();
  await r.waitForDeployment();
  console.log(await r.getAddress());
}
main().catch(e => { console.error(String(e.shortMessage ?? e.message).replace(/https?:\/\/\S+/g, "[RPC redacted]")); process.exitCode = 1; });
