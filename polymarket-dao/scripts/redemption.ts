import { ethers } from "hardhat";
import { readFileSync } from "node:fs";
import { POLYGON, COLLATERAL_ADAPTER } from "./addresses";
import type { MarketRegistry } from "../typechain-types";

export const REDEMPTION = {
  adapter: COLLATERAL_ADAPTER,
  adapterCodeHash: "0x93b965351d01c1a128821ac79fc98a18105daefb46bda0d1e5b52306d713aa4f",
  owner: "0x4b1fdA89ecdEa3462345f31D230D9B32F3b31589",
  safe: "0x7a46dCFfa7064Fe54Ee848b125a5C58c3b9f5Ddb",
  skills: "0xfD3b8AE5385a752ACAA24fC7b77ca525d62C51Cb",
  oldVault: "0xA8323D854e2AfFCcF44389d94Da402C9E124CFC5",
  oldToken: "87712920673252297509200151045391015262449055764880659907762503287643101055970",
  principal: 100_000n,
};
export const ctfAbi = [
  "function balanceOf(address,uint256) view returns(uint256)",
  "function safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",
  "function isApprovedForAll(address,address) view returns(bool)",
  "function payoutDenominator(bytes32) view returns(uint256)",
  "function payoutNumerators(bytes32,uint256) view returns(uint256)",
  "function getOutcomeSlotCount(bytes32) view returns(uint256)",
  "function getCollectionId(bytes32,bytes32,uint256) view returns(bytes32)",
  "function getPositionId(address,bytes32) pure returns(uint256)",
];
export const adapterAbi = ["function splitPosition(address,bytes32,bytes32,uint256[],uint256)", "function redeemPositions(address,bytes32,bytes32,uint256[])", "function CONDITIONAL_TOKENS() view returns(address)", "function COLLATERAL_TOKEN() view returns(address)", "function USDCE() view returns(address)"];
export type RedemptionMarket = { slug: string; question: string; conditionId: string; yes: string; no: string; denominator: string; payouts: string[]; block: number };
export const redemptionMarket = () => JSON.parse(readFileSync("output/redemption-market.json", "utf8")) as RedemptionMarket;

export async function verifyRedemptionAssets(market: RedemptionMarket) {
  const adapter = new ethers.Contract(REDEMPTION.adapter, adapterAbi, ethers.provider);
  const ctf = new ethers.Contract(POLYGON.positions, ctfAbi, ethers.provider);
  const hash = ethers.keccak256(await ethers.provider.getCode(REDEMPTION.adapter));
  if (hash !== REDEMPTION.adapterCodeHash || await adapter.CONDITIONAL_TOKENS() !== POLYGON.positions || await adapter.COLLATERAL_TOKEN() !== POLYGON.collateral) throw new Error("Adapter deployment changed");
  if (await ctf.getOutcomeSlotCount(market.conditionId) !== 2n || await ctf.payoutDenominator(market.conditionId) === 0n) throw new Error("Expected real resolved binary condition");
  const ids = await Promise.all([1, 2].map(async i => String(await ctf.getPositionId(await adapter.USDCE(), await ctf.getCollectionId(ethers.ZeroHash, market.conditionId, i)))));
  if (ids[0] !== market.yes || ids[1] !== market.no) throw new Error("Market positions do not match the adapter");
  return { adapter, ctf };
}

export function registration(market: RedemptionMarket, closesAt: number): [bigint, MarketRegistry.MarketStruct, string] {
  // Registry cutoff is a future trading deadline; this fixture uses an already resolved condition.
  return [BigInt(market.conditionId), { yesToken: market.yes, noToken: market.no, skillTopic: 2, closesAt, exists: true }, `https://polymarket.com/market/${market.slug}`];
}
