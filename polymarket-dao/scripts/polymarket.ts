import { Interface, LogDescription } from "ethers";
import { POLYGON, sameAddress } from "./addresses";

export { POLYGON, sameAddress };

export const exchangeAbi = new Interface([
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)",
]);
export const assetAbi = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
  "function setApprovalForAll(address operator,bool approved)",
]);

export type ReceiptLog = { address: string; topics: readonly string[]; data: string };
export type Purchase = { executor: string; tokenId: bigint; shares: bigint; payment: bigint; orderHash: string };

export function verifyPurchaseLogs(logs: readonly ReceiptLog[], purchase: Purchase) {
  const fills = logs.filter(log => sameAddress(log.address, POLYGON.exchange) || sameAddress(log.address, POLYGON.negRiskExchange))
    .map(log => exchangeAbi.parseLog(log)).filter((event): event is LogDescription => event !== null && event.name === "OrderFilled");
  const selected = fills.filter(event => event.args.orderHash.toLowerCase() === purchase.orderHash.toLowerCase());
  if (selected.length === 0) throw new Error("No matching V2 Polymarket OrderFilled event");
  for (const event of selected) validateFill(event, purchase);
  const filledShares = selected.reduce((total, event) => total + event.args.takerAmountFilled, 0n);
  const filledCost = selected.reduce((total, event) => total + event.args.makerAmountFilled, 0n);
  if (filledShares < purchase.shares || filledCost > purchase.payment) throw new Error("Order fill amounts do not satisfy the quote");
  const received = positionDelta(logs, purchase);
  const spent = -collateralDelta(logs, purchase.executor);
  if (received < purchase.shares || spent <= 0n || spent > purchase.payment) throw new Error("Settlement balances do not satisfy the approved quote");
  return { sharesReceived: received.toString(), collateralSpent: spent.toString(), fillCount: selected.length };
}

function validateFill(event: LogDescription, purchase: Purchase) {
  if (!sameAddress(event.args.maker, purchase.executor) || event.args.side !== 0n || event.args.tokenId !== purchase.tokenId) {
    throw new Error("Order fill has the wrong buyer, side or outcome");
  }
  if (event.args.makerAmountFilled <= 0n || event.args.takerAmountFilled <= 0n) throw new Error("Empty fill");
}

function transferDelta(from: string, to: string, value: bigint, owner: string): bigint {
  return (sameAddress(to, owner) ? value : 0n) - (sameAddress(from, owner) ? value : 0n);
}

function collateralDelta(logs: readonly ReceiptLog[], owner: string): bigint {
  return logs.filter(log => sameAddress(log.address, POLYGON.collateral)).reduce((delta, log) => {
    const event = assetAbi.parseLog(log);
    return delta + (event?.name === "Transfer" ? transferDelta(event.args.from, event.args.to, event.args.value, owner) : 0n);
  }, 0n);
}

function positionDelta(logs: readonly ReceiptLog[], purchase: Purchase): bigint {
  return logs.filter(log => sameAddress(log.address, POLYGON.positions)).reduce((delta, log) => {
    const event = assetAbi.parseLog(log);
    if (event?.name === "TransferSingle" && event.args.id === purchase.tokenId) {
      return delta + transferDelta(event.args.from, event.args.to, event.args.value, purchase.executor);
    }
    if (event?.name !== "TransferBatch") return delta;
    return event.args.ids.reduce((total: bigint, id: bigint, index: number) => total + (id === purchase.tokenId ? transferDelta(event.args.from, event.args.to, event.args[4][index], purchase.executor) : 0n), delta);
  }, 0n);
}

export async function readJson(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${new URL(url).hostname}`);
  return response.json();
}

export function printJson(value: unknown) {
  console.log(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2));
}
