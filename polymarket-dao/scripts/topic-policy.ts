import { createHash } from "node:crypto";
import { id, hexlify, isHexString } from "ethers";
import defaultPolicy from "../examples/dao-topic-policy.json";

export type SkillPolicy = {
  version: string;
  topics: { id: number; name: string; classifications: string[]; priority: number }[];
  skills: { name: string; relevance: number[] }[];
  boosts: { topic: number; skills: string[]; bonus: number }[];
  overrides: Record<string, number>;
};
export const daoTopicPolicy: SkillPolicy = defaultPolicy;

export function validateSkillPolicy(policy: SkillPolicy) {
  const names = policy.skills.map(skill => skill.name);
  if (!policy.version || names.length < 1 || names.length > 256 || new Set(names).size !== names.length || names.some(name => !name)) throw new Error("Invalid skill catalog");
  if (!policy.topics.length || policy.topics.length > 32 || policy.topics.some((topic, index) => topic.id !== index || !topic.name || !Number.isSafeInteger(topic.priority))) throw new Error("Invalid topic catalog");
  for (const skill of policy.skills) if (skill.relevance.length !== policy.topics.length || skill.relevance.some(weight => !Number.isInteger(weight) || weight < 0 || weight > 100)) throw new Error("Invalid skill relevance");
  for (const pair of policy.boosts) if (!policy.topics[pair.topic] || !pair.skills.length || pair.skills.some(name => !names.includes(name)) || !Number.isInteger(pair.bonus) || pair.bonus < 0 || pair.bonus > 100) throw new Error("Invalid complementary skills");
  for (const topic of Object.values(policy.overrides)) if (!Number.isInteger(topic) || !policy.topics[topic]) throw new Error("Invalid classification override");
}

export function calculatorArgs(policy: SkillPolicy) {
  validateSkillPolicy(policy);
  const flags = new Map(policy.skills.map((skill, index) => [skill.name, 1n << BigInt(index)]));
  const pairs = policy.boosts.map(pair => ({ topic: pair.topic, requiredSkills: pair.skills.reduce((bitmap, name) => bitmap | flags.get(name)!, 0n), bonus: pair.bonus }));
  return [policy.skills.map(skill => id(skill.name)), policy.topics.length, hexlify(Uint8Array.from(policy.skills.flatMap(skill => skill.relevance))), pairs] as const;
}

function classifications(event: any, market: any): string[] {
  const fields = [event, market].flatMap(item => [item?.category, item?.subcategory, ...(item?.categories ?? []).flatMap((category: any) => [category.slug, category.label]), ...(item?.tags ?? []).flatMap((tag: any) => [tag.slug, tag.label])]);
  return [...new Set(fields.filter((value): value is string => typeof value === "string" && value.length > 0).map(value => value.trim().toLowerCase().replace(/\s+/g, "-")))];
}

export function classifyMarket(event: any, market: any, policy = daoTopicPolicy) {
  validateSkillPolicy(policy);
  const labels = classifications(event, market);
  const override = [market.conditionId, market.id, market.slug, event.id, event.slug].map(key => policy.overrides[key]).find(value => value !== undefined);
  const matches = policy.topics.filter(topic => topic.classifications.some(label => labels.includes(label))).sort((a, b) => b.priority - a.priority);
  const top = matches.filter(topic => topic.priority === matches[0]?.priority);
  const selected = override ?? (top.length === 1 ? top[0].id : null);
  return { status: selected === null ? "needs-dao-classification" : "mapped", skillTopic: selected, expertise: selected === null ? null : policy.topics[selected].name, classifications: labels, candidates: matches.map(topic => topic.id), decision: override !== undefined ? "DAO override" : "DAO classification priority", mappingVersion: policy.version, mappingHash: createHash("sha256").update(JSON.stringify(policy)).digest("hex"), sourceHash: createHash("sha256").update(JSON.stringify({ event, market })).digest("hex") };
}

export function mappedRegistration(event: any, market: any, policy = daoTopicPolicy) {
  const mapping = classifyMarket(event, market, policy);
  const ids = typeof market.clobTokenIds === "string" ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
  const outcomes = typeof market.outcomes === "string" ? JSON.parse(market.outcomes) : market.outcomes;
  if (!isHexString(market.conditionId, 32) || !Array.isArray(ids) || ids.length !== 2 || !Array.isArray(outcomes) || outcomes.length !== 2 || ids.some(value => !/^\d+$/.test(String(value))) || ids[0] === ids[1]) throw new Error("Expected a binary market with distinct outcome IDs");
  const yes = outcomes.findIndex(value => String(value).toLowerCase() === "yes"), no = outcomes.findIndex(value => String(value).toLowerCase() === "no");
  if (yes < 0 || no < 0) throw new Error("Expected explicit Yes/No outcomes");
  if (mapping.skillTopic === null) throw new Error("DAO classification required");
  const closesAt = market.endDate ?? event.endDate;
  if (!closesAt || Number.isNaN(Date.parse(closesAt))) throw new Error("Closing date required");
  return { registration: { conditionId: market.conditionId, yesToken: String(ids[yes]), noToken: String(ids[no]), skillTopic: mapping.skillTopic, closesAt, uri: `https://polymarket.com/event/${event.slug ?? market.slug}` }, mapping };
}
