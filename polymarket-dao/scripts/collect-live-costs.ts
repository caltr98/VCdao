import { Interface, JsonRpcProvider, formatUnits } from "ethers";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const OUT = "output/benchmarks-bitmap";
const provider = new JsonRpcProvider("https://polygon.drpc.org", 137, { staticNetwork: true });
const journalPath = "output/live-dao-funded-redemption.json";
const journal = JSON.parse(readFileSync(journalPath, "utf8").replace(/^\uFEFF/, ""));
const auction = JSON.parse(readFileSync("output/live-auction.json", "utf8"));
const iface = new Interface(JSON.parse(readFileSync("artifacts/contracts/MarketGovernor.sol/MarketGovernor.json", "utf8")).abi);
const rows: any[] = [];
const usdPrice = "0.111714934938384707650273224";
const priceUnits = BigInt(usdPrice.replace(".", ""));
const encode = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? String(item) : item, 2);

function add(label: string, hash: string, gas: bigint, price: bigint, payer: string, run: string, scope: string) {
  const fee = gas * price;
  rows.push({ run_id: run, operation: label, transaction_hash: hash, gas_used: String(gas), gas_price_wei: String(price), fee_wei: String(fee), fee_POL: formatUnits(fee, 18), fee_USD_annual_price: formatUnits(fee * priceUnits, 45), network_fee_payer: payer, measurement_scope: scope, evidence: run === "governed-redemption" ? journalPath : "Polygon RPC receipt", environment: "Polygon mainnet" });
}

async function receipt(label: string, hash: string, scope = "whole transaction") {
  const value = await provider.getTransactionReceipt(hash);
  if (!value || value.status !== 1) throw new Error(`Successful receipt required for ${label}`);
  add(label, hash, value.gasUsed, value.gasPrice, value.from, "purchase-delivery", scope);
  return value;
}

async function buyGovernance() {
  const end = await receipt("buy.execute", auction.authorizeBuy.executeTx);
  const topics = ["ProposalCreated", "VoteCast", "VoteCastWithParams", "ProposalQueued"].map(name => iface.getEvent(name)!.topicHash);
  const logs = await provider.getLogs({ address: auction.dao.governor, fromBlock: auction.dao.startBlock, toBlock: end.blockNumber, topics: [topics] });
  const selected = logs.map(log => ({ log, event: iface.parseLog(log) })).filter(({ event }) => event?.args.proposalId === BigInt(auction.authorizeBuy.proposal));
  const visited = new Set<string>();
  for (const { log, event } of selected) {
    if (visited.has(log.transactionHash)) continue;
    visited.add(log.transactionHash);
    const operation = event!.name === "ProposalCreated" ? "propose" : event!.name === "ProposalQueued" ? "queue" : "vote";
    await receipt(`buy.${operation}`, log.transactionHash);
  }
  for (const operation of ["buy.propose", "buy.vote", "buy.queue"]) if (!rows.some(row => row.operation === operation)) throw new Error(`Missing ${operation}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  for (const [operation, transaction] of Object.entries(journal.transactions) as [string, any][]) {
    if (!transaction.receipt || transaction.receipt.status !== 1) throw new Error(`Successful journal receipt required: ${operation}`);
    const gas = BigInt(transaction.receipt.gasUsed), price = BigInt(transaction.receipt.gasPrice);
    if (gas * price !== BigInt(transaction.receipt.fee)) throw new Error(`Journal fee mismatch: ${operation}`);
    add(operation, transaction.hash, gas, price, "0x4b1fdA89ecdEa3462345f31D230D9B32F3b31589", "governed-redemption", "whole transaction");
  }
  try {
    await buyGovernance();
    await receipt("exchange.settlement", auction.buy.settlementTx, "whole settlement transaction; order-specific gas allocation not measured");
    const match = auction.deliver.outcome.match(/transaction_hash='(0x[0-9a-f]{64})'/i);
    if (!match) throw new Error("Delivery hash required");
    await receipt("delivery.andPayment", match[1]);
    const sum = journal.transactions ? Object.values(journal.transactions).reduce((total: bigint, tx: any) => total + BigInt(tx.receipt.fee), 0n) : 0n;
    if (sum !== BigInt(journal.result.totalNetworkFee)) throw new Error("Total journal fee mismatch");
    writeFileSync(`${OUT}/live-operations.json`, encode({ price: { source: "CoinGecko POL", period: "2025-10-02 to 2026-10-02", meanUSDPerPOL: usdPrice, dailyObservations: 366 }, records: rows, journalSha256: createHash("sha256").update(readFileSync(journalPath)).digest("hex"), dataSources: [journalPath, "output/live-auction.json", "Polygon RPC"], distinctRuns: true, collectedAt: new Date().toISOString(), refundPOL: formatUnits(BigInt(journal.result.refund.amount), 18) }) + "\n");
    const keys = Object.keys(rows[0]), quote = (value: unknown) => '"' + String(value ?? "").replace(/"/g, '""') + '"';
    writeFileSync(`${OUT}/live-operations.csv`, [keys.join(","), ...rows.map(row => keys.map(key => quote(row[key])).join(","))].join("\n") + "\n");
    console.log(encode(rows.filter(row => row.run_id === "purchase-delivery")));
  } finally { provider.destroy(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
