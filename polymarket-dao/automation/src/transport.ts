import { createHmac } from "node:crypto";
import { parseUnits } from "ethers";
import { CheckFailure, parseJson, type Credentials, type Journal, type OrderAttempt, type RunnerState } from "./config";
import type { OrderFields } from "../../scripts/order";

// Fixed hosts: neither configuration nor public input can redirect signed requests or credentials,
// and authenticated requests do not follow HTTP redirects either.
const CLOB = "https://clob.polymarket.com";
const GEOBLOCK = "https://polymarket.com/api/geoblock";
// Statuses the official SDK (polymarket-client 0.11.0) accepts as a placed order.
const POSTED = ["live", "matched", "delayed"];
const RESPONSE_LIMIT_BYTES = 1_048_576;

export function parseCredentials(json: string | undefined): Credentials {
  const value = json ? parseJson(json, "CLOB_CREDENTIALS") : null;
  if (!value?.address || !value.key || !value.secret || !value.passphrase) throw new CheckFailure("Missing CLOB credentials");
  return { address: String(value.address), key: String(value.key), secret: String(value.secret), passphrase: String(value.passphrase) };
}

// Same fields as the SDK's orderToJsonV2. The salt is serialized as a JSON number from the bigint,
// never through a JS Number conversion.
export function orderBody(order: OrderFields, apiKey: string): string {
  const body = JSON.stringify({ deferExec: false, postOnly: false, order: { builder: order.builder, expiration: "0", maker: order.maker, makerAmount: order.makerAmount.toString(), metadata: order.metadata, salt: "EXACT_SALT", side: "BUY", signature: order.signature, signatureType: Number(order.signatureType), signer: order.signer, takerAmount: order.takerAmount.toString(), timestamp: order.timestamp.toString(), tokenId: order.tokenId.toString() }, orderType: "FOK", owner: apiKey });
  return body.replace('"salt":"EXACT_SALT"', `"salt":${order.salt.toString()}`);
}

export function authHeaders(credentials: Credentials, timestamp: string, method: string, path: string, body = "") {
  const signature = createHmac("sha256", Buffer.from(credentials.secret, "base64")).update(timestamp + method + path + body).digest("base64url");
  return { "Content-Type": "application/json", POLY_ADDRESS: credentials.address, POLY_API_KEY: credentials.key, POLY_PASSPHRASE: credentials.passphrase, POLY_TIMESTAMP: timestamp, POLY_SIGNATURE: signature.padEnd(Math.ceil(signature.length / 4) * 4, "=") };
}

function now() {
  return Math.floor(Date.now() / 1000).toString();
}

export async function boundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return text + decoder.decode();
      bytes += next.value.byteLength;
      if (bytes > RESPONSE_LIMIT_BYTES) throw new CheckFailure("HTTP response exceeded limit");
      text += decoder.decode(next.value, { stream: true });
    }
  } finally { await reader.cancel(); }
}

export async function boundedJson(response: Response): Promise<any> {
  const text = await boundedText(response);
  if (!text) throw new CheckFailure("Empty HTTP response");
  return parseJson(text, "HTTP response");
}

// This evaluates the Worker's egress location, which is not the DAO operator's jurisdiction.
export async function tradingAvailable(request: typeof fetch) {
  const geo = await boundedJson(await request(GEOBLOCK, { signal: AbortSignal.timeout(10_000) }));
  if (geo?.blocked !== false) throw new CheckFailure("Trading availability check did not permit submission");
}

export type OrderTarget = { digest: string; wallet: string; exchange: string };

/// Persist before the POST and never repeat a digest automatically. The exchange caps fills per
/// digest, so a repeat cannot overspend, but resubmitting a killed FOK order is an operator decision.
export async function postOnce(order: OrderFields, target: OrderTarget, credentials: Credentials, state: RunnerState, journal: Journal, request: typeof fetch = fetch) {
  if (state.attempts[target.digest]) return "already-attempted";
  await tradingAvailable(request);
  const body = orderBody(order, credentials.key);
  state.attempts[target.digest] = { ...target, status: "posting", attemptedAt: new Date().toISOString() };
  await journal.save(state);
  Object.assign(state.attempts[target.digest], await submitOrder(body, target.digest, credentials, request));
  await journal.save(state);
  return state.attempts[target.digest].status;
}

async function submitOrder(body: string, digest: string, credentials: Credentials, request: typeof fetch): Promise<Partial<OrderAttempt>> {
  const headers = authHeaders(credentials, now(), "POST", "/order", body);
  try {
    const response = await request(`${CLOB}/order`, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return classifyOrderResponse(response.status, await readResult(response), digest, credentials);
  } catch { return { status: "unknown", code: "NO_RESPONSE" }; }
}

// An unreadable body leaves the outcome unknown; it is never treated as a rejection.
async function readResult(response: Response) {
  try { return JSON.parse(await boundedText(response)); } catch { return undefined; }
}

/// Mirrors the SDK: acceptance needs success, an empty error message and a placed status. A 4xx
/// refused the request. Server errors, redirects and 2xx bodies without the SDK's `success` and
/// `status` fields stay unknown until the order read by digest settles them.
export function classifyOrderResponse(httpStatus: number, result: any, digest: string, credentials: Credentials): Partial<OrderAttempt> {
  const message = redacted(result?.errorMsg || result?.error, credentials);
  if (httpStatus >= 500 || httpStatus < 200) return { status: "unknown", httpStatus, code: `HTTP_${httpStatus}`, message };
  if (httpStatus >= 400) return { status: "rejected", httpStatus, code: rejectionCode(httpStatus, result), message };
  if (httpStatus >= 300 || typeof result?.success !== "boolean" || typeof result.status !== "string") return { status: "unknown", httpStatus, code: `HTTP_${httpStatus}` };
  if (!placed(result)) return { status: "rejected", httpStatus, code: rejectionCode(httpStatus, result), message };
  if (String(result.orderID).toLowerCase() !== digest.toLowerCase()) return { status: "unknown", httpStatus, code: "ORDER_ID_MISMATCH" };
  return { status: "accepted", httpStatus, code: String(result.status) };
}

function placed(result: any) {
  return result?.success === true && !result.errorMsg && POSTED.includes(result.status);
}

// The SDK's RejectedOrder codes that matter for a single FOK buy.
function rejectionCode(httpStatus: number, result: any) {
  const message = String(result?.errorMsg ?? "");
  if (result?.status === "unmatched") return "unmatched";
  if (message.startsWith("order couldn't be fully filled")) return "fok_not_filled";
  if (message.includes("not enough balance / allowance")) return "not_enough_balance";
  return `HTTP_${httpStatus}`;
}

// Diagnostics are public: remove credential values and bound the length.
function redacted(text: unknown, credentials: Credentials) {
  if (typeof text !== "string" || !text) return undefined;
  const secrets = [credentials.key, credentials.secret, credentials.passphrase].filter(Boolean);
  return secrets.reduce((value, secret) => value.split(secret).join("[redacted]"), text).slice(0, 300);
}

/// The CLOB's own record of an order, read with account authentication.
export async function readVenueOrder(digest: string, credentials: Credentials, request: typeof fetch = fetch) {
  const path = `/data/order/${digest}`;
  const response = await request(`${CLOB}${path}`, { headers: authHeaders(credentials, now(), "GET", path), redirect: "manual", signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) return { status: "not-found" };
  if (!response.ok) throw new CheckFailure(`Order read returned HTTP ${response.status}`);
  return venueRecord(await boundedText(response), digest);
}

function venueRecord(text: string, digest: string) {
  const order = text.trim() && text.trim() !== "null" ? parseJson(text, "Order read") : null;
  if (!order?.id) return { status: "not-found" };
  if (String(order.id).toLowerCase() !== digest.toLowerCase()) throw new CheckFailure("Order read returned another order");
  return { status: String(order.status), sizeMatched: String(order.size_matched ?? ""), originalSize: String(order.original_size ?? "") };
}

export async function validateBook(order: OrderFields, negativeRisk: boolean, request: typeof fetch = fetch) {
  const response = await request(`${CLOB}/book?token_id=${order.tokenId}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new CheckFailure("Order book unavailable");
  const book = await boundedJson(response) as { asset_id?: string; tick_size?: string; min_order_size?: string | number; neg_risk?: boolean };
  if (book.asset_id !== order.tokenId.toString() || book.neg_risk !== negativeRisk) throw new CheckFailure("Order book outcome/exchange mismatch");
  checkOrderShape(order, parseUnits(book.tick_size ?? "0", 6), parseUnits(String(book.min_order_size ?? "0"), 6));
}

/// Refuse a FOK BUY the official SDK would not build. Its market-order builder rounds the pUSD
/// amount to two decimals; this check also keeps shares to two decimals and the price on an exact
/// tick multiple within [tick, 1 - tick], a subset of what that builder emits. Amounts and tick
/// are six-decimal integers; price = makerAmount / takerAmount.
export function checkOrderShape(order: Pick<OrderFields, "makerAmount" | "takerAmount">, tick: bigint, minimum: bigint) {
  const scaledPrice = order.makerAmount * 1_000_000n;
  if (tick <= 0n || minimum <= 0n || order.takerAmount < minimum) throw new CheckFailure("Invalid tick or quantity below minimum");
  if (order.makerAmount % 10_000n !== 0n) throw new CheckFailure("Principal must have at most two decimals");
  if (order.takerAmount % 10_000n !== 0n) throw new CheckFailure("Shares must have at most two decimals");
  if (scaledPrice % (order.takerAmount * tick) !== 0n) throw new CheckFailure("Approved price is not on the current tick");
  if (scaledPrice < order.takerAmount * tick || scaledPrice > order.takerAmount * (1_000_000n - tick)) throw new CheckFailure("Approved price is outside the tradable range");
}
