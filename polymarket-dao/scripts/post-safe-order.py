"""Post the DAO-mandated Safe order to the Polymarket CLOB (live step of the Safe mandate route).

Reads the public addresses from output/live-mandate.json, derives the trading key from
POLYMARKET_PRIVATE_KEY exactly as scripts/live-mandate.ts does, and posts a post-only GTC BUY of
5 YES at 0.01 with maker = the guarded Safe, signer = the trading EOA (signature type 2). It
refuses to run if Polymarket's geoblock check does not answer blocked: false. Post-only at 0.01,
far below the best bid, so it rests on the book and cannot take liquidity.

    python scripts/post-safe-order.py           # post, print the CLOB answer
    python scripts/post-safe-order.py --cancel ORDER_ID
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen

TRADING_LABEL = b"polymarket-dao live trading 1"
STATE = Path(__file__).resolve().parent.parent / "output" / "live-mandate.json"


def read_json(url):
    with urlopen(Request(url, headers={"User-Agent": "polymarket-dao"}), timeout=20) as response:
        return json.load(response)


def trading_key(deployer_key: str) -> str:
    from eth_utils import keccak
    return "0x" + keccak(bytes.fromhex(deployer_key.removeprefix("0x").rjust(64, "0")) + TRADING_LABEL).hex()


def main():
    from polymarket import SecureClient
    parser = argparse.ArgumentParser()
    parser.add_argument("--cancel", metavar="ORDER_ID")
    parser.add_argument("--personal", action="store_true", help="the deployer's existing Safe, signed by the deployer key")
    args = parser.parse_args()
    geo = read_json("https://polymarket.com/api/geoblock")
    if geo.get("blocked") is not False:
        raise SystemExit(f"Polymarket geoblock check did not pass: {geo}")
    state = json.loads(STATE.read_text(encoding="utf-8"))
    account = state["personalSafe" if args.personal else "tradingSafe"]
    safe, trader, token = account["safe"], account["trader"], state["market"]["yes"]
    key = os.environ["POLYMARKET_PRIVATE_KEY"]
    with SecureClient.create(private_key=key if args.personal else trading_key(key), wallet=safe) as client:
        if args.cancel:
            print(json.dumps(client.cancel_order(order_id=args.cancel).model_dump(mode="json"), indent=2, default=str))
            print(json.dumps(client.get_order(order_id=args.cancel).model_dump(mode="json"), indent=2, default=str))
            return
        signed = client.create_limit_order(token_id=token, price="0.01", size="5", side="BUY", post_only=True)
        if signed.maker.lower() != safe.lower() or signed.signer.lower() != trader.lower() or signed.signature_type != 2 or str(signed.token_id) != token or signed.maker_amount > 50_000:
            raise SystemExit(f"Signed order does not match the mandate: maker={signed.maker} signer={signed.signer} type={signed.signature_type} amount={signed.maker_amount}")
        response = client.post_order(signed)
        print(json.dumps({"geoblock": geo, "safe": safe, "signer": trader, "makerAmount": signed.maker_amount, "takerAmount": signed.taker_amount, "response": response.model_dump(mode="json")}, indent=2, default=str))


if __name__ == "__main__":
    main()
