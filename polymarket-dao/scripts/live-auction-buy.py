"""LIVE solver buy for scripts/live-auction.ts: the deployer's Polymarket Safe buys 5 YES at the
recorded ask (FOK) and journals order id, settlement transaction and cost into output/live-auction.json.
Refuses to run unless Polymarket's geoblock check answers blocked: false, or if a buy is recorded."""
import json
from importlib import import_module

import httpx
from polymarket import SecureClient

probe = import_module("relayer-safe-probe")
PATH = probe.ROOT / "output/live-auction.json"


def main():
    state = json.loads(PATH.read_text())
    if "buy" in state:
        raise SystemExit("Buy already journaled")
    if "authorizeBuy" not in state:
        raise SystemExit("Authorize the open buy first")
    geo = httpx.get("https://polymarket.com/api/geoblock", timeout=20).json()
    if geo.get("blocked") is not False:
        raise SystemExit("Geoblocked here")
    rows, market = probe.secrets(), state["market"]
    state["buy"] = {"status": "pending", "country": geo["country"]}
    PATH.write_text(json.dumps(state, indent=2))
    with SecureClient.create(private_key=rows["Main EOA private key"], wallet=rows["Main EOA legacy Safe (admitted)"]) as client:
        response = client.place_limit_order(token_id=market["yes"], price=str(market["ask"]), size="5", side="BUY").model_dump(mode="json")
    hashes = response.get("transactions_hashes") or response.get("transactionsHashes") or []
    making = response.get("making_amount") or response.get("makingAmount")
    state["buy"].update(status=response.get("status"), response=response, orderId=response.get("order_id") or response.get("orderID"),
                        settlementTx=hashes[0] if hashes else None, cost=str(round(float(making) * 1e6)) if making else None)
    PATH.write_text(json.dumps(state, indent=2))
    print(json.dumps(state["buy"], indent=2))


if __name__ == "__main__":
    main()
