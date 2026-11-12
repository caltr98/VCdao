# Detailed handoff: whole-system gas and cost benchmarks

Assigned chat: `01a0fc11-91ce-7172-8000-dd6518bfcc21`.
First read `docs/agents-current-workflow-plan-2026-10-02.md`, including its exact
credential retrieval instructions and current workflow traps. The objective is
the **latest system from setup/governance to sponsored vault redemption**, with
measured results ready for manuscript integration. Continue existing useful
inspection; do not substitute an old pull-based demo or isolated redeem test.

## Phase 1: establish the baseline and operation map

Read these concrete Prestifilippo sources without modifying them:

- `D:\DAOPrestifilippo\VCdao\dao\test\gas\gasMisuration.ts`.
- `D:\DAOPrestifilippo\VCdao\dao\benchmark-v3.json`.
- `D:\DAOPrestifilippo\VCdao\dao\test\gas\results\gas-flow.csv`.
- The adjacent `gas-flow-summary.csv`, `gas-aggregates.csv`, `gas-scalability.csv`.
- `D:\DAOPrestifilippo\audit-2026-09-18\evidence\committed-benchmark-v3.json`
  and audit methodology when provenance or reproducibility needs clarification.

The inspected V3 scenario has 10 members, 5 native-currency stake each,
50/50 stake-skill weights, 20% quorum, 70% superquorum, two VC skills
(`cyberSecurity`, `cloudArchitecture`), topic 2, and six For/four Against votes.
Its test uses voting delay 1 block, voting period 50 blocks, Timelock 3600 seconds.
Confirm the current source behavior and state assumptions before reproducing it.
The original monetary conversion uses fixed 1.03244 gwei and 2638.48 USD/ETH.
Those are historical scenario constants, not current Polygon prices.

Create an explicit mapping of join/delegate/DID/VC/propose/vote/queue/execute
to retained or adapted contracts, and identify new setup/market/auction/delivery/
redemption operations. Gas units are the first comparison metric; monetary
columns must carry chain/native-token and price-scenario metadata. Do not mix
original ETH dollar conversions with actual Polygon receipt fees.

## Phase 2: implement a continuous reproducible benchmark

Use a dedicated harness, output directory and run journal. Reuse existing
deployment/governance helpers and the real current contract behavior. Add the
fixed adapter to deployment assets so the resulting vault can redeem. The
parent compiler is Solidity 0.8.28, Cancun, optimizer enabled with 200 runs;
record actual resolved settings and dependency versions.

Implement a full start-to-finish scenario with a shared `run_id`, deployed DAO,
registered market, authorization ID and position throughout:

1. Record each deployment and configuration receipt, including bootstrap
   registration, final Timelock delay and role handover. Distinguish setup
   deployment cost from recurring per-buy cost. Measure shared helper deployments
   even when their runtime feature is not used; label that overhead clearly.
2. Record member join/delegation, DID and VC operations using the baseline
   settings when compatible. Assert snapshot voting power and issuer validation.
   Keep first-use storage cost separate from later-member cost.
3. Fund DAO pUSD treasury and solver acquisition capital separately. Record
   funding as setup/principal, with any transfer's gas as an operation. Native
   membership deposits are also principal, not transaction fees.
4. Construct market-bound `authorizeBuy` with open executor, exact shares,
   payment cap, deadline, registered outcome and market. Submit proposal, votes,
   queue and execute via Governor/Timelock. Record every receipt and assert
   reservations/status/authorizedAt. A local time advance is a waiting mechanism,
   not an onchain transaction cost or a live shortened delay.
5. Acquire exact solver holdings. Model actual CLOB acquisition separately from
   receipt gas: CLOB request is offchain; exchange settlement is onchain. A local
   simulated fill must have its own provenance and must not be labeled live CLOB.
6. Drive the auction to a valid profitable delivery time with price below the
   approved cap. Use the actual push path: encoded 96-byte intent/audit data in
   ERC1155 `safeTransferFrom`, exact amount, Deposit Wallet caller context. Verify
   correct shares delivered, solver paid `currentPayment` atomically, status
   Fulfilled, reservations released and unused cap stays in the treasury.
7. Resolve the market on the local test system, or use a clearly labeled fork
   resolution technique. Measure protocol/oracle work separately if included.
   Never change mainnet oracle state. Assert genuine resolution for live evidence.
8. Execute `RedeemableOrderVault.redeem` through the official Deposit Wallet
   signed-batch mechanism in an execution environment that supports it. A fork
   can simulate factory submission while preserving wallet signature checks;
   that measures execution, not actual relayer acceptance. Record that distinction.
9. Verify consumed shares, expected rounded payout, pUSD delta only in the DAO
   vault, zero caller payout, approval false and reservations preserved. Finish
   after confirmed redemption. Optional withdrawals/cleanup are separate costs.

The continuous test must exercise the **governed paid push**, not a plain
complete-set transfer to an isolated vault. Existing ordinary demo assets may
need a redemption-capable mock for a local deterministic run; reuse the test
fixtures in `test/redemption.ts` where suitable and identify mock costs. Add a
Polygon-fork scenario using real CTF/adapter and Deposit Wallet execution where
feasible, with all simulated funding/acquisition/resolution explicitly labeled.
Keep real-contract gas separate from mock-contract gas.

Do not conceal an economic inconsistency by splitting a complete set after a
market is resolved and calling its cost the price of a discounted CLOB buy.
The winning resolved outcome has full payout value; the already-resolved
0.1-pUSD fixture is a redemption validation/observed batch cost, not the entire
auction acquisition model. Design representative pre-resolution acquisition
and later-resolution cases in local/fork runs, and document the exact simulation.

Run an initial complete scenario, then repeated fresh-state samples (target at
least five when practical) with identical parameters. Add separate winner/loser
redemption and representative nonzero holdings cases if they alter gas materially.
Do not pool unlike scenarios. Keep min/median/mean/max/stddev and sample count
for each comparable operation. Repeated deterministic gas results are useful
reproducibility checks, not evidence of network latency distributions.

## Phase 3: measure the existing mainnet receipts

Use the common plan's journals and actual receipts for acquisition, sponsored
push, earlier redemption, latest sponsored redemption and relevant governance.
Verify receipts yourself through the project RPC. Recover operation hashes from
logs/history if historical journals lack individual governance hashes; record
missing coverage instead of inventing rows.

The latest redemption observation is the five-call sponsored factory batch:
749,937 gas and 290420670235819794 wei fee, relayer-paid, with 0.1 pUSD direct
DAO payout. Keep this as a measured batch row. If reliable trace tools expose
per-call execution, publish trace-derived gas with method and overhead caveats.
Do not divide the receipt fee by five and call the result measured call cost.
Also measure the two diagnostic control receipts separately; exclude them from
normal essential-path totals. The initial HTTP 500 is an offchain rejected
attempt, not a successful redemption benchmark.

A CLOB settlement transaction can settle multiple orders. Record receipt-wide
gas as receipt-wide, and allocate to this order only with defensible trace/data
attribution. Verify sponsorship/payer for each observed transaction individually.
Do not assume the CLOB exchange, push and redeem have identical gas payers.

## Phase 4: plan and carry forward a genuine continuous live run

Prepare the concrete latest-workflow live plan after the reproducible test and
existing-receipt extraction: redeemable DAO deployment/configuration, member
setup, treasury funding, real purchasable standard market, proposal/vote/queue/
execute, solver CLOB buy, sponsored paid push, genuine oracle resolution, and
sponsored vault redemption. State all transaction counts and maximum gas fees,
principal budgets, exact payer/control, expected market resolution/waiting and
failure/cleanup policy. A fresh live deployment or paid governance transaction
requires approval for this concrete spend under the current authorization.

Use the already supplied credentials through the common plan's in-process
retrieval procedure. Do not ask for the relayer key again before attempting
the authorized private retrieval. Do not use a personal gas account as the
production keeper fallback; DAO funding and control are required. The historic
Main EOA signer's membership is not, by itself, proof of DAO-controlled gas funds.
The prior test's 0.1 pUSD authorization is not a new spending allowance.

Complete all local/fork work and evidence extraction while any spend approval
or genuine resolution is pending. Do not mark a continuous mainnet run finished
until the same run's purchased/delivered position is actually redeemed into the
same DAO vault. A pending live run must have a resumable state and a precise
remaining condition. Do not replace it with a synthetic mainnet oracle result
or silently claim the separate historical experiments form one run.

## Data schema and outputs

Use exact integer strings for onchain quantities and Decimal for economic
calculations. Each operation row must contain, as applicable:

`schema_version, run_id, scenario_id, sample_id, environment, chain_id,
fork_block, source_digest, contract_name, contract_address, stage,
operation_id, operation, actor, payer, sponsorship, transaction_hash,
receipt_status, block_number, gas_used, effective_gas_price_wei, fee_wei,
native_token, batch_id, measurement_method, simulation_scope, principal_units,
trading_fee_units, collateral_token, collateral_decimals, elapsed_seconds,
included_in_essential_path, notes`.

Offchain rows should have null onchain gas fields, not fake zero-gas receipts.
Currency conversions add price/date/source/scenario fields. Store public signed
payloads in a separate append/resumable journal, persisted before submission;
never put credentials in any output. Maintain stable operation IDs for merging
with the baseline rather than relying on display labels or row order.

Deliver:

- `scripts/benchmark-system.ts` or a similarly scoped harness using project conventions.
- `output/benchmarks-system/manifest.json`: source/configuration/provenance,
  hashes of preserved inputs, scenario definitions and reproducibility commands.
- `output/benchmarks-system/operations.json` and `.csv`: raw operation records.
- `output/benchmarks-system/summary.json` and `.csv`: scenario/operation statistics,
  deployment total, recurring essential path and payer totals without double counting.
- `output/benchmarks-system/baseline-mapping.csv`: original V3 to new operation mapping,
  measured deltas/ratios only where comparable, and explicit comparison assumptions.
- Dedicated public run journals/receipts and validation results under that directory.
- `docs/system-benchmarks-2026-10-02.md`: paper-ready results explanation,
  scenario table, gas/cost results, provenance and actual remaining live-run status.
- `docs/system-benchmarks-handoff-2026-10-02.md`: exact reproduction and continuation steps.

## Validation and completion gate

Run affected contract tests and type checking for the changed harness; use
network-dependent tests only where needed. Verify row fees as gas × effective
price, totals against unique receipt IDs, outcome/pUSD conservation, governance
authorization, auction price and payout, no double delivery, deadline/wrong-token/
wrong-amount rejection, reservation preservation and terminal redemption.
Failures remain visible. Preserve the existing assertion strength and journals.

The deliverable is measured, reproducible results for the latest workflow,
with custody and cost accounting intact. Local/fork results, real mainnet
observations, trace attribution and estimates are clearly distinct. Every gas
amount states who pays; caller cost zero does not mean network gas zero.
Baseline comparability is demonstrated using the original source/configuration.
Any incomplete continuous mainnet run is named explicitly, with a concrete
approval/resolution dependency rather than a misleading publication claim.
