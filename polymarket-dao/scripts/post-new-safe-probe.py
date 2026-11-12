"""One admission attempt from a fresh, unguarded factory Safe; cancel if admitted."""
import json
import sys
from pathlib import Path
from urllib.request import Request, urlopen

from eth_utils import keccak
from polymarket import SecureClient
from polymarket.errors import RequestRejectedError

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / "output/new-safe-probe.json"


def read_json(url):
    with urlopen(Request(url, headers={"User-Agent": "polymarket-dao"}), timeout=20) as response:
        return json.load(response)


def save(state):
    STATE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def main():
    state = json.loads(STATE.read_text(encoding="utf-8"))
    geo = read_json("https://polymarket.com/api/geoblock")
    if geo.get("blocked") is not False:
        raise SystemExit("Geoblock check failed")
    rows = {}
    for line in Path(r"C:\Users\iperc\polymarket-dao-secrets.md").read_text().splitlines():
        parts = line.split("|")
        if len(parts) == 4:
            rows[parts[1].strip()] = parts[2].strip().strip("`")
    key = "0x" + keccak(bytes.fromhex(rows["Main EOA private key"].removeprefix("0x")) + state["label"].encode()).hex()
    market = json.loads((ROOT / "output/live-mandate.json").read_text())["market"]
    book = read_json("https://clob.polymarket.com/book?token_id=" + market["yes"])
    if float(book["tick_size"]) > 0.01 or float(book["min_order_size"]) > 5:
        raise SystemExit("Market no longer supports this probe")
    with SecureClient.create(private_key=key, wallet=state["safe"]) as client:
        if "--auth-check" in sys.argv:
            state["authentication"] = {"credentialListedForSigner": client.credentials.key in client.fetch_api_keys(), "wallet": str(client.wallet), "walletType": client.wallet_type, "signer": state["trader"]}
            save(state)
            print(json.dumps(state["authentication"], indent=2))
            return
        if "attempt" in state:
            raise SystemExit("Attempt already persisted; do not repost automatically")
        signed = client.create_limit_order(token_id=market["yes"], price="0.01", size="5", side="BUY", post_only=True)
        if signed.signature_type != 2 or signed.maker.lower() != state["safe"].lower() or signed.signer.lower() != state["trader"].lower() or signed.maker_amount != 50_000:
            raise SystemExit("Probe order identity or budget mismatch")
        state["attempt"] = {"market": market["slug"], "token": market["yes"], "status": "pending", "geoblock": {"blocked": False, "country": geo["country"]}}
        save(state)
        try:
            response = client.post_order(signed).model_dump(mode="json")
        except RequestRejectedError as error:
            state["attempt"].update(status="rejected", error=str(error))
            save(state)
            print(json.dumps(state["attempt"], indent=2))
            return
        state["attempt"]["response"] = response
        save(state)
        order_id = response.get("order_id") or response.get("orderID")
        if order_id:
            state["attempt"]["cancel"] = client.cancel_order(order_id=order_id).model_dump(mode="json")
            save(state)
            state["attempt"]["order"] = client.get_order(order_id=order_id).model_dump(mode="json")
        state["attempt"]["status"] = "completed"
        save(state)
        print(json.dumps(state["attempt"], indent=2))


if __name__ == "__main__":
    main()
