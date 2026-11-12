import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { classifyMarket, daoTopicPolicy, mappedRegistration, type SkillPolicy } from "./topic-policy";

const input = process.argv[2];
if (!input) throw new Error("Usage: npx ts-node scripts/map-topics.ts events.json [output.json] [policy.json]");
const source = JSON.parse(readFileSync(input, "utf8").replace(/^\uFEFF/, ""));
const policy: SkillPolicy = process.argv[4] ? JSON.parse(readFileSync(process.argv[4], "utf8").replace(/^\uFEFF/, "")) : daoTopicPolicy;
const retrievedAt = new Date().toISOString();
const events = Array.isArray(source) ? source : [source];
const mappings = events.flatMap(event => (event.markets?.length ? event.markets : [event]).map((market: any) => describe(event, market)));
const report = { source: input, retrievedAt, mappingVersion: policy.version, policy, marketCount: mappings.length, mapped: mappings.filter((row: any) => row.mapping.skillTopic !== null).length, needsDaoDecision: mappings.filter((row: any) => row.mapping.skillTopic === null).length, registrationReady: mappings.filter((row: any) => row.registration !== null).length, markets: mappings };
const output = process.argv[3] ?? "output/topic-mapping.json";
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ marketCount: report.marketCount, mapped: report.mapped, needsDaoDecision: report.needsDaoDecision, registrationReady: report.registrationReady, output }));

function describe(event: any, market: any) {
  const mapping = classifyMarket(event, market, policy);
  try { return { eventId: event.id, marketId: market.id, conditionId: market.conditionId, question: market.question, mapping, registration: mappedRegistration(event, market, policy).registration, error: null }; }
  catch (error) { return { eventId: event.id, marketId: market.id, conditionId: market.conditionId, question: market.question, mapping, registration: null, error: (error as Error).message }; }
}
