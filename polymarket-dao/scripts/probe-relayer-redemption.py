"""One-shot official WALLET sponsorship probe; no paid broadcasts or deployments.

RELAYER_KEY exists only in the process environment. Public signed requests are
appended before submission. Resume by reconciling, never by repeating a POST.
"""
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

import httpx
from eth_abi import decode, encode
from eth_account import Account
from eth_utils import keccak
from polymarket._internal.actions.relayer.calls import TransactionCall
from polymarket._internal.actions.relayer.gasless import build_deposit_wallet_payload
from polymarket._internal.actions.relayer.signing.deposit_wallet import sign_deposit_wallet_batch

ROOT = Path(__file__).resolve().parent.parent
JOURNAL = ROOT / "output/relayer-redemption.jsonl"
HOST = "https://relayer-v2.polymarket.com"
FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07"
SIGNER = "0xDc9311c53D3d1Cb1d9eD87B9028FB35c2168629d"
WALLET = "0x92DC8012d9C27703d9EBE7a3EdD1037eE8ac4f2a"
VAULT = "0x1B3C2d5D9F2EaB3f8155892696bB3B56fC0b6968"
OLD_VAULT = "0xA8323D854e2AfFCcF44389d94Da402C9E124CFC5"
SAFE = "0x7a46dCFfa7064Fe54Ee848b125a5C58c3b9f5Ddb"
CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"
ADAPTER = "0xAdA100Db00Ca00073811820692005400218FcE1f"
OLD_TOKEN = 87712920673252297509200151045391015262449055764880659907762503287643101055970
MARKET = json.loads((ROOT / "output/redemption-market.json").read_text())


def project_secrets():
    allowed = {"Polygon RPC (Alchemy)", "Trading EOA private key"}
    lines = Path(r"C:\Users\iperc\polymarket-dao-secrets.md").read_text().splitlines()
    rows = {p[1].strip(): p[2].strip().strip("`") for line in lines if len(p := line.split("|")) == 4 and p[1].strip() in allowed}
    if set(rows) != allowed:
        raise RuntimeError("Required project credentials missing")
    return rows


def append(phase, **values):
    entry = {"phase": phase, "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **values}
    with JOURNAL.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(entry, separators=(",", ":")) + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    return entry


def events():
    return [json.loads(line) for line in JOURNAL.read_text().splitlines()] if JOURNAL.exists() else []


def calldata(signature, types=(), values=()):
    return "0x" + (keccak(text=signature)[:4] + encode(types, values)).hex()


def rpc(client, url, method, params):
    body = client.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).json()
    if "error" in body:
        data = body["error"].get("data")
        revert = data if isinstance(data, str) and re.fullmatch(r"0x[0-9a-fA-F]*", data) else None
        return {"errorCode": body["error"].get("code"), "revertData": revert}
    return body["result"]


def read(client, url, address, signature, types=(), values=(), result="uint256", block="latest"):
    value = rpc(client, url, "eth_call", [{"to": address, "data": calldata(signature, types, values)}, block])
    if isinstance(value, dict):
        raise RuntimeError("Read-only contract call failed; provider diagnostics suppressed")
    return decode([result], bytes.fromhex(value[2:]))[0]


def balances(client, url, block):
    holders = {"vault": VAULT, "oldVault": OLD_VAULT, "safe": SAFE, "depositWallet": WALLET, "signer": SIGNER}
    return {name: {"pUSD": read(client, url, PUSD, "balanceOf(address)", ["address"], [address], block=block), "POL": int(rpc(client, url, "eth_getBalance", [address, block]), 16)} for name, address in holders.items()}


def snapshot(client, url):
    block = rpc(client, url, "eth_blockNumber", [])
    c = bytes.fromhex(MARKET["conditionId"][2:])
    holdings = {name: [read(client, url, CTF, "balanceOf(address,uint256)", ["address", "uint256"], [address, int(MARKET[outcome])], block=block) for outcome in ["yes", "no"]] for name, address in [("vault", VAULT), ("depositWallet", WALLET)]}
    old = {name: read(client, url, CTF, "balanceOf(address,uint256)", ["address", "uint256"], [address, OLD_TOKEN], block=block) for name, address in [("oldVault", OLD_VAULT), ("safe", SAFE)]}
    return {"block": int(block, 16), "balances": balances(client, url, block), "resolvedHoldings": holdings, "existingPosition": old, "denominator": read(client, url, CTF, "payoutDenominator(bytes32)", ["bytes32"], [c], block=block), "payouts": [read(client, url, CTF, "payoutNumerators(bytes32,uint256)", ["bytes32", "uint256"], [c, i], block=block) for i in [0, 1]], "approval": read(client, url, CTF, "isApprovedForAll(address,address)", ["address", "address"], [VAULT, ADAPTER], result="bool", block=block)}


def response_data(response):
    try:
        body = response.json()
    except ValueError:
        body = {"error": "Non-JSON response; diagnostics suppressed"}
    return {"status": response.status_code, "body": public_data(body)}


def public_data(value):
    if isinstance(value, dict):
        return {k: public_data(v) for k, v in value.items()}
    if isinstance(value, list):
        return [public_data(v) for v in value]
    if isinstance(value, str):
        key = os.environ.get("RELAYER_KEY")
        return re.sub(r"https?://[^\s\"']+", "[URL redacted]", value.replace(key, "[key redacted]") if key else value)
    return value


def preflight(client, url):
    if int(rpc(client, url, "eth_chainId", []), 16) != 137:
        raise RuntimeError("Expected Polygon mainnet")
    code = rpc(client, url, "eth_getCode", [VAULT, "latest"])
    if code == "0x" or read(client, url, VAULT, "redemptionAdapter()", result="address").lower() != ADAPTER.lower():
        raise RuntimeError("Unexpected vault deployment")
    data = calldata("redeem(uint256)", ["uint256"], [int(MARKET["conditionId"], 16)])
    simulation = rpc(client, url, "eth_call", [{"from": WALLET, "to": VAULT, "data": data}, "latest"])
    return append("preflight", snapshot=snapshot(client, url), vaultCodeHash="0x" + keccak(bytes.fromhex(code[2:])).hex(), simulation=simulation, completedLiveJournalSha256=hashlib.sha256((ROOT / "output/live-redemption.json").read_bytes()).hexdigest())


def submit(client, url, account, mode):
    if any(e["phase"] == mode + ":prepared" for e in events()):
        raise RuntimeError("Attempt already journaled; use reconcile, never resubmit")
    params = response_data(client.get(HOST + "/v1/account/transactions/params", params={"address": SIGNER, "type": "WALLET"}))
    append(mode + ":params", response=params)
    if params["status"] != 200:
        raise RuntimeError("Relayer params rejected; inspect public journal")
    calls = calls_for(mode)
    payload = signed_payload(account, calls, params["body"]["nonce"], mode)
    if mode == "fundedProbe":
        simulate_funded_batch(client, url, payload)
    append(mode + ":prepared", request=payload, before=snapshot(client, url))
    result = response_data(client.post(HOST + "/submit", json=payload))
    append(mode + ":response", response=result)
    return result


def calls_for(mode):
    if mode == "fundedProbe":
        condition = bytes.fromhex(MARKET["conditionId"][2:])
        return [
            TransactionCall(to=PUSD, data=calldata("approve(address,uint256)", ["address", "uint256"], [ADAPTER, 100_000])),
            TransactionCall(to=ADAPTER, data=calldata("splitPosition(address,bytes32,bytes32,uint256[],uint256)", ["address", "bytes32", "bytes32", "uint256[]", "uint256"], [PUSD, bytes(32), condition, [1, 2], 100_000])),
            TransactionCall(to=CTF, data=calldata("safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)", ["address", "address", "uint256[]", "uint256[]", "bytes"], [WALLET, VAULT, [int(MARKET["yes"]), int(MARKET["no"])], [100_000, 100_000], b""])),
            TransactionCall(to=VAULT, data=calldata("redeem(uint256)", ["uint256"], [int(MARKET["conditionId"], 16)])),
            TransactionCall(to=PUSD, data=calldata("approve(address,uint256)", ["address", "uint256"], [ADAPTER, 0])),
        ]
    if mode == "targetControl":
        return [TransactionCall(to=VAULT, data=calldata("redemptionAdapter()"))]
    if mode == "probe":
        return [TransactionCall(to=VAULT, data=calldata("redeem(uint256)", ["uint256"], [int(MARKET["conditionId"], 16)]))]
    if mode == "control":
        # A zero self-transfer verifies auth and sponsorship without moving principal.
        return [TransactionCall(to=PUSD, data=calldata("transfer(address,uint256)", ["address", "uint256"], [WALLET, 0]))]
    raise RuntimeError("Unknown submission mode")


def simulate_funded_batch(client, url, payload):
    params = payload["depositWalletParams"]
    calls = [(c["target"], int(c["value"]), bytes.fromhex(c["data"][2:])) for c in params["calls"]]
    batch = (WALLET, int(payload["nonce"]), int(params["deadline"]), calls)
    data = calldata("execute((address,uint256,uint256,(address,uint256,bytes)[]),bytes)", ["(address,uint256,uint256,(address,uint256,bytes)[])", "bytes"], [batch, bytes.fromhex(payload["signature"][2:])])
    result = rpc(client, url, "eth_call", [{"from": FACTORY, "to": WALLET, "data": data}, "latest"])
    append("fundedProbe:simulation", result=result, method="Read-only eth_call of signed wallet batch in factory caller context; no state overrides or broadcast")
    if isinstance(result, dict):
        raise RuntimeError("Funded batch simulation failed; no submission")


def signed_payload(account, calls, nonce, mode):
    deadline = str(int(time.time()) + 600)
    signature = sign_deposit_wallet_batch(account, wallet=WALLET, calls=calls, nonce=str(nonce), deadline=deadline, chain_id=137)
    return dict(build_deposit_wallet_payload(signer_address=SIGNER, deposit_wallet_factory=FACTORY, wallet=WALLET, calls=calls, nonce=str(nonce), deadline=deadline, signature=signature, metadata="DAO vault redemption sponsorship " + mode))


def reconcile(client, url):
    responses = [e for e in events() if e["phase"].endswith(":response") and e["response"]["status"] == 200]
    for entry in responses:
        ident = entry["response"]["body"]["transactionID"]
        result = response_data(client.get(HOST + "/transaction", params={"id": ident}))
        append(entry["phase"].split(":")[0] + ":reconciled", response=result)
    return append("finalSnapshot", snapshot=snapshot(client, url))


def main():
    rows = project_secrets()
    account = Account.from_key(rows["Trading EOA private key"])
    if account.address.lower() != SIGNER.lower():
        raise RuntimeError("Wrong Trading EOA")
    mode = sys.argv[1]
    headers = {"RELAYER_API_KEY": os.environ["RELAYER_KEY"], "RELAYER_API_KEY_ADDRESS": SIGNER}
    with httpx.Client(timeout=25, follow_redirects=False) as client:
        if mode == "preflight":
            result = preflight(client, rows["Polygon RPC (Alchemy)"])
        else:
            # Auth headers are scoped to the relayer; RPC snapshots use a separate client.
            with httpx.Client(timeout=25, follow_redirects=False, headers=headers) as relayer:
                result = submit_with_rpc_client(relayer, client, rows["Polygon RPC (Alchemy)"], account, mode)
    print(json.dumps(result, indent=2))


def submit_with_rpc_client(relayer, client, url, account, mode):
    # submit() needs both surfaces; only relayer requests carry authentication.
    class ScopedClient:
        def get(self, target, **kwargs):
            return relayer.get(target, **kwargs)

        def post(self, target, **kwargs):
            return (relayer if target.startswith(HOST + "/") else client).post(target, **kwargs)
    surface = ScopedClient()
    return reconcile(surface, url) if mode == "reconcile" else submit(surface, url, account, mode)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not expose requests, private keys, RPC URLs or provider exceptions.
        print("Probe stopped:", str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        sys.exit(1)
