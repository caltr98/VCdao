"""LIVE executor side of the BetVault delivery route, one journaled step per flag.

The executor is the main EOA's default Deposit Wallet (the Builder key belongs to the same EOA;
the relayer refused session authorization for the derived "probe 3" wallet).
--authorize  owner authorizes a CLOB-scoped session key through Polymarket's relayer
--approvals  trading approvals for the wallet (relayed)
--market     choose a binary market and quote 5 shares; prints what the DAO must authorize
--buy        the session key places a FOK BUY for the quoted shares
--deliver    the session key relays [setApprovalForAll(vault), vault.fulfill(id, tx, orderHash)]
Keys are derived in memory and never written; the state file holds public data only.
"""
import json
import math
import sys
from importlib import import_module

import httpx
from eth_abi import encode
from eth_account import Account
from eth_utils import keccak
from polymarket import SecureClient
from polymarket._internal.actions.relayer.calls import TransactionCall

probe = import_module("relayer-safe-probe")
control = import_module("post-deposit-probe")
PATH = probe.ROOT / "output/live-delivery-session.json"
WALLET = "0x698330d073A672cCcBBA51B7025FC90d527292Bb"  # the main EOA's default Deposit Wallet
POSITIONS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
SHARES = 5


def load():
    return json.loads(PATH.read_text()) if PATH.exists() else {"wallet": WALLET}


def save(state):
    PATH.write_text(json.dumps(state, indent=2, default=str), encoding="utf-8")


def session_for(rows):
    raw = bytes.fromhex(rows["Main EOA private key"].removeprefix("0x"))
    return Account.from_key(keccak(raw + b"polymarket-dao delivery session 1"))


def once(state, name):
    if name in state:
        raise SystemExit(f"{name} already journaled; inspect {PATH.name} before retrying")


def geoblock():
    geo = httpx.get("https://polymarket.com/api/geoblock", timeout=20).json()
    if geo.get("blocked") is not False:
        raise SystemExit("Geoblocked here; run from an allowed country")
    return geo["country"]


def owner_client(rows):
    return SecureClient.create(private_key=rows["Main EOA private key"], wallet=WALLET, api_key=probe.builder_credentials(rows))


def session_client(rows):
    return SecureClient.create(private_key=session_for(rows).key.hex(), wallet=WALLET, api_key=probe.builder_credentials(rows))


def authorize(rows, state):
    once(state, "authorize")
    session = session_for(rows)
    state["authorize"] = {"status": "pending", "session": session.address, "scopes": ["CLOB"]}
    save(state)
    with owner_client(rows) as client:
        result = client.authorize_session_key(address=session.address, scopes=["CLOB"])
    state["authorize"].update(status="confirmed", validUntil=result.session_key.valid_until.isoformat(), transaction=str(result.transaction))
    save(state)
    print(json.dumps(state["authorize"], indent=2))


# Fallback when the relayer refuses the session-key endpoint: the owner self-calls the wallet.
def authorize_batch(rows, state):
    once(state, "authorizeBatch")
    session = session_for(rows)
    valid_until = int(__import__("time").time()) + 7 * 86400
    data = keccak(text="authorizeSessionSigner(address,uint256)")[:4] + encode(["address", "uint256"], [session.address, valid_until])
    state["authorizeBatch"] = {"status": "pending", "session": session.address, "validUntil": valid_until}
    save(state)
    with owner_client(rows) as client:
        outcome = client.execute_transaction(calls=[TransactionCall(to=WALLET, data="0x" + data.hex())], metadata="Authorize session signer").wait()
    state["authorizeBatch"].update(status="done", outcome=str(outcome))
    save(state)
    print(json.dumps(state["authorizeBatch"], indent=2))


def approvals(rows, state):
    once(state, "approvals")
    with owner_client(rows) as client:
        client.setup_trading_approvals()
        state["approvals"] = {"status": "done", "missing": str(client.get_trading_approvals_state().missing)}
    save(state)
    print(json.dumps(state["approvals"], indent=2))


# A binary standard-exchange market ending in more than a week, best ask between 0.20 and 0.30,
# so 5 shares cost 1–1.5 pUSD and clear the CLOB's 1-dollar marketable minimum.
def market(state):
    once(state, "market")
    with httpx.Client(timeout=25) as http:
        markets = http.get("https://gamma-api.polymarket.com/markets", params={"closed": "false", "active": "true", "limit": 100, "order": "volume24hr", "ascending": "false"}).json()
        for m in markets:
            ids = json.loads(m["clobTokenIds"]) if isinstance(m.get("clobTokenIds"), str) else m.get("clobTokenIds")
            if m.get("negRisk") or not m.get("acceptingOrders") or not ids or len(ids) != 2:
                continue
            if m.get("endDate", "") < "2026-10-12":
                continue
            book = http.get("https://clob.polymarket.com/book", params={"token_id": ids[0]}).json()
            asks = [(float(a["price"]), float(a["size"])) for a in book.get("asks", [])]
            if book.get("neg_risk") is not False or not asks or float(book.get("min_order_size", 99)) > SHARES:
                continue
            price, size = min(asks)
            if 0.20 <= price <= 0.30 and size >= SHARES:
                payment = math.ceil(price * SHARES * 1_000_000 * 1.05)
                state["market"] = {"slug": m["slug"], "conditionId": m["conditionId"], "yes": ids[0], "no": ids[1], "endDate": m["endDate"],
                                   "ask": price, "tickSize": book["tick_size"], "shares": SHARES * 1_000_000, "payment": payment}
                save(state)
                print(json.dumps(state["market"], indent=2))
                return
    raise SystemExit("No suitable market")


def buy(rows, state):
    once(state, "buy")
    if "authorizeBuy" not in state:
        raise SystemExit("Record the DAO authorizeBuy (id, proposal) in the state file first")
    country = geoblock()
    m = state["market"]
    state["buy"] = {"status": "pending", "country": country}
    save(state)
    with session_client(rows) as client:
        response = client.place_limit_order(token_id=m["yes"], price=str(m["ask"]), size=str(SHARES), side="BUY")
        state["buy"].update(status="posted", response=response.model_dump(mode="json"), apiKeyOwner=client.signer)
        save(state)
    print(json.dumps(state["buy"], indent=2))


def deliver(rows, state):
    once(state, "deliver")
    m, auth = state["market"], state["authorizeBuy"]
    held = int(httpx.post(rows["Polygon RPC (Alchemy)"], json={"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": POSITIONS, "data": "0x00fdd58e" + encode(["address", "uint256"], [WALLET, int(m["yes"])]).hex()}, "latest"]}).json()["result"], 16)
    if held < m["shares"]:
        raise SystemExit(f"Wallet holds {held} shares, needs {m['shares']}")
    response = state["buy"]["response"]
    order_hash = response.get("order_id") or response.get("orderID")
    settlement = (response.get("transactions_hashes") or response.get("transactionsHashes") or [None])[0]
    if not order_hash or not settlement:
        raise SystemExit("Buy response lacks order id or settlement transaction")
    approve = keccak(text="setApprovalForAll(address,bool)")[:4] + encode(["address", "bool"], [auth["vault"], True])
    fulfill = keccak(text="fulfill(bytes32,bytes32,bytes32)")[:4] + encode(["bytes32", "bytes32", "bytes32"], [bytes.fromhex(auth["id"][2:]), bytes.fromhex(settlement[2:]), bytes.fromhex(order_hash[2:])])
    calls = [TransactionCall(to=POSITIONS, data="0x" + approve.hex()), TransactionCall(to=auth["vault"], data="0x" + fulfill.hex())]
    state["deliver"] = {"status": "pending", "signer": "session"}
    save(state)
    with session_client(rows) as client:
        outcome = client.execute_transaction(calls=calls, metadata="BetVault delivery").wait()
    state["deliver"].update(status="done", outcome=str(outcome))
    save(state)
    print(json.dumps(state["deliver"], indent=2))


def main():
    rows, state = probe.secrets(), load()
    steps = {"--authorize": lambda: authorize(rows, state), "--authorize-batch": lambda: authorize_batch(rows, state), "--approvals": lambda: approvals(rows, state), "--market": lambda: market(state),
             "--buy": lambda: buy(rows, state), "--deliver": lambda: deliver(rows, state)}
    for flag, run in steps.items():
        if flag in sys.argv:
            return run()
    raise SystemExit("Select one of " + ", ".join(steps))


if __name__ == "__main__":
    main()
