"""Post one bounded admission control order through the current Deposit Wallet flow."""
import json
import sys
from importlib import import_module

import httpx
from eth_account import Account
from eth_utils import keccak
from polymarket import SecureClient
from polymarket.environments import PRODUCTION
from polymarket.errors import RequestRejectedError
from polymarket._internal.actions.relayer.calls import erc20_approval_call, erc20_transfer_call
probe = import_module("relayer-safe-probe")
ROOT, PATH = probe.ROOT, probe.PATH
secrets, save = probe.secrets, probe.save
builder_credentials, request = probe.builder_credentials, probe.request


def account_for(rows):
    raw = bytes.fromhex(rows["Main EOA private key"].removeprefix("0x"))
    return Account.from_key(keccak(raw + b"polymarket-dao relayer admission probe 3"))


def relay(client, rows, state, phase):
    deposit = state["depositExecutor"]
    if phase in deposit:
        raise SystemExit("Relayer attempt recorded; reconcile first")
    config = PRODUCTION._config
    if phase == "approvalMax":
        call = erc20_approval_call(token_address=config.collateral_token, spender=config.standard_exchange, amount=2**256 - 1)
    else:
        if deposit.get("order", {}).get("status") not in ("cancelled", "rejected"):
            raise SystemExit("Confirm order cancellation before recovering funds")
        call = erc20_transfer_call(token_address=config.collateral_token, recipient=rows["Main EOA legacy Safe (admitted)"], amount=50000)
    deposit[phase] = {"status": "pending"}
    save(state)
    handle = client.execute_transaction(calls=[call], metadata="DAO current Deposit Wallet " + phase)
    deposit[phase].update(status="submitted", transactionId=handle.transaction_id, transactionHash=handle.transaction_hash)
    save(state)
    print(json.dumps(deposit[phase], indent=2))


def reconcile(state):
    deposit = state["depositExecutor"]
    with httpx.Client(timeout=25, follow_redirects=False) as transport:
        for phase in ["approval", "approvalMax", "cleanup"]:
            if "transactionId" not in deposit.get(phase, {}):
                continue
            result = request(transport, "GET", "/transaction", params={"id": deposit[phase]["transactionId"]})
            if result["status"] == 200 and result["body"]:
                deposit[phase]["outcome"] = result["body"][0]["state"]
    save(state)
    print(json.dumps({phase: deposit[phase] for phase in ["approval", "approvalMax", "cleanup"] if phase in deposit}, indent=2))


def choose_market(transport):
    response = transport.get("https://gamma-api.polymarket.com/markets", params={"active": "true", "closed": "false", "limit": 100})
    response.raise_for_status()
    for market in response.json():
        if market.get("acceptingOrders") and not market.get("negRisk") and float(market.get("orderMinSize", 5)) <= 5:
            tokens = json.loads(market["clobTokenIds"])
            return {"slug": market["slug"], "question": market["question"], "token": tokens[0]}
    raise SystemExit("No active standard market with a five-share minimum")


def post(client, state):
    deposit = state["depositExecutor"]
    if "order" in deposit:
        raise SystemExit("Order attempt already recorded; reconcile first")
    if deposit.get("approvalMax", {}).get("outcome") != "STATE_CONFIRMED" or deposit.get("funding", {}).get("status") != "confirmed":
        raise SystemExit("Confirmed approval and funding required")
    with httpx.Client(timeout=25, follow_redirects=False) as transport:
        geo = transport.get("https://polymarket.com/api/geoblock").json()
        if geo.get("blocked") is not False:
            raise SystemExit("Geoblock check failed")
        market = choose_market(transport)
    order = client.create_limit_order(token_id=market["token"], price="0.01", size="5", side="BUY", post_only=True)
    if order.signature_type != 3 or order.maker.lower() != deposit["wallet"].lower() or order.signer.lower() != order.maker.lower() or order.maker_amount != 50000:
        raise SystemExit("Deposit Wallet order identity or budget mismatch")
    deposit["order"] = {"status": "pending", "market": market, "country": geo["country"], "signatureType": 3, "principal": "50000"}
    save(state)
    try:
        response = client.post_order(order).model_dump(mode="json")
        deposit["order"]["response"] = response
        save(state)
        order_id = response.get("order_id") or response.get("orderID")
        if not order_id:
            raise SystemExit("No order ID returned; reconcile before cleanup")
        deposit["order"]["cancel"] = client.cancel_order(order_id=order_id).model_dump(mode="json")
        save(state)
        result = client.get_order(order_id=order_id).model_dump(mode="json")
        result.pop("owner", None)  # CLOB returns the API credential identifier here.
        deposit["order"]["finalOrder"] = result
        deposit["order"]["status"] = "cancelled" if str(result.get("status", "")).upper() in ("CANCELED", "CANCELLED") else "needs-reconciliation"
    except RequestRejectedError as error:
        if "response" in deposit["order"]:
            deposit["order"].update(status="needs-reconciliation", error=str(error))
        else:
            deposit["order"].update(status="rejected", error=str(error))
    save(state)
    print(json.dumps(deposit["order"], indent=2))


def main():
    rows = secrets()
    state = json.loads(PATH.read_text())
    if "--reconcile" in sys.argv:
        reconcile(state)
        return
    account = account_for(rows)
    with SecureClient.create(private_key=account.key.hex(), wallet=state["depositExecutor"]["wallet"], api_key=builder_credentials(rows)) as client:
        if client.wallet_type != "DEPOSIT_WALLET":
            raise SystemExit("Current Deposit Wallet required")
        if "--approve-max" in sys.argv or "--cleanup" in sys.argv:
            relay(client, rows, state, "approvalMax" if "--approve-max" in sys.argv else "cleanup")
        elif "--post" in sys.argv:
            post(client, state)
        else:
            raise SystemExit("Select --approve-max, --post, --cleanup or --reconcile")


if __name__ == "__main__":
    main()
