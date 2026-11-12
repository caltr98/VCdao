"""Independent historical receipt verification of the sponsored vault redemption."""
import hashlib
import json
import sys
from importlib import import_module
from pathlib import Path

import httpx
from eth_abi import decode
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak
from polymarket._internal.actions.relayer.signing.deposit_wallet import build_deposit_wallet_typed_data

probe = import_module("probe-relayer-redemption")
PATH = probe.ROOT / "output/relayer-redemption-verification.json"


def rpc_secret():
    for line in Path(r"C:\Users\iperc\polymarket-dao-secrets.md").read_text().splitlines():
        parts = line.split("|")
        if len(parts) == 4 and parts[1].strip() == "Polygon RPC (Alchemy)":
            return parts[2].strip().strip("`")
    raise RuntimeError("Project Polygon RPC missing")


def topic_address(topic):
    return "0x" + topic[-40:].lower()


def decoded_logs(receipt):
    result = {"pUSD": [], "positions": [], "redemption": []}
    signatures = {name: "0x" + keccak(text=signature).hex() for name, signature in [("pUSD", "Transfer(address,address,uint256)"), ("single", "TransferSingle(address,address,address,uint256,uint256)"), ("batch", "TransferBatch(address,address,address,uint256[],uint256[])"), ("redemption", "PositionRedeemed(uint256,address,uint256,uint256,uint256)")]}
    for log in receipt["logs"]:
        decode_log(log, signatures, result)
    return result


def decode_log(log, signatures, result):
    topics, address = log["topics"], log["address"].lower()
    data = bytes.fromhex(log["data"][2:])
    if address == probe.PUSD.lower() and topics[0] == signatures["pUSD"]:
        result["pUSD"].append({"from": topic_address(topics[1]), "to": topic_address(topics[2]), "amount": decode(["uint256"], data)[0]})
    if address == probe.CTF.lower() and topics[0] in [signatures["single"], signatures["batch"]]:
        ids, amounts = decode(["uint256", "uint256"] if topics[0] == signatures["single"] else ["uint256[]", "uint256[]"], data)
        result["positions"].append({"operator": topic_address(topics[1]), "from": topic_address(topics[2]), "to": topic_address(topics[3]), "ids": [ids] if isinstance(ids, int) else list(ids), "amounts": [amounts] if isinstance(amounts, int) else list(amounts)})
    if address == probe.VAULT.lower() and topics[0] == signatures["redemption"]:
        yes, no, payout = decode(["uint256"] * 3, data)
        result["redemption"].append({"market": int(topics[1], 16), "caller": topic_address(topics[2]), "yes": yes, "no": no, "payout": payout})


def exact_request(payload, transaction):
    params = payload["depositWalletParams"]
    calls = probe.calls_for("fundedProbe")
    tuples = [(c.to, c.value, bytes.fromhex(c.data[2:])) for c in calls]
    batch = (probe.WALLET, int(payload["nonce"]), int(params["deadline"]), tuples)
    data = probe.calldata("execute((address,uint256,uint256,(address,uint256,bytes)[])[],bytes[])", ["(address,uint256,uint256,(address,uint256,bytes)[])[]", "bytes[]"], [[batch], [bytes.fromhex(payload["signature"][2:])]])
    typed = build_deposit_wallet_typed_data(wallet=probe.WALLET, calls=calls, nonce=payload["nonce"], deadline=params["deadline"], chain_id=137)
    signer = Account.recover_message(encode_typed_data(full_message=typed), signature=payload["signature"])
    # The factory selector differs from the wallet's execute selector; compare all ABI arguments.
    return data[10:].lower() == transaction["input"][10:].lower() and signer.lower() == probe.SIGNER.lower()


def position_flow(logs, source, destination, token):
    return sum(amount for entry in logs["positions"] if entry["from"] == source.lower() and entry["to"] == destination.lower() for ident, amount in zip(entry["ids"], entry["amounts"]) if ident == token)


def checks(client, url, tx, receipt, logs, before, after, payload, journal):
    zero = "0x" + "00" * 20
    tokens = [int(probe.MARKET[name]) for name in ["yes", "no"]]
    event = logs["redemption"]
    return {
        "receiptSucceeded": receipt["status"] == "0x1",
        "exactSignedRequestExecuted": exact_request(payload, tx),
        "relayerPaidOuterTransaction": tx["from"].lower() not in [probe.SIGNER.lower(), probe.WALLET.lower(), probe.VAULT.lower()] and tx["to"].lower() == probe.FACTORY.lower() and int(tx["value"], 16) == 0,
        "realResolvedCondition": before["denominator"] == 1 and before["payouts"] == [1, 0],
        "realSplitMintedCompleteSet": all(position_flow(logs, zero, probe.ADAPTER, token) == 100_000 and position_flow(logs, probe.ADAPTER, probe.WALLET, token) == 100_000 for token in tokens),
        "exactSharesDeliveredToVault": all(position_flow(logs, probe.WALLET, probe.VAULT, token) == 100_000 for token in tokens),
        "vaultSharesBurned": all(position_flow(logs, probe.VAULT, probe.ADAPTER, token) == 100_000 and position_flow(logs, probe.ADAPTER, zero, token) == 100_000 for token in tokens),
        "redemptionEventExact": len(event) == 1 and event[0] == {"market": int(probe.MARKET["conditionId"], 16), "caller": probe.WALLET.lower(), "yes": 100_000, "no": 100_000, "payout": 100_000},
        "payoutMintedDirectlyToVault": sum(e["amount"] for e in logs["pUSD"] if e["from"] == zero and e["to"] == probe.VAULT.lower()) == 100_000,
        "vaultPusdIncreasedByPrincipal": after["balances"]["vault"]["pUSD"] - before["balances"]["vault"]["pUSD"] == 100_000,
        "solverSpentOnlyPrincipal": before["balances"]["depositWallet"]["pUSD"] - after["balances"]["depositWallet"]["pUSD"] == 100_000,
        "signerReceivedNoPusd": before["balances"]["signer"]["pUSD"] == after["balances"]["signer"]["pUSD"],
        "signerPaidNoPolygonGas": before["balances"]["signer"]["POL"] == after["balances"]["signer"]["POL"],
        "depositWalletPaidNoPolygonGas": before["balances"]["depositWallet"]["POL"] == after["balances"]["depositWallet"]["POL"] == 0,
        "positionsConsumed": after["resolvedHoldings"] == {"vault": [0, 0], "depositWallet": [0, 0]},
        "vaultApprovalRevoked": after["approval"] is False,
        "solverAdapterAllowanceCleared": probe.read(client, url, probe.PUSD, "allowance(address,address)", ["address", "address"], [probe.WALLET, probe.ADAPTER], block=receipt["blockNumber"]) == 0,
        "existingAssetsPreserved": before["existingPosition"] == after["existingPosition"] == {"oldVault": 0, "safe": 5_000_000} and before["balances"]["oldVault"] == after["balances"]["oldVault"] and before["balances"]["safe"] == after["balances"]["safe"],
        "originalJournalUnchanged": hashlib.sha256((probe.ROOT / "output/live-redemption.json").read_bytes()).hexdigest() == journal[0]["completedLiveJournalSha256"],
    }


def historical_snapshot(client, url, block):
    # Reuse the read-only queries at exact receipt blocks, independent of attempt snapshots.
    class HistoricalClient:
        def post(self, target, **kwargs):
            request = kwargs["json"]
            if request["method"] == "eth_blockNumber":
                return httpx.Response(200, json={"result": block})
            return client.post(target, **kwargs)
    return probe.snapshot(HistoricalClient(), url)


def main():
    journal = probe.events()
    payload = next(e["request"] for e in journal if e["phase"] == "fundedProbe:prepared")
    accepted = next(e["response"]["body"] for e in journal if e["phase"] == "fundedProbe:response")
    url, txhash = rpc_secret(), accepted["transactionHash"]
    with httpx.Client(timeout=25, follow_redirects=False) as client:
        tx = probe.rpc(client, url, "eth_getTransactionByHash", [txhash])
        receipt = probe.rpc(client, url, "eth_getTransactionReceipt", [txhash])
        if not tx or not receipt:
            raise RuntimeError("Receipt not yet mined")
        before = historical_snapshot(client, url, hex(int(receipt["blockNumber"], 16) - 1))
        after = historical_snapshot(client, url, receipt["blockNumber"])
        logs = decoded_logs(receipt)
        assertions = checks(client, url, tx, receipt, logs, before, after, payload, journal)
        report = {"network": "Polygon mainnet", "transactionHash": txhash, "block": after["block"], "confirmations": int(probe.rpc(client, url, "eth_blockNumber", []), 16) - after["block"] + 1, "gasPayer": tx["from"], "gasUsed": int(receipt["gasUsed"], 16), "effectiveGasPriceWei": int(receipt["effectiveGasPrice"], 16), "gasFeeWei": int(receipt["gasUsed"], 16) * int(receipt["effectiveGasPrice"], 16), "vault": probe.VAULT, "depositWallet": probe.WALLET, "signer": probe.SIGNER, "principal": 100_000, "before": before, "after": after, "logs": logs, "checks": assertions, "allChecksPassed": all(assertions.values())}
        PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: report[k] for k in ["transactionHash", "block", "confirmations", "gasPayer", "gasUsed", "gasFeeWei", "checks", "allChecksPassed"]}, indent=2))
    if not report["allChecksPassed"]:
        raise RuntimeError("Independent verification failed; inspect report")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Verification stopped:", str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        sys.exit(1)
