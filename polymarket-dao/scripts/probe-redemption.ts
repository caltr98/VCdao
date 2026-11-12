import { ethers } from "hardhat";
import { writeFileSync } from "node:fs";
import { POLYGON } from "./addresses";

const abi = ["function CONDITIONAL_TOKENS() view returns(address)", "function COLLATERAL_TOKEN() view returns(address)", "function USDCE() view returns(address)"];
async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
  const addresses = ["0xAdA100Db00Ca00073811820692005400218FcE1f", "0xADa100874d00e3331D00F2007a9c336a65009718"];
  for (const address of addresses) {
    const code = await provider.getCode(address);
    const adapter = new ethers.Contract(address, abi, provider);
    console.log(JSON.stringify({ address, bytes: (code.length - 2) / 2, ...(code !== "0x" ? { ctf: await adapter.CONDITIONAL_TOKENS(), collateral: await adapter.COLLATERAL_TOKEN(), usdce: await adapter.USDCE(), codeHash: ethers.keccak256(code) } : {}) }));
  }
  const ctf = new ethers.Contract(POLYGON.positions, ["function payoutDenominator(bytes32) view returns(uint256)", "function payoutNumerators(bytes32,uint256) view returns(uint256)", "function getOutcomeSlotCount(bytes32) view returns(uint256)", "function getCollectionId(bytes32,bytes32,uint256) view returns(bytes32)", "function getPositionId(address,bytes32) pure returns(uint256)"], provider);
  const url = "https://gamma-api.polymarket.com/markets?closed=true&limit=100&order=updatedAt&ascending=false";
  const markets: any[] = await (await fetch(url)).json();
  for (const m of markets) {
    if (m.negRisk || !m.conditionId || !m.clobTokenIds) continue;
    const ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
    if (ids.length !== 2 || await ctf.getOutcomeSlotCount(m.conditionId) !== 2n) continue;
    const denominator: bigint = await ctf.payoutDenominator(m.conditionId);
    if (denominator === 0n) continue;
    const expected = await Promise.all([1, 2].map(async index => String(await ctf.getPositionId("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", await ctf.getCollectionId(ethers.ZeroHash, m.conditionId, index)))));
    if (!ids.every((id: string, i: number) => id === expected[i])) continue;
    const market = { slug: m.slug, question: m.question, conditionId: m.conditionId, yes: ids[0], no: ids[1], denominator: String(denominator), payouts: [String(await ctf.payoutNumerators(m.conditionId, 0)), String(await ctf.payoutNumerators(m.conditionId, 1))], block: await provider.getBlockNumber() };
    writeFileSync("output/redemption-market.json", JSON.stringify(market, null, 2) + "\n");
    console.log(JSON.stringify(market));
    provider.destroy();
    return;
  }
  provider.destroy();
  throw new Error("No genuinely resolved standard binary market found");
}
main().catch((error: any) => { console.error("Redemption probe failed:", error.code ?? error.reason ?? "details suppressed to protect RPC credentials"); process.exitCode = 1; });
