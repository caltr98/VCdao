"""Check whether CLOB L1 auth admits a deployed ERC-1271 address."""
import json
import time
from importlib import import_module

import httpx
from eth_account.messages import encode_typed_data
from eth_utils import keccak
from polymarket._internal.l1_auth import build_api_key_auth_typed_data

control = import_module("post-deposit-probe")
probe = import_module("relayer-safe-probe")
state_path = probe.ROOT / "output/clob-contract-auth.json"


def main():
    state = json.loads(state_path.read_text(encoding="utf-8"))
    if "clobAuth" in state and "eoaControlHttpStatus" in state["clobAuth"]:
        raise SystemExit("Contract auth attempt already recorded")
    rows = probe.secrets()
    signer = control.account_for(rows)
    timestamp = int(time.time())
    if "clobAuth" not in state:
        typed = build_api_key_auth_typed_data(address=state["probe"], chain_id=137, timestamp=timestamp)
        signed = signer.sign_message(encode_typed_data(full_message=typed))
        signature = "0x" + signed.signature.hex()
        calldata = keccak(text="isValidSignature(bytes32,bytes)")[:4] + signed.message_hash + (64).to_bytes(32, "big")
        calldata += len(signed.signature).to_bytes(32, "big") + signed.signature.ljust(96, b"\0")
        with httpx.Client(timeout=25, follow_redirects=False) as client:
            onchain = client.post(rows["Polygon RPC (Alchemy)"], json={"jsonrpc": "2.0", "id": 1,
                "method": "eth_call", "params": [{"to": state["probe"], "data": "0x" + calldata.hex()}, "latest"]}).json()
            if onchain.get("result", "")[:10].lower() != "0x1626ba7e":
                raise SystemExit("Onchain ERC-1271 signature check failed")
            state["clobAuth"] = {"onchainERC1271": "0x1626ba7e", "timestamp": timestamp, "status": "pending"}
            state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
            response = client.post("https://clob.polymarket.com/auth/api-key", headers={
                "POLY_ADDRESS": state["probe"], "POLY_SIGNATURE": signature,
                "POLY_TIMESTAMP": str(timestamp), "POLY_NONCE": "0"})
        body = response.json()
        if response.status_code == 200 and all(key in body for key in ("apiKey", "secret", "passphrase")):
            from pathlib import Path
            with Path(r"C:\Users\iperc\polymarket-dao-secrets.md").open("a", encoding="utf-8") as target:
                target.write("# CLOB contract auth credentials\n\n")
                for key in ("apiKey", "secret", "passphrase"):
                    target.write(f"| {key} | `{body[key]}` |\n")
            state["clobAuth"].update(status="accepted", storedOutsideProject=True)
        else:
            state["clobAuth"].update(status="rejected", httpStatus=response.status_code,
                error=str(body.get("error", body.get("message", "unknown error")))[:300])
        state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(state["clobAuth"], indent=2))

    control_typed = build_api_key_auth_typed_data(address=signer.address, chain_id=137, timestamp=timestamp)
    control_signature = "0x" + signer.sign_message(encode_typed_data(full_message=control_typed)).signature.hex()
    with httpx.Client(timeout=25, follow_redirects=False) as client:
        control_response = client.get("https://clob.polymarket.com/auth/derive-api-key", headers={
            "POLY_ADDRESS": signer.address, "POLY_SIGNATURE": control_signature,
            "POLY_TIMESTAMP": str(timestamp), "POLY_NONCE": "0"})
    state["clobAuth"]["eoaControlHttpStatus"] = control_response.status_code
    state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
