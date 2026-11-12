"""Prepare a fresh Deposit Wallet whose initial owner is a DAO mandate contract."""
import json
import sys
import time
from dataclasses import asdict
from importlib import import_module
from pathlib import Path

import httpx
import rlp
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak, to_checksum_address
from polymarket.environments import PRODUCTION
from polymarket.models.clob.orders import SignedOrder
from polymarket._internal.actions.orders.types import UnsignedOrder
from polymarket._internal.actions.orders.typed_data import build_order_typed_data, build_order_signature
from polymarket._internal.actions.relayer.calls import erc20_approval_call, erc20_transfer_call
from polymarket._internal.actions.relayer.signing.deposit_wallet import build_deposit_wallet_typed_data, sign_deposit_wallet_batch
from polymarket._internal.wallet import derive_beacon_deposit_wallet_address
from polymarket._internal.actions.relayer.auth import build_builder_key_headers
from polymarket._internal.actions.relayer.gasless import build_deposit_wallet_payload
from polymarket._internal.actions.relayer.calls import TransactionCall
from polymarket import SecureClient
from polymarket.errors import RequestRejectedError

handover = import_module("deposit-handover")
control = import_module("post-deposit-probe")
probe = import_module("relayer-safe-probe")
PATH = probe.ROOT / ("output/deposit-from-dao-2.json" if "--second" in sys.argv else "output/deposit-from-dao.json")


def save(state):
    PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")


def rpc(rows, method, params):
    with httpx.Client(timeout=25, follow_redirects=False) as transport:
        body = transport.post(rows["Polygon RPC (Alchemy)"], json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).json()
    if "result" not in body:
        raise SystemExit("Polygon RPC read failed")
    return body["result"]


def prepare(rows):
    if PATH.exists():
        raise SystemExit("Fresh DAO-owner preparation already exists")
    previous = json.loads(handover.PATH.read_text())
    main = Account.from_key(rows["Main EOA private key"])
    nonce = int(rpc(rows, "eth_getTransactionCount", [main.address, "pending"]), 16)
    controller = to_checksum_address(keccak(rlp.encode([bytes.fromhex(main.address[2:]), nonce]))[-20:])
    wallet = derive_beacon_deposit_wallet_address(controller, PRODUCTION._config.wallet_derivation)
    transport = control.account_for(rows)
    sample = previous["order"]
    unsigned = UnsignedOrder(chain_id=137, exchange_address=PRODUCTION._config.standard_exchange,
        builder=sample["builder"], expiration=0, maker=wallet, maker_amount=50000,
        metadata=sample["metadata"], order_type="GTC", salt=sample["salt"] + (2 if "--second" in sys.argv else 1),
        side="BUY", signature_type=3, signer=wallet, taker_amount=5000000,
        timestamp=int(time.time() * 1000), token_id=previous["market"]["token"])
    typed = build_order_typed_data(unsigned)
    raw = "0x" + transport.sign_message(encode_typed_data(full_message=typed)).signature.hex()
    order = SignedOrder(**{key: value for key, value in asdict(unsigned).items() if key not in ("chain_id", "exchange_address", "protocol_version")},
        signature=build_order_signature(unsigned, raw), post_only=True)
    deadline = int(time.time()) + 6 * 3600
    collateral = PRODUCTION._config.collateral_token
    exchange = PRODUCTION._config.standard_exchange
    approval = [erc20_approval_call(token_address=collateral, spender=exchange, amount=2**256 - 1)]
    refund = [erc20_transfer_call(token_address=collateral, recipient=previous["dao"]["vault"], amount=50000)]
    def signed_batch(calls, nonce, expiry):
        typed_batch = build_deposit_wallet_typed_data(wallet=wallet, calls=calls, nonce=str(nonce), deadline=str(expiry), chain_id=137)
        signature = sign_deposit_wallet_batch(transport, wallet=wallet, calls=calls, nonce=str(nonce), deadline=str(expiry), chain_id=137)
        return {"nonce": str(nonce), "deadline": str(expiry), "signature": str(signature),
            "calls": [{"to": str(call.to), "data": str(call.data), "value": call.value} for call in calls],
            "digest": handover.digest(typed_batch)}
    approval_batch = signed_batch(approval, 0, deadline)
    refund_batch = signed_batch(refund, 1, deadline + 86400)
    description = f"DAO-owned Deposit Wallet: BUY 5 YES on {previous['market']['slug']} at 0.01, budget 0.05 pUSD, order salt {unsigned.salt}"
    state = {"controller": controller, "predictedDeployerNonce": nonce, "wallet": wallet,
        "transport": transport.address, "dao": previous["dao"], "bootstrapTopic": previous["bootstrapTopic"],
        "market": previous["market"], "order": asdict(order), "orderDigest": handover.digest(typed),
        "approvalDigest": approval_batch["digest"], "approval": approval_batch,
        "refundDigest": refund_batch["digest"], "refund": refund_batch,
        "deadline": deadline, "description": description, "descriptionHash": "0x" + keccak(text=description).hex()}
    save(state)
    print(json.dumps({"controller": controller, "wallet": wallet, "orderDigest": state["orderDigest"],
        "deployerNonce": nonce, "budget": "50000"}, indent=2))


def create_wallet(rows):
    state = json.loads(PATH.read_text())
    if "walletCreate" in state:
        raise SystemExit("Wallet creation already recorded; reconcile before retrying")
    code = rpc(rows, "eth_getCode", [state["controller"], "latest"])
    if code == "0x":
        raise SystemExit("DAO owner contract must be deployed first")
    if rpc(rows, "eth_getCode", [state["wallet"], "latest"]) != "0x":
        raise SystemExit("Predicted Deposit Wallet is already deployed")
    payload = {"type": "WALLET-CREATE", "from": state["controller"],
        "to": str(PRODUCTION._config.wallet_derivation.deposit_wallet_factory),
        "metadata": "DAO contract owned Deposit Wallet"}
    body = json.dumps(payload, separators=(",", ":"))
    state["walletCreate"] = {"status": "pending", "payload": payload}
    save(state)
    headers = build_builder_key_headers(creds=probe.builder_credentials(rows), method="POST", path="/submit", body=body)
    headers["Content-Type"] = "application/json"
    with httpx.Client(timeout=25, follow_redirects=False) as transport:
        result = probe.request(transport, "POST", "/submit", headers=headers, content=body)
    state["walletCreate"].update(status="submitted" if result["status"] == 200 else "rejected", response=result)
    save(state)
    print(json.dumps(state["walletCreate"], indent=2))


def submit_batch(rows, phase):
    state = json.loads(PATH.read_text())
    if phase in state:
        raise SystemExit("Batch attempt already recorded; reconcile before retrying")
    if not state.get("ownerConfirmed"):
        raise SystemExit("DAO contract ownership must be verified")
    if phase == "refundSubmission" and state.get("post", {}).get("status") not in ("cancelled", "rejected"):
        raise SystemExit("Resolve the order before refunding")
    batch = state["approval" if phase in ("approvalSubmission", "approvalFromTransport") else "refund"]
    calls = [TransactionCall(**call) for call in batch["calls"]]
    payload = dict(build_deposit_wallet_payload(signer_address=state["transport"] if phase == "approvalFromTransport" else state["controller"],
        deposit_wallet_factory=str(PRODUCTION._config.wallet_derivation.deposit_wallet_factory),
        wallet=state["wallet"], calls=calls, nonce=batch["nonce"], deadline=batch["deadline"],
        signature=batch["signature"], metadata="DAO-owned Deposit Wallet " + phase))
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


def post_order(rows):
    state = json.loads(PATH.read_text())
    if "post" in state:
        raise SystemExit("Post already recorded; reconcile before retrying")
    if not state.get("activated") or not state.get("ownerConfirmed"):
        raise SystemExit("Confirmed governance funding and contract owner required")
    with httpx.Client(timeout=25, follow_redirects=False) as transport:
        geo = transport.get("https://polymarket.com/api/geoblock").json()
    if geo.get("blocked") is not False:
        raise SystemExit("Geoblock check failed")
    account = control.account_for(rows)
    order = SignedOrder(**state["order"])
    if order.maker.lower() != state["wallet"].lower() or order.signer.lower() != state["wallet"].lower() or order.maker_amount != 50000 or order.signature_type != 3:
        raise SystemExit("Signed order differs from DAO mandate")
    with SecureClient.create(private_key=account.key.hex(), wallet=state["wallet"], api_key=probe.builder_credentials(rows)) as client:
        state["post"] = {"status": "pending", "country": geo["country"], "wallet": state["wallet"], "controller": state["controller"]}
        save(state)
        try:
            response = client.post_order(order).model_dump(mode="json")
            state["post"]["response"] = response
            save(state)
            identifier = response.get("order_id") or response.get("orderID")
            if not identifier:
                raise SystemExit("Uncertain post outcome; reconcile before recovery")
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
    if "--prepare" in sys.argv:
        prepare(probe.secrets())
    elif "--create-wallet" in sys.argv:
        create_wallet(probe.secrets())
    elif "--approve-transport" in sys.argv:
        submit_batch(probe.secrets(), "approvalFromTransport")
    elif "--approve" in sys.argv or "--refund" in sys.argv:
        submit_batch(probe.secrets(), "approvalSubmission" if "--approve" in sys.argv else "refundSubmission")
    elif "--post" in sys.argv:
        post_order(probe.secrets())
    else:
        raise SystemExit("Select --prepare, --create-wallet, --approve, --post or --refund")


if __name__ == "__main__":
    main()
