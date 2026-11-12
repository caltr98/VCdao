import { ethers, network } from "hardhat";
import { POLYGON } from "./addresses";

/// Reset the in-process Hardhat network to the latest Polygon block. Nothing is sent to Polygon.
/// `remote` reads logs up to the pinned block; the caller destroys it. The RPC URL may carry an
/// API key, so it is never part of a report.
export async function forkPolygon() {
  if (network.name !== "hardhat") throw new Error("Fork checks run only on the in-process Hardhat network");
  const rpc = process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com";
  const remote = new ethers.JsonRpcProvider(rpc);
  const source = await remote.getBlock("latest");
  if (!source?.hash || (await remote.getNetwork()).chainId !== POLYGON.chainId) throw new Error("Expected Polygon RPC");
  await network.provider.send("hardhat_reset", [{ forking: { jsonRpcUrl: rpc, blockNumber: source.number } }]);
  // Hardhat has no hardfork history for chain 137, so calls cannot execute on the fork block itself.
  // One local block puts every later call on local state.
  await network.provider.send("hardhat_mine", ["0x1"]);
  return { remote, block: source.number, blockHash: source.hash, timestamp: source.timestamp };
}
