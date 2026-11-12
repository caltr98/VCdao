"""Offline official SDK signing for fork-only benchmark batches."""
import json
import sys
from eth_account import Account
from polymarket._internal.actions.relayer.calls import TransactionCall
from polymarket._internal.actions.relayer.signing.deposit_wallet import sign_deposit_wallet_batch
from pathlib import Path

batch = json.load(sys.stdin)
rows = Path(r"C:\Users\iperc\polymarket-dao-secrets.md").read_text().splitlines()
key = next(p[2].strip().strip("`") for line in rows if len(p := line.split("|")) == 4 and p[1].strip() == "Trading EOA private key")
account = Account.from_key(key)
assert account.address.lower() == "0xdc9311c53d3d1cb1d9ed87b9028fb35c2168629d"
calls = [TransactionCall(to=c["target"], value=str(c["value"]), data=c["data"]) for c in batch["calls"]]
print(sign_deposit_wallet_batch(account, wallet=batch["wallet"], calls=calls, nonce=str(batch["nonce"]), deadline=str(batch["deadline"]), chain_id=137))
