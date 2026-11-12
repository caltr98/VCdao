"""Persist and transport one DAO contract-owner admission experiment."""
import json
import sys
import time
from dataclasses import asdict
from importlib import import_module
from pathlib import Path

import httpx
from eth_abi import encode
from eth_account.messages import encode_typed_data
from eth_utils import keccak
from polymarket import SecureClient
from polymarket.environments import PRODUCTION
from polymarket.errors import RequestRejectedError
from polymarket.models.clob.orders import SignedOrder
from polymarket._internal.actions.orders.types import UnsignedOrder
from polymarket._internal.actions.orders.typed_data import build_order_typed_data
from polymarket._internal.actions.relayer.calls import TransactionCall, erc20_transfer_call
from polymarket._internal.actions.relayer.signing.deposit_wallet import build_deposit_wallet_typed_data, sign_deposit_wallet_batch
from polymarket._internal.actions.relayer.gasless import build_deposit_wallet_payload
from polymarket._internal.actions.relayer.auth import build_builder_key_headers

control = import_module("post-deposit-probe")
probe = import_module("relayer-safe-probe")
PATH = probe.ROOT / "output/deposit-handover.json"


def save(state):
    PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")


def digest(typed):
    message = encode_typed_data(full_message=typed)
    return "0x" + keccak(b"\x19" + message.version + message.header + message.body).hex()


def eth_call(rows, wallet, signature):
    with httpx.Client(timeout=25, follow_redirects=False) as transport:
        reply = transport.post(rows["Polygon RPC (Alchemy)"], json={"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": wallet, "data": "0x" + keccak(text=signature)[:4].hex()}, "latest"]}).json()
    if "result" not in reply:
        raise SystemExit("Polygon read failed")
    return int(reply["result"], 16)


def prepare(rows):
    if PATH.exists():
        raise SystemExit("Prepared experiment exists; resume it")
    previous = json.loads(probe.PATH.read_text())
    wallet = previous["depositExecutor"]["wallet"]
    live = json.loads((probe.ROOT / "output/live-mandate.json").read_text())
    account = control.account_for(rows)
    with httpx.Client(timeout=25, follow_redirects=False) as transport:
        market = control.choose_market(transport)
        response = transport.get("https://gamma-api.polymarket.com/markets", params={"slug": market["slug"]})
        response.raise_for_status()
        details = response.json()[0]
        tokens = json.loads(details["clobTokenIds"])
        market.update(conditionId=details["conditionId"], no=tokens[1], endDate=details["endDate"])
    with SecureClient.create(private_key=account.key.hex(), wallet=wallet, api_key=probe.builder_credentials(rows)) as client:
        order = client.create_limit_order(token_id=market["token"], price="0.01", size="5", side="BUY", post_only=True)
    values = asdict(order)
    if order.maker_amount != 50000 or order.taker_amount != 5000000 or order.signature_type != 3:
        raise SystemExit("Unexpected mandate order")
    unsigned_values = {key: value for key, value in values.items() if key not in ("signature", "post_only")}
    unsigned = UnsignedOrder(**unsigned_values, chain_id=137, exchange_address=PRODUCTION._config.standard_exchange)
    deadline = int(time.time()) + 6 * 3600
    refund_deadline = deadline + 86400
    nonce = eth_call(rows, wallet, "nonce()")
    calls = [erc20_transfer_call(token_address=PRODUCTION._config.collateral_token, recipient=live["dao"]["vault"], amount=50000)]
    refund_typed = build_deposit_wallet_typed_data(wallet=wallet, calls=calls, nonce=str(nonce + 1), deadline=str(refund_deadline), chain_id=137)
    refund_signature = sign_deposit_wallet_batch(account, wallet=wallet, calls=calls, nonce=str(nonce + 1), deadline=str(refund_deadline), chain_id=137)
    description = f"Deposit Wallet contract-owner admission: BUY 5 YES on {market['slug']} at 0.01, budget 0.05 pUSD, exact signed order salt {order.salt}"
    state = {"wallet": wallet, "transport": account.address, "dao": live["dao"], "bootstrapTopic": live["market"]["conditionId"],
             "market": market, "order": values, "orderDigest": digest(build_order_typed_data(unsigned)),
             "deadline": deadline, "nonceBeforeHandover": nonce, "description": description,
             "descriptionHash": "0x" + keccak(text=description).hex(), "refundDigest": digest(refund_typed),
             "refund": {"nonce": str(nonce + 1), "deadline": str(refund_deadline), "signature": str(refund_signature),
                        "calls": [{"to": str(call.to), "value": call.value, "data": str(call.data)} for call in calls]}}
    save(state)
    print(json.dumps({"wallet": wallet, "market": market, "orderDigest": state["orderDigest"], "budget": "50000"}, indent=2))


def submit(rows, state, phase):
    if phase in state:
        raise SystemExit("Submission recorded; reconcile instead of retrying")
    if "controller" not in state:
        raise SystemExit("Deploy and verify controller first")
    account = control.account_for(rows)
    if phase == "handover":
        data = keccak(text="transferOwnership(address,uint256)")[:4] + encode(["address", "uint256"], [state["controller"], state["deadline"]])
        calls = [TransactionCall(to=state["wallet"], data="0x" + data.hex())]
        nonce, deadline = str(state["nonceBeforeHandover"]), str(state["deadline"])
        signature = sign_deposit_wallet_batch(account, wallet=state["wallet"], calls=calls, nonce=nonce, deadline=deadline, chain_id=137)
    else:
        if state.get("post", {}).get("status") not in ("cancelled", "rejected"):
            raise SystemExit("Resolve the order before refund")
        refund = state["refund"]
        calls = [TransactionCall(**call) for call in refund["calls"]]
        nonce, deadline, signature = refund["nonce"], refund["deadline"], refund["signature"]
    payload = dict(build_deposit_wallet_payload(signer_address=account.address, deposit_wallet_factory=str(PRODUCTION._config.wallet_derivation.deposit_wallet_factory),
        wallet=state["wallet"], calls=calls, nonce=nonce, deadline=deadline, signature=str(signature), metadata="DAO contract owner " + phase))
    body = json.dumps(payload, separators=(",", ":"))
    state[phase] = {"status": "pending", "payload": payload}
    save(state)
    headers = build_builder_key_headers(creds=probe.builder_credentials(rows), method="POST", path="/submit", body=body)
    headers["Content-Type"] = "application/json"
    with httpx.Client(timeout=25, follow_redirects=False) as transport:
        result = probe.request(transport, "POST", "/submit", headers=headers, content=body)
    state[phase].update(status="submitted" if result["status"] == 200 else "rejected", response=result)
    save(state)
    print(json.dumps({"phase": phase, "result": result}, indent=2))


def reconcile(state):
    with httpx.Client(timeout=25, follow_redirects=False) as transport:
        for phase in ["handover", "refundSubmission"]:
            response = state.get(phase, {}).get("response", {}).get("body", {})
            identifier = response.get("transactionID") or response.get("transactionId")
            if identifier:
                result = probe.request(transport, "GET", "/transaction", params={"id": identifier})
                state[phase]["outcome"] = result
    save(state)
    print(json.dumps({phase: state[phase] for phase in ["handover", "refundSubmission"] if phase in state}, indent=2))


def post(rows, state):
    if "post" in state:
        raise SystemExit("Post already journaled; reconcile it")
    if state.get("activated") is not True:
        raise SystemExit("Confirmed DAO activation required")
    if eth_call(rows, state["wallet"], "owner()") != int(state["controller"], 16):
        raise SystemExit("Wallet ownership handover not confirmed")
    with httpx.Client(timeout=25, follow_redirects=False) as transport:
        geo = transport.get("https://polymarket.com/api/geoblock").json()
    if geo.get("blocked") is not False:
        raise SystemExit("Geoblock check failed")
    account = control.account_for(rows)
    order = SignedOrder(**state["order"])
    with SecureClient.create(private_key=account.key.hex(), wallet=state["wallet"], api_key=probe.builder_credentials(rows)) as client:
        state["post"] = {"status": "pending", "country": geo["country"], "controllerOwner": state["controller"], "credentialListedForTransport": client.credentials.key in client.fetch_api_keys()}
        save(state)
        try:
            response = client.post_order(order).model_dump(mode="json")
            state["post"]["response"] = response
            save(state)
            identifier = response.get("order_id") or response.get("orderID")
            if not identifier:
                raise SystemExit("Uncertain post outcome; reconcile before refund")
            state["post"]["cancel"] = client.cancel_order(order_id=identifier).model_dump(mode="json")
            save(state)
            result = client.get_order(order_id=identifier).model_dump(mode="json")
            result.pop("owner", None)
            state["post"]["finalOrder"] = result
            state["post"]["status"] = "cancelled" if result.get("status") in ("CANCELED", "CANCELLED") else "needs-reconciliation"
        except RequestRejectedError as error:
            state["post"].update(status="needs-reconciliation" if "response" in state["post"] else "rejected", error=str(error))
        save(state)
        print(json.dumps(state["post"], indent=2))


def main():
    rows = probe.secrets()
    if "--prepare" in sys.argv:
        prepare(rows)
        return
    state = json.loads(PATH.read_text())
    if "--handover" in sys.argv:
        submit(rows, state, "handover")
    elif "--refund" in sys.argv:
        submit(rows, state, "refundSubmission")
    elif "--post" in sys.argv:
        post(rows, state)
    elif "--reconcile" in sys.argv:
        reconcile(state)
    else:
        raise SystemExit("Select --prepare, --handover, --post, --refund or --reconcile")


if __name__ == "__main__":
    main()
