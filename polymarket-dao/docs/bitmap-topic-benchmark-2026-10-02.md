# Current bitmap DAO: assumptions and measured results

The credential issuer trust model is assumed to exist. The DAO selects its classifications, skills and relevance matrix. A DAO member, including the proposer, can act as solver. Polymarket operates its external exchange, relayer and oracle. Missing delivery causes no purchase payment or penalty; the existing expire() call releases the reservation after the deadline.

## Topic mapping

The DAO-selected example catalog contains 10 expertise topics and 56 skills. The original eight skill IDs retain their bit positions. Every market condition is bound to one expertise topic through the existing governance-controlled registry. Categories/subcategories and substantive tags are classified by a versioned DAO policy; explicit overrides and conflict reporting are supported. The selected catalog is fixed for that DAO deployment.

The saved 100-event API sample contains 1,225 markets. The policy maps all 1,225; 1,222 contain the fields needed to form a registration candidate. Registration candidates are data records, not evidence that a market is currently tradable or registered onchain. This is sample coverage, not a census of Polymarket.

## Bitmap gas experiment

Five fresh local DAO runs. Each member joins with 5 native units, self-delegates, registers a DID and submits an issuer-signed VC containing the original eight skills. The current catalog has ten topics; this skill profile produces four nonzero topic scores. The table measures upgradeSkillWithVC receipts only. Deployment, activation and deposits are retained separately. Each cumulative row sums the first N upgrades in its fresh run.

Estimated USD costs use a fixed Polygon snapshot gas price of 278.395338579 gwei and the CoinGecko annual average of $0.111714934938384707650273224/POL (2 October 2025–2 October 2026).

| Members | Skills each | Cumulative gas | Average gas/member | Estimated POL | Estimated USD |
|---:|---:|---:|---:|---:|---:|
| 1 | 8 | 668,565 | 668,565.00 | 0.186125 | $0.020793 |
| 2 | 8 | 1,279,466 | 639,733.00 | 0.356197 | $0.039793 |
| 4 | 8 | 2,501,268 | 625,317.00 | 0.696341 | $0.077792 |
| 8 | 8 | 4,944,872 | 618,109.00 | 1.376629 | $0.153790 |
| 16 | 8 | 9,832,056 | 614,503.50 | 2.737199 | $0.305786 |
| 32 | 8 | 19,606,400 | 612,700.00 | 5.458330 | $0.609777 |
| 64 | 8 | 39,155,148 | 611,799.19 | 10.900611 | $1.217761 |

All five runs produced the same aggregate values (standard deviation 0). This establishes deterministic reproducibility for this profile.

## Observed live operation costs

USD uses CoinGecko average POL/USD 0.111714934938384707650273224 for 2 October 2025–2 October 2026, 366 daily observations. Live receipts belong to the recorded deployed versions; the new catalog measurements above are local. Purchase/delivery and redemption are separate recorded runs.

| Step | Operation | Network-fee payer | Fee POL | Fee USD | pUSD movement |
|---:|---|---|---:|---:|---|
| 1 | Buy: propose, one vote, queue | Members / execution caller | 0.172993828 | $0.019326 | — |
| 1 | Gas policy: propose, one vote, queue | Members / execution caller | 0.148825296 | $0.016626 | — |
| 1 | Redemption: propose, one vote, queue | Members / execution caller | 0.149389058 | $0.016689 | — |
| 2 | Authorize buy | Execution caller | 0.128123534 | $0.014313 | Reserved DAO budget |
| 3 | Place order | No network fee | 0 | $0 | — |
| 4 | Fill order | External settlement submitter | 0.175426453 | $0.019598 | Solver pays 1.25 pUSD |
| 5 | Push shares | Polymarket relayer | 0.083578005 | $0.009337 | — |
| 6 | Pay solver | Relayer, within step 5 | Included | Included | DAO pays 1.259906 pUSD |
| 7 | Oracle resolution | External oracle infrastructure | Excluded | Excluded | — |
| 8 | Execute redemption | Caller upfront; DAO reimburses | 0.172446449 | $0.019265 | — |
| 9–11 | Timelock / adapter / burn | Caller, within step 8 | Included | Included | — |
| 12 | DAO payout | Caller, within step 8 | Included | Included | DAO receives 0.1 pUSD |
| 13 | Caller refund | Caller, within step 8 | Included | Included | DAO refunds 0.196211976 POL |

The POL allocation execution is another recorded setup transaction: 303,345 gas, 0.084180934 POL. It appears separately in live-operations.csv. Exchange settlement cost is for the complete receipt. Included fees are counted once. Principal, proceeds and reimbursement are separate from network fees.

## Verification and reproducibility

114 Hardhat tests pass; TypeScript checking passes. Solidity 0.8.28, optimizer 200 runs, Cancun. Runtime sizes remain below the EVM limit: DaoSkillCalculator 1,660 bytes; DaoGovernanceSkill 11,278; MarketGovernor 24,173; RedeemableOrderVault 24,409. The new checks cover classification overrides/conflicts, exact outcome labels, new credentials, duplicate credentials, custom catalogs and a proposer acting as solver.

Commands: npx hardhat run scripts/benchmark-bitmap.ts; npx ts-node scripts/map-topics.ts events.json output/topic-mapping.json; npx ts-node scripts/collect-live-costs.ts. The collector makes read-only Polygon RPC requests. There were no live broadcasts.

manifest.json contains compiler settings, policy, source hashes and methodology. operations.json/csv contain local receipts; live-operations.json/csv contain 48 observed mainnet receipts. Superseded design notes and the old integration harness are in the project legacyideas directory. Existing transaction evidence is preserved.
