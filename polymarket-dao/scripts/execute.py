"""Preview an onchain authorization, or submit one FOK order with an existing wallet.

The executor fronts the purchase. Delivery and payment use BetVault.fulfill.
No wallet keys are loaded unless --submit is present. No automatic retries.
"""
from __future__ import annotations

import argparse
import json
import os
from dataclasses import asdict
from decimal import Decimal, ROUND_DOWN
from pathlib import Path
from urllib.request import Request, urlopen

UNIT = Decimal(1_000_000)
COLLATERAL = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb"
POSITIONS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045"


def read_json(url, body=None):
    payload = None if body is None else json.dumps(body).encode()
    request = Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=20) as response:
        return json.load(response)


class Chain:
    def __init__(self, url, vault):
        self.url, self.vault = url, vault

    def rpc(self, method, params):
        response = read_json(self.url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        if "error" in response:
            raise RuntimeError(response["error"].get("message", "RPC failure"))
        return response["result"]

    def call(self, signature, outputs, intent=None):
        from eth_abi import decode
        from eth_utils import keccak
        data = keccak(text=signature)[:4].hex() + (intent.removeprefix("0x") if intent else "")
        result = self.rpc("eth_call", [{"to": self.vault, "data": "0x" + data}, "latest"])
        return decode(outputs, bytes.fromhex(result.removeprefix("0x")))

    def approved_buy(self, intent):
        self.validate_network(intent)
        values = self.call("buys(bytes32)", ["uint256", "uint256", "uint256", "uint256", "uint64", "address"], intent)
        buy = dict(zip(["market", "token_id", "shares", "payment", "deadline", "executor"], values))
        now = int(self.rpc("eth_getBlockByNumber", ["latest", False])["timestamp"], 16)
        if buy["deadline"] <= now + 120:
            raise ValueError("Less than two minutes remain for settlement and delivery")
        return buy

    def validate_network(self, intent):
        if len(intent) != 66 or not intent.startswith("0x"):
            raise ValueError("Expected a 32-byte authorization ID")
        if int(self.rpc("eth_chainId", []), 16) != 137:
            raise ValueError("Expected Polygon mainnet")
        if self.call("status(bytes32)", ["uint8"], intent)[0] != 1:
            raise ValueError("Buy is not currently authorized")
        if self.call("collateral()", ["address"])[0].lower() != COLLATERAL or self.call("positions()", ["address"])[0].lower() != POSITIONS:
            raise ValueError("Unsupported collateral or outcome token contract")


def plan_order(buy, book, max_price=None):
    validate_book(buy, book)
    tick = Decimal(book["tick_size"])
    price = (Decimal(buy["payment"]) / Decimal(buy["shares"]) / tick).to_integral_value(rounding=ROUND_DOWN) * tick
    if max_price is not None:
        limit = Decimal(max_price)
        if limit > price or limit % tick:
            raise ValueError("Requested price must respect the quote and tick size")
        price = limit
    if not Decimal(0) < price < Decimal(1):
        raise ValueError("Quote is outside the book price range")
    return {"token_id": str(buy["token_id"]), "side": "BUY", "amount": str(Decimal(buy["payment"]) / UNIT), "max_spend": str(Decimal(buy["payment"]) / UNIT), "max_price": str(price), "order_type": "FOK"}


def validate_book(buy, book):
    if str(book.get("asset_id")) != str(buy["token_id"]) or int(book["market"], 16) != buy["market"]:
        raise ValueError("Order book does not match the approved market and outcome")
    if Decimal(book["tick_size"]) <= 0 or Decimal(buy["shares"]) / UNIT < Decimal(book["min_order_size"]):
        raise ValueError("Invalid tick size or quantity below the minimum")


def save_attempt(journal, value):
    journal.seek(0)
    json.dump(value, journal, indent=2, default=str)
    journal.truncate()
    journal.flush()
    os.fsync(journal.fileno())


def submit(chain, intent, buy, order, journal_path):
    from polymarket import SecureClient
    if read_json("https://polymarket.com/api/geoblock").get("blocked") is not False:
        raise RuntimeError("Polymarket trading availability check did not pass")
    key = os.environ["POLYMARKET_PRIVATE_KEY"]
    journal_path.parent.mkdir(parents=True, exist_ok=True)
    with journal_path.open("x+", encoding="utf-8") as journal:
        record = {"state": "attempt_started", "vault": chain.vault, "id": intent, "executor": buy["executor"], "order": order}
        save_attempt(journal, record)
        with SecureClient.create(private_key=key, wallet=buy["executor"]) as client:
            send_once(client, chain, intent, buy, order, journal, record)


def send_once(client, chain, intent, buy, order, journal, record):
    signed = client.create_market_order(**order)
    validate_signed_order(signed, buy)
    if chain.approved_buy(intent) != buy:
        raise RuntimeError("Authorization changed before submission")
    record.update(state="signed_not_yet_posted", signed_order={key: value for key, value in asdict(signed).items() if key != "signature"})
    save_attempt(journal, record)
    response = client.post_order(signed)
    record.update(state="accepted" if response.ok else "rejected", response=response.model_dump(mode="json"))
    save_attempt(journal, record)
    print(json.dumps(record, indent=2, default=str))
    if response.ok and response.trade_ids:
        record.update(state="settlement_reported", settlement_transactions=client.wait_for_order_fill_settlement(response, timeout_s=45))
        save_attempt(journal, record)
        print(json.dumps(record, indent=2, default=str))
    if not response.ok:
        raise RuntimeError("Order rejected; see the attempt journal")


def validate_signed_order(signed, buy):
    if signed.maker.lower() != buy["executor"].lower() or str(signed.token_id) != str(buy["token_id"]):
        raise ValueError("Signed order uses another wallet or outcome")
    if signed.side != "BUY" or signed.order_type != "FOK" or not 0 < signed.maker_amount <= buy["payment"]:
        raise ValueError("Signed order exceeds the authorized purchase")
    if signed.taker_amount < buy["shares"]:
        raise ValueError("Fees or rounding reduce the signed order below the required shares; use a lower --max-price or a new proposal")


def main():
    args = arguments()
    chain = Chain(os.environ["POLYGON_RPC_URL"], args.vault)
    buy = chain.approved_buy(args.id)
    book = read_json(f'https://clob.polymarket.com/book?token_id={buy["token_id"]}')
    order = plan_order(buy, book, args.max_price)
    print(json.dumps({"mode": "submit" if args.submit else "preview", "buy": buy, "order": order, "note": "Fees and available liquidity can leave fewer shares than required. Verify settlement and delivery before marking the proposal fulfilled."}, indent=2, default=str))
    if args.submit:
        submit(chain, args.id, buy, order, Path(args.journal or f"output/{args.vault.lower()}-{args.id}.json"))


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vault")
    parser.add_argument("id")
    parser.add_argument("--submit", action="store_true")
    parser.add_argument("--max-price", help="Optional lower execution price to leave room for fees")
    parser.add_argument("--journal", help="Exclusive attempt file; an existing file prevents resubmission")
    return parser.parse_args()


if __name__ == "__main__":
    main()
