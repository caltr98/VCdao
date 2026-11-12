"""LIVE solver delivery for scripts/live-auction.ts: once the vault's auction price covers the recorded
cost, the solver's Deposit Wallet relays one push: safeTransferFrom(wallet, vault, token, shares,
abi.encode(id, tx, order)). The relayer refuses setApprovalForAll for the vault, so pull delivery fails.
Needs RELAYER_KEY (the Trading EOA's relayer API key) in the environment; it is never written."""
import json, os, time
from importlib import import_module

import httpx
from eth_abi import encode
from eth_utils import keccak
from polymarket import RelayerApiKey, SecureClient
from polymarket._internal.actions.relayer.calls import TransactionCall

probe = import_module("relayer-safe-probe")
PATH = probe.ROOT / "output/live-auction.json"
POSITIONS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"


def call(rpc, to, data):
    return int(httpx.post(rpc, json={"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": to, "data": data}, "latest"]}, timeout=20).json()["result"], 16)


def main():
    rows, state = probe.secrets(), json.loads(PATH.read_text())
    if "deliver" in state:
        raise SystemExit("Delivery already journaled")
    rpc, vault, buy, auth = rows["Polygon RPC (Alchemy)"], state["dao"]["vault"], state["buy"], state["authorizeBuy"]
    ident = bytes.fromhex(auth["id"][2:])
    price = "0x" + keccak(text="currentPayment(bytes32)")[:4].hex() + ident.hex()
    while call(rpc, vault, price) < int(buy["cost"]):
        time.sleep(10)
    wallet = "0x92DC8012d9C27703d9EBE7a3EdD1037eE8ac4f2a"
    data = encode(["bytes32"] * 3, [ident, bytes.fromhex(buy["settlementTx"][2:]), bytes.fromhex(buy["orderId"][2:])])
    push = keccak(text="safeTransferFrom(address,address,uint256,uint256,bytes)")[:4] + encode(["address", "address", "uint256", "uint256", "bytes"], [wallet, vault, int(state["market"]["yes"]), 5_000_000, data])
    calls = [TransactionCall(to=POSITIONS, data="0x" + push.hex())]
    state["deliver"] = {"status": "pending", "priceAtSubmit": call(rpc, vault, price)}
    PATH.write_text(json.dumps(state, indent=2))
    key = RelayerApiKey(key=os.environ["RELAYER_KEY"], address=rows["Trading EOA address"])
    with SecureClient.create(private_key=rows["Trading EOA private key"], api_key=key) as client:
        outcome = client.execute_transaction(calls=calls, metadata="BetVault push delivery").wait()
    status = "0x" + keccak(text="status(bytes32)")[:4].hex() + ident.hex()
    shares = "0x00fdd58e" + encode(["address", "uint256"], [vault, int(state["market"]["yes"])]).hex()
    state["deliver"].update(status="done", outcome=str(outcome), vaultStatus=call(rpc, vault, status), vaultShares=call(rpc, POSITIONS, shares))
    PATH.write_text(json.dumps(state, indent=2))
    print(json.dumps(state["deliver"], indent=2))


if __name__ == "__main__":
    main()
