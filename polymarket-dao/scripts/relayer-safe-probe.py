"""Check relayer recognition and submit one signed, gasless Safe creation request."""
import json
import sys
from pathlib import Path

import httpx
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak
from polymarket.environments import PRODUCTION
from polymarket import BuilderApiKey, RelayerApiKey, SecureClient
from polymarket.errors import RequestRejectedError
from polymarket._internal.actions.relayer.calls import erc20_approval_call, erc20_transfer_call
from polymarket._internal.wallet import derive_safe_wallet_address
from polymarket._internal.actions.relayer.auth import build_builder_key_headers

ROOT = Path(__file__).resolve().parent.parent
PATH = ROOT / "output/relayer-safe-probe.json"
HOST = "https://relayer-v2.polymarket.com"
FACTORY = PRODUCTION._config.wallet_derivation.safe_factory
ZERO = "0x" + "00" * 20
SECRET_PATH = Path(r"C:\Users\iperc\polymarket-dao-secrets.md")


def secrets():
    rows = {}
    for line in SECRET_PATH.read_text().splitlines():
        parts = line.split("|")
        if len(parts) == 4:
            rows[parts[1].strip()] = parts[2].strip().strip("`")
    return rows


def save(state):
    PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")


def request(client, method, path, **kwargs):
    response = client.request(method, HOST + path, **kwargs)
    try:
        body = response.json()
    except ValueError:
        body = {"error": "Non-JSON response"}
    return {"status": response.status_code, "body": body}


def creation_payload(account, safe):
    domain = {"name": "Polymarket Contract Proxy Factory", "chainId": 137, "verifyingContract": FACTORY}
    types = {"CreateProxy": [{"name": "paymentToken", "type": "address"}, {"name": "payment", "type": "uint256"}, {"name": "paymentReceiver", "type": "address"}]}
    values = {"paymentToken": ZERO, "payment": 0, "paymentReceiver": ZERO}
    signature = account.sign_message(encode_typed_data(domain, types, values)).signature.hex()
    return {"from": account.address, "to": FACTORY, "proxyWallet": safe, "data": "0x", "signature": "0x" + signature.removeprefix("0x"), "signatureParams": {"paymentToken": ZERO, "payment": "0", "paymentReceiver": ZERO}, "type": "SAFE-CREATE"}


def prepare_builder(rows, state):
    if "DAO probe Builder API key" in rows or "builderKeyCreation" in state:
        raise SystemExit("Builder credential or creation attempt already recorded")
    state["builderKeyCreation"] = {"status": "pending", "owner": rows["Main EOA address"]}
    save(state)
    with SecureClient.create(private_key=rows["Main EOA private key"], wallet=rows["Main EOA legacy Safe (admitted)"]) as client:
        try:
            credentials = client.create_builder_api_key()
        except RequestRejectedError as error:
            state["builderKeyCreation"].update(status="rejected", error=str(error))
            save(state)
            print(json.dumps(state["builderKeyCreation"], indent=2))
            return
        text = SECRET_PATH.read_text()
        text += "\n## DAO relayer-first probe builder credentials\n\n| What | Value |\n|---|---|\n"
        for name, value in [("API key", credentials.key), ("secret", credentials.secret), ("passphrase", credentials.passphrase)]:
            text += f"| DAO probe Builder {name} | `{value}` |\n"
        SECRET_PATH.write_text(text, encoding="utf-8")
        state["builderKeyCreation"].update(status="created", storedOutsideProject=True)
        save(state)
    print(json.dumps(state["builderKeyCreation"], indent=2))


def create_with_builder(rows, state, account, safe):
    if "builderSubmission" in state:
        raise SystemExit("Builder submission already recorded; reconcile before another action")
    credentials = BuilderApiKey(key=rows["DAO probe Builder API key"], secret=rows["DAO probe Builder secret"], passphrase=rows["DAO probe Builder passphrase"])
    body = json.dumps(creation_payload(account, safe), separators=(",", ":"))
    with httpx.Client(timeout=25, follow_redirects=False) as client:
        deployed = request(client, "GET", "/deployed", params={"address": safe, "type": "SAFE"})
        if deployed["status"] != 200 or deployed["body"].get("deployed") is not False:
            raise SystemExit("Verified undeployed Safe required")
        state["builderSubmission"] = {"status": "pending", "preflight": deployed}
        save(state)
        headers = build_builder_key_headers(creds=credentials, method="POST", path="/submit", body=body)
        headers["Content-Type"] = "application/json"
        state["builderSubmission"] = request(client, "POST", "/submit", headers=headers, content=body)
        save(state)
    print(json.dumps(state["builderSubmission"], indent=2))


def builder_credentials(rows):
    return BuilderApiKey(key=rows["DAO probe Builder API key"], secret=rows["DAO probe Builder secret"], passphrase=rows["DAO probe Builder passphrase"])


def create_deposit_executor(rows, state, account):
    if "depositExecutor" in state:
        raise SystemExit("Deposit executor creation already recorded; reconcile first")
    state["depositExecutor"] = {"status": "pending", "owner": account.address}
    save(state)
    with SecureClient.create(private_key=account.key.hex(), api_key=builder_credentials(rows)) as client:
        if client.wallet_type != "DEPOSIT_WALLET":
            raise SystemExit("Current Deposit Wallet flow required")
        state["depositExecutor"].update(status="created", wallet=str(client.wallet), walletType=client.wallet_type, credentialListedForSigner=client.credentials.key in client.fetch_api_keys())
        save(state)
    print(json.dumps(state["depositExecutor"], indent=2))


def submit_relayer_first(rows, state, account, phase):
    if phase in state:
        raise SystemExit("Phase already persisted; reconcile before resubmitting")
    if phase == "relayerFirstFunding" and state.get("relayerFirstApproval", {}).get("outcome") != "STATE_CONFIRMED":
        raise SystemExit("Confirmed approval required before funding")
    if phase == "relayerFirstCleanup" and state.get("relayerFirstOrder", {}).get("status") != "rejected":
        raise SystemExit("Reconcile and cancel any accepted or uncertain order before cleanup")
    config = PRODUCTION._config
    if phase == "relayerFirstApproval":
        wallet, key = state["safe"], account.key.hex()
        call = erc20_approval_call(token_address=config.collateral_token, spender=config.standard_exchange, amount=50_000)
    elif phase == "relayerFirstFunding":
        wallet, key = rows["Main EOA legacy Safe (admitted)"], rows["Main EOA private key"]
        call = erc20_transfer_call(token_address=config.collateral_token, recipient=state["safe"], amount=50_000)
    else:
        wallet, key = state["safe"], account.key.hex()
        call = erc20_transfer_call(token_address=config.collateral_token, recipient=rows["Main EOA legacy Safe (admitted)"], amount=50_000)
    with SecureClient.create(private_key=key, wallet=wallet, api_key=builder_credentials(rows)) as client:
        state[phase] = {"status": "pending"}
        save(state)
        try:
            handle = client.execute_transaction(calls=[call], metadata=phase)
            state[phase].update(status="submitted", transactionId=handle.transaction_id, transactionHash=handle.transaction_hash)
        except RequestRejectedError as error:
            state[phase].update(status="rejected", error=str(error))
        save(state)
    print(json.dumps(state[phase], indent=2))


def reconcile_relayer_first(state):
    phases = ["relayerFirstApproval", "relayerFirstFunding", "relayerFirstCleanup"]
    with httpx.Client(timeout=25, follow_redirects=False) as client:
        for phase in phases:
            if phase not in state or "transactionId" not in state[phase]:
                continue
            result = request(client, "GET", "/transaction", params={"id": state[phase]["transactionId"]})
            if result["status"] == 200 and result["body"]:
                state[phase]["outcome"] = result["body"][0]["state"]
    save(state)
    print(json.dumps({phase: state[phase] for phase in phases if phase in state}, indent=2))


def post_relayer_first(rows, state, account):
    if "relayerFirstOrder" in state:
        raise SystemExit("Relayer-first order already persisted")
    for phase in ["relayerFirstApproval"]:
        if state.get(phase, {}).get("outcome") != "STATE_CONFIRMED":
            raise SystemExit("Confirmed approval and funding required")
    if state.get("relayerFirstFunding", {}).get("outcome") != "STATE_CONFIRMED" and state.get("directFunding", {}).get("status") != "confirmed":
        raise SystemExit("Confirmed funding required")
    with httpx.Client(timeout=25, follow_redirects=False) as transport:
        geo = transport.get("https://polymarket.com/api/geoblock", headers={"User-Agent": "polymarket-dao"}).json()
    if geo.get("blocked") is not False:
        raise SystemExit("Geoblock check failed")
    live = json.loads((ROOT / "output/live-mandate.json").read_text())
    with SecureClient.create(private_key=account.key.hex(), wallet=state["safe"], api_key=builder_credentials(rows)) as client:
        order = client.create_limit_order(token_id=live["market"]["yes"], price="0.01", size="5", side="BUY", post_only=True)
        if order.maker.lower() != state["safe"].lower() or order.signer.lower() != account.address.lower() or order.signature_type != 2 or order.maker_amount != 50_000:
            raise SystemExit("Relayer-first order identity mismatch")
        state["relayerFirstOrder"] = {"status": "pending", "country": geo["country"], "signatureType": 2, "credentialListedForSigner": client.credentials.key in client.fetch_api_keys()}
        save(state)
        try:
            response = client.post_order(order).model_dump(mode="json")
            state["relayerFirstOrder"]["response"] = response
            save(state)
            order_id = response.get("order_id") or response.get("orderID")
            if order_id:
                state["relayerFirstOrder"]["cancel"] = client.cancel_order(order_id=order_id).model_dump(mode="json")
                save(state)
                state["relayerFirstOrder"]["order"] = client.get_order(order_id=order_id).model_dump(mode="json")
            state["relayerFirstOrder"]["status"] = "completed"
        except RequestRejectedError as error:
            state["relayerFirstOrder"].update(status="rejected", error=str(error))
        save(state)
    print(json.dumps(state["relayerFirstOrder"], indent=2))


def execute_existing(rows, state):
    live = json.loads((ROOT / "output/live-mandate.json").read_text())
    if "execution" in state:
        raise SystemExit("Execution already persisted; reconcile instead of resubmitting")
    api = RelayerApiKey(key=rows["Trading EOA relayer API key"], address=rows["Trading EOA address"])
    with SecureClient.create(private_key=rows["Trading EOA private key"], wallet=live["tradingSafe"]["safe"], api_key=api) as client:
        call = erc20_approval_call(token_address=PRODUCTION._config.collateral_token, spender=PRODUCTION._config.standard_exchange, amount=2**256 - 1)
        state["execution"] = {"status": "pending", "safe": live["tradingSafe"]["safe"], "action": "Repeat existing exchange approval"}
        save(state)
        try:
            handle = client.execute_transaction(calls=[call], metadata="DAO Safe relayer admission control")
            state["execution"].update(status="submitted", transactionId=handle.transaction_id, transactionHash=handle.transaction_hash)
        except RequestRejectedError as error:
            state["execution"].update(status="rejected", error=str(error))
        save(state)
    print(json.dumps(state["execution"], indent=2))


def post_after_relay(rows, state):
    if "orderAfterRelay" in state:
        raise SystemExit("Order attempt already persisted")
    outcomes = state.get("executionOutcome", [])
    if isinstance(outcomes, dict):
        outcomes = [outcomes]
    if not any(item.get("state") == "STATE_CONFIRMED" for item in outcomes):
        raise SystemExit("Confirmed relayer execution required before this control")
    with httpx.Client(timeout=25, follow_redirects=False) as transport:
        geo = transport.get("https://polymarket.com/api/geoblock", headers={"User-Agent": "polymarket-dao"}).json()
    if geo.get("blocked") is not False:
        raise SystemExit("Geoblock check failed")
    live = json.loads((ROOT / "output/live-mandate.json").read_text())
    safe = live["tradingSafe"]["safe"]
    api = RelayerApiKey(key=rows["Trading EOA relayer API key"], address=rows["Trading EOA address"])
    with SecureClient.create(private_key=rows["Trading EOA private key"], wallet=safe, api_key=api) as client:
        order = client.create_limit_order(token_id=live["market"]["yes"], price="0.01", size="5", side="BUY", post_only=True)
        if order.maker.lower() != safe.lower() or order.signer.lower() != rows["Trading EOA address"].lower() or order.signature_type != 2 or order.maker_amount != 50_000:
            raise SystemExit("Order identity or budget mismatch")
        state["orderAfterRelay"] = {"status": "pending", "safe": safe, "country": geo["country"], "signatureType": 2}
        save(state)
        try:
            response = client.post_order(order).model_dump(mode="json")
            state["orderAfterRelay"]["response"] = response
            save(state)
            order_id = response.get("order_id") or response.get("orderID")
            if order_id:
                state["orderAfterRelay"]["cancel"] = client.cancel_order(order_id=order_id).model_dump(mode="json")
            state["orderAfterRelay"]["status"] = "completed"
        except RequestRejectedError as error:
            state["orderAfterRelay"].update(status="rejected", error=str(error))
        save(state)
    print(json.dumps(state["orderAfterRelay"], indent=2))


def main():
    rows = secrets()
    previous = json.loads((ROOT / "output/new-safe-probe.json").read_text())
    label = "polymarket-dao relayer admission probe 3"
    account = Account.from_key(keccak(bytes.fromhex(rows["Main EOA private key"].removeprefix("0x")) + label.encode()))
    safe = str(derive_safe_wallet_address(account.address, PRODUCTION._config.wallet_derivation))
    state = json.loads(PATH.read_text()) if PATH.exists() else {"label": label, "signer": account.address, "safe": safe}
    if "--create-deposit-executor" in sys.argv:
        create_deposit_executor(rows, state, account)
        return
    phases = {"--approve-relayer-first": "relayerFirstApproval", "--fund-relayer-first": "relayerFirstFunding", "--cleanup-relayer-first": "relayerFirstCleanup"}
    for flag, phase in phases.items():
        if flag in sys.argv:
            submit_relayer_first(rows, state, account, phase)
            return
    if "--reconcile-relayer-first" in sys.argv:
        reconcile_relayer_first(state)
        return
    if "--post-relayer-first" in sys.argv:
        post_relayer_first(rows, state, account)
        return
    if "--prepare-builder" in sys.argv:
        prepare_builder(rows, state)
        return
    if "--create-with-builder" in sys.argv:
        create_with_builder(rows, state, account, safe)
        return
    if "--post-after-relay" in sys.argv:
        post_after_relay(rows, state)
        return
    if "--execute-existing" in sys.argv:
        execute_existing(rows, state)
        return
    headers = {"RELAYER_API_KEY": rows["Trading EOA relayer API key"], "RELAYER_API_KEY_ADDRESS": rows["Trading EOA address"]}
    with httpx.Client(timeout=25, follow_redirects=False) as client:
        state["existingSafeDeployed"] = request(client, "GET", "/deployed", params={"address": previous["safe"], "type": "SAFE"})
        state["existingSafeNonce"] = request(client, "GET", "/nonce", params={"address": previous["trader"], "type": "SAFE"})
        authentication = request(client, "GET", "/transactions", headers=headers)
        state["relayerAuthentication"] = {"status": authentication["status"], "success": authentication["status"] == 200, "credentialOwner": rows["Trading EOA address"]}
        save(state)
        if authentication["status"] == 200 and "existingSubmission" not in state:
            existing = Account.from_key(rows["Trading EOA private key"])
            existing_safe = str(derive_safe_wallet_address(existing.address, PRODUCTION._config.wallet_derivation))
            state["existingSubmission"] = {"status": "pending", "safe": existing_safe}
            save(state)
            state["existingSubmission"] = request(client, "POST", "/submit", headers=headers, json=creation_payload(existing, existing_safe))
            save(state)
        if "submission" in state:
            print(json.dumps(state, indent=2))
            return
        if authentication["status"] != 200:
            raise SystemExit("Relayer credentials could not be verified; no submission")
        payload = creation_payload(account, safe)
        state["submission"] = {"status": "pending"}
        save(state)
        state["submission"] = request(client, "POST", "/submit", headers=headers, json=payload)
        save(state)
        print(json.dumps(state, indent=2))


if __name__ == "__main__":
    main()
