"""Recompute current local gas tables alongside preserved live receipt evidence."""
import csv
import hashlib
import json
from decimal import Decimal, getcontext
from pathlib import Path

getcontext().prec = 70
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output/queue-reimbursement"
PAST = Path("C:/Users/iperc/Documents/Codex/2026-10-02/dao-funded-redemption/outputs/bitmap-topic-benchmark")
PRICE = Decimal("0.111714934938384707650273224")
GAS_PRICE = 278395338579


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def costs(wei):
    pol = Decimal(wei) / Decimal(10**18)
    return f"{pol:.9f}", f"${pol * PRICE:.9f}"


def table(headers, rows):
    return "\n".join(["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers), *["| " + " | ".join(map(str, row)) + " |" for row in rows]])


def current_rows(records):
    rows = []
    for operation in dict.fromkeys(row["operation"] for row in records):
        values = [row for row in records if row["operation"] == operation]
        fees = [int(row["fee"]) for row in values]
        refunds = [int(row["reimbursement"]) for row in values]
        gas = [int(row["gasUsed"]) for row in values]
        assert all(fee == int(row["gasUsed"]) * GAS_PRICE for fee, row in zip(fees, values))
        mean = lambda items: sum(map(Decimal, items)) / len(items)
        rows.append([operation, len(values), f"{min(gas):,}–{max(gas):,}", f"{mean(gas):,.1f}", *costs(mean(fees)), costs(mean(refunds))[0], costs(mean(fees) - mean(refunds))[0]])
    return rows


def bitmap_rows():
    operations = read(ROOT / "output/benchmarks-bitmap/operations.json")
    aggregate = read(ROOT / "output/benchmarks-bitmap/aggregate.json")
    for row in aggregate:
        for sample in range(1, 6):
            upgrades = [int(item["gas_used"]) for item in operations if item["sample"] == sample and item["operation"] == "upgradeSkillWithVC" and item["member"] <= row["members"]]
            assert len(upgrades) == row["members"] and sum(upgrades) == row["mean_gas"]
    return [[r["members"], 8, f'{r["mean_gas"]:,}', f'{r["average_gas_per_member"]:,.2f}', *costs(int(r["mean_gas"]) * GAS_PRICE)] for r in aggregate]


def live_rows():
    live = read(PAST / "live-operations.json")
    rows = []
    for r in live["records"]:
        assert int(r["gas_used"]) * int(r["gas_price_wei"]) == int(r["fee_wei"])
        rows.append([r["run_id"], r["operation"], f'{int(r["gas_used"]):,}', *costs(int(r["fee_wei"])), r["network_fee_payer"]])
    assert len(rows) == 48
    return rows


def manifest():
    paths = [ROOT / p for p in ["contracts/MarketGovernor.sol", "contracts/VaultRedemption.sol", "contracts/GovernanceAutomation.sol", "test/redemption-governance.ts", "scripts/queue-fee-tables.py", "hardhat.config.ts", "output/queue-reimbursement/operations.json", "output/benchmarks-bitmap/manifest.json"]]
    sizes = {}
    for name in ["MarketGovernor", "RedeemableOrderVault"]:
        artifact = read(ROOT / f"artifacts/contracts/{name}.sol/{name}.json")
        sizes[name] = (len(artifact["deployedBytecode"]) - 2) // 2
        assert sizes[name] <= 24576
    return {"date": "2026-10-03", "source_sha256": {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}, "runtime_bytes": sizes, "live_broadcasts": 0, "estimated_gas_price_wei": str(GAS_PRICE), "annual_usd_per_pol": str(PRICE), "local_adapter": "mock; excludes real Polygon adapter gas", "historical_live_rows": 48, "bitmap_upgrade_receipts": 320}


def main():
    records = read(OUT / "operations.json")
    sections = ["# Queue and execution reimbursement — 3 October 2026", "Successful, single-action, market-bound redemption proposals reimburse the immediate Governor caller separately for queue and execution. Each payment uses the existing voted unit, overhead, gas-price and per-payment caps and consumes the shared POL allocation. A queue payment remains paid if execution later fails or the proposal is cancelled; approval and successful queueing earned that payment. A depleted allocation allows execution with zero reimbursement. Rejected native payments create reserved credit for the caller.", "## Current local governance gas", "Five fresh local DAOs, separate queue/execution callers, mocked resolved CTF and adapter. Fixed price: 278.395338579 gwei. USD uses the saved annual average $0.111714934938384707650273224/POL. These estimates are not new Polygon measurements. Negative caller net cost means the bounded policy refund exceeds the receipt fee; it is not an extra network fee.", table(["Operation", "Samples", "Gas range", "Mean gas", "Fee POL", "Fee USD", "Refund POL", "Caller net POL"], current_rows(records)), "Members pay propose/vote fees. The queue caller and execution caller pay their own transaction upfront; the DAO funds their capped refunds. Timelock, adapter, burns, payout and refund are internal work counted in the single execute receipt. Local redemption pays 0.1 mock pUSD to the vault and zero pUSD to either caller.", "## Repeated bitmap tables", "Five fresh runs, 64 preactivated members each, eight skills/member. All 320 upgrade receipts and first-N sums checked independently. Setup and membership principal excluded.", table(["Members", "Skills each", "Cumulative gas", "Gas/member", "Estimated POL", "Estimated USD"], bitmap_rows()), "## Completed historical live receipt table", "The 48 preserved receipts belong to the older deployed version, which reimburses execution only. Purchase/delivery and redemption are separate runs. Queue fees below were not reimbursed. No paid run was repeated. Solver purchase: 1.25 pUSD; DAO payment: 1.259906 pUSD in the delivery receipt. Redemption payout: 0.1 pUSD; historical execution refund: 0.196211976206520912 POL. Neither pUSD principal nor POL reimbursement is added to network fees. Oracle fees are excluded.", table(["Run", "Operation", "Gas", "Observed fee POL", "Fee USD at annual mean", "Upfront payer"], live_rows()), "## Reproduce", "Run `npm test`, `npx hardhat run scripts/benchmark-bitmap.ts`, then `python scripts/queue-fee-tables.py`. The source and evidence hashes, runtime sizes and methods are saved in verification.json. Raw local operation receipts are in operations.json; historical raw receipts remain in the earlier bitmap-topic-benchmark directory."]
    (OUT / "results.md").write_text("\n\n".join(sections) + "\n", encoding="utf-8")
    (OUT / "verification.json").write_text(json.dumps(manifest(), indent=2) + "\n", encoding="utf-8")
    with (OUT / "operations.csv").open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=list(records[0]))
        writer.writeheader()
        writer.writerows(records)


if __name__ == "__main__":
    main()
