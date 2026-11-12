import { readJson, printJson, POLYGON } from "./polymarket";
import { classifyMarket } from "./topic-policy";

async function main() {
  const slug = process.argv[2];
  const url = slug ? `https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}` : "https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=5";
  const response = await readJson(url);
  for (const market of Array.isArray(response) ? response : [response]) printJson(await describeMarket(market));
}

async function describeMarket(market: any) {
  const ids = typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
  const outcomes = typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes;
  if (!Array.isArray(ids) || ids.length !== 2 || !Array.isArray(outcomes) || outcomes.length !== 2) throw new Error("Expected a binary CTF market");
  return {
    question: market.question, slug: market.slug, conditionId: market.conditionId,
    topic: BigInt(market.conditionId), outcomes: outcomes.map((label: string, index: number) => ({ label, tokenId: ids[index] })),
    active: market.active, closed: market.closed, acceptingOrders: market.acceptingOrders, endDate: market.endDate,
    negativeRisk: market.negRisk, exchange: market.negRisk ? POLYGON.negRiskExchange : POLYGON.exchange,
    url: `https://polymarket.com/event/${market.events?.[0]?.slug ?? market.slug}`,
    expertiseMapping: classifyMarket(market.events?.[0] ?? {}, market),
  };
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
