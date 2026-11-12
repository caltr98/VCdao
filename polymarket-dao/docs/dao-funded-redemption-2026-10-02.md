# DAO-funded, Timelock-approved redemption

## Extension verified on 3 October 2026

The current source reimburses both successful `Governor.queue` and
`Governor.execute` for the same single-action, market-bound redemption scope.
Each operation pays its own immediate caller under the existing voted caps and
consumes the shared allocation. Queue and execution use separate replay markers.
Both emit `RedemptionRefund`; the Governor's queue/execute transaction and
`ProposalQueued`/`ProposalExecuted` event identify the stage. Failed payments
use the existing reserved credit and claim mechanism. A queue payment is earned
on successful queueing even if execution later fails, never happens or is cancelled.

`redemptionChecker` now returns the direct Governor queue payload for a Succeeded
proposal, and the direct execution payload for a ready Queued proposal. The legacy
automation forwarding route rejects redemption at both stages, so reimbursement
reaches the direct caller. Unrelated and batched operations receive no refund.
Each payment retains the same per-payment caps; governance must allocate enough
for both stages. Proposals, votes, failed attempts and credit claims remain unpaid.

The report below records the previous execution-only design and its completed
live test. Those immutable deployments retain that behavior. The extension has
local verification and five local gas samples; it has not been deployed to Polygon.
Updated tables: `output/queue-reimbursement/results.md`.

New `RedeemableOrderVault` deployments redeem standard binary positions through
the fixed Polymarket adapter after a market-bound Governor proposal succeeds,
is queued, and passes the Timelock delay. The vault also requires genuine CTF
resolution. Its `redeem(uint256 market)` entry point accepts only the Timelock.
The adapter, outcome IDs and payout recipient are fixed or independently checked;
the payout remains in the DAO vault. Pending pUSD reservations remain intact.

A transaction caller pays Polygon gas upfront. When that caller executes a
single approved redemption through `MarketGovernor.execute`, the Governor
measures the work, completes Timelock execution, and asks the vault to reimburse
`msg.sender`. This path requires no relayer, sponsorship API, hosted service or
additional execution contract. A script or explicit-target resolver can supply
the external trigger. The Timelock cannot originate a transaction by itself.

## Treasury allocation and payment

Native membership deposits still arrive in the existing treasury. Sending more
POL to its payable receive function adds treasury funds without granting any
authority. Governance votes on the following zero-value vault action:

```solidity
configureRedemptionGas(budget, maxRefund, maxGasPrice, maxGasUnits, overhead)
```

`budget` sets the remaining allocation in wei; it replaces the previous amount.
It is not an allowance controlled by an execution caller. Governance can set it
to zero to release an unused allocation. Configuration requires funds already
held by the vault and preserves any deferred refund liabilities. The Governor
requires exactly 164 calldata bytes for this action. Its market electorate is
the declared, registered proposal topic, as for other treasury maintenance.

Only the Timelock can configure these values. The policy also enforces absolute
ceilings of 5,000,000 gas units, 150,000 overhead units and 10,000 gwei per unit;
overhead cannot exceed the approved gas-unit limit. Zero budgets or caps disable
payment while allowing a valid redemption to complete.

For a successful single-action redemption, payment is:

```text
units  = min(Governor-measured execution gas + approved overhead, approved unit cap)
price  = min(transaction gas price, approved gas-price cap)
refund = min(units × price, approved per-execution cap, remaining POL allocation)
```

The measurement surrounds `super.execute`, including Governor validation and
the Timelock/adapter execution. The fixed voted overhead accounts for intrinsic
transaction gas, decoding and entry work, and the reimbursement work after the
measurement. The meter counts gross EVM gas; receipt gas can be lower because of
storage refunds. This is a bounded policy payment, not an exact reconstruction
of a final transaction receipt. A caller cannot request a larger amount or
choose a payout address. Execution refunds exclude proposing, voting, queuing,
acquisition, deployment, failed attempts and later credit claims.

`bindRedemptionGovernor` runs through the bootstrap Timelock once, validates the
Governor's vault and Timelock, and is sealed before role handover. It is not an
allowed Governor maintenance action. Its sole privilege is the narrowly scoped
reimbursement call. The vault checks the proposal's executed state and market
topic and marks its ID once. The trusted Governor calls it only after a successful
proposal with exactly one vault target, zero value, and exactly 36 bytes of
`redeem(market)` calldata. Proposal and Timelock single-use checks prevent replay.

`withdrawNative` can spend only:

```text
vault POL balance − remaining redemption allocation − unpaid refund liabilities
```

The allocation is reduced before native transfer. Delivery gets a bounded
30,000-gas call; rejection or gas exhaustion records a credit for that same caller
without undoing successful redemption. The credit is reserved from withdrawals
and future allocations. The caller can later invoke `claimRedemptionRefund` to
receive its own credit; it cannot redirect payment. A failed claim reverts and
preserves the credit. Successful claims clear it once. Governor execution and
vault redemption/refund/claim/withdrawal paths are guarded against reentry, and
the contracts never use `tx.origin` to identify the caller.

## Proposing and executing redemption

The topic and first redemption argument must both be `uint256(conditionId)`.
The market must already be registered. Governance approval does not fabricate
resolution: an unresolved CTF denominator, invalid real outcome IDs, absent
holdings or failed adapter verification reverts execution atomically. The
proposal can remain queued and be executed once the real oracle resolves it.

1. Fund the treasury with its intended POL amount.
2. Propose, vote, queue and execute `configureRedemptionGas` through the ordinary
   market-topic electorate.
3. Propose the single action `vault.redeem(market)` with that market topic, vote
   and queue it. Wait for the Timelock delay and real resolution.
4. Call `governor.execute(targets, [0], [redeemCalldata], descriptionHash)` directly.
   The Timelock calls the vault, which consumes both outcomes and verifies its
   pUSD payout and cleared approval. The Governor then reimburses its caller.
5. Read `PositionRedeemed` and `RedemptionRefund`, verify the proposal, market,
   caller and amount, and check treasury allocation and native balance changes.

`GovernanceAutomation.checker` preserves its original automation-target payload
for ordinary governance. It can queue a redemption, but does not advertise its
queued execution through `advance`, which rejects redemption forwarding.
`redemptionChecker` instead returns `(canExec, target, payload)`, with the target
explicitly set to the Governor. It advertises execution only for a queued,
ready, single-action redemption whose vault preview passes. Send that payload
directly to the returned target. The Worker is unchanged; the scripts exercise
this direct route.

A contract wallet executing directly receives its own refund or deferred credit.
An intervening contract is the Governor's caller. Batches containing redemption
and direct `Timelock.executeBatch` execution remain valid governance operations,
but carry no execution reimbursement. This keeps unrelated work outside the
approved payment boundary.

## Verification and mainnet preparation

The affected Solidity tests exercise the complete proposal/vote/queue/execute
flow, delay and resolution, wrong topics and calldata, direct-call authorization,
duplicate and rejected operations, simulations, unrelated and batched actions,
gas-price/unit/payment/budget caps, depleted allocation, failed adapter execution,
native withdrawal accounting, contract recipients, refund reentry, rejected
delivery and credit claims. Existing redemption tests retain fractional payout,
losing holdings, outcome mappings, consumed shares, payout and approval checks.

The journal tests use throwaway local keys on local chain 137. They verify that
signed bytes are saved before broadcast, the same label resumes the same nonce,
changed requests are refused, persistence failure never broadcasts, snapshots
remain stable, and the cumulative fee ceiling is checked before signing.

```powershell
npx hardhat test test/redemption.ts test/redemption-governance.ts test/governance.ts test/vault.ts test/contract-orders.ts test/automation.ts
npm run typecheck
npm run test:redemption-journal
npm run demo
npm run demo:delivery
python -m unittest discover -s test -p "test_*.py" -v
# POLYGON_RPC_URL is supplied in the process environment.
npm run check:fork-redemption
```

`scripts/fork-dao-redemption.ts` runs the complete proposed live scenario with
the actual Polygon pUSD, CTF and fixed adapter and their pre-existing resolution.
It impersonates the Main EOA on the local fork; Safe funding uses the real
owner-call signature path. It injects no oracle result, CTF holdings or contract
storage. All transactions use the snapshot Polygon gas price so locally mined
blocks cannot reduce the quoted cost. The report is
`output/fork-dao-funded-redemption.json`; it verifies payout, burns, cleared
approval, proposal execution, refund recipient, POL balance and allocation
decreases, cleanup and existing asset preservation.

`output/dao-funded-redemption-live-plan.json` records the exact deployment plan,
artifact hashes, sources, principal, POL allocation, policy caps, transaction
count, measured gas, summed buffered gas limits and maximum network cost.
`scripts/live-dao-redemption.ts` requires approval of that exact plan hash and
unchanged artifacts. It uses the common deployment sequence and a new resumable
`output/live-dao-funded-redemption.json` journal. It saves exact signed bytes
before every deployment or other broadcast, runs sequentially, checks total
confirmed/pending worst-case fees, and never automatically replaces transactions.
A resumed stage must match the original target, calldata and value.

The proposed fixture deploys nine contracts: TimelockController, GovernanceToken,
SkillCalculator, GovernanceSkill, MarketRegistry, RedeemableOrderVault,
SafeMandateHandler, MarketGovernor and GovernanceAutomation. The last two route
support contracts are retained by the shared deployment for compatibility.
Deployment, membership, funding, allocation, acquisition, redemption and cleanup
take 42 transactions. The test uses 0.1 pUSD from the original funding Safe,
0.1 POL for membership and 0.5 POL for the DAO gas allocation from the Main EOA.
The prepared fixture requires 0.1 pUSD of recoverable principal. Cleanup
returns the principal to the Safe and unused native funds to their Main EOA
source through a further voted proposal.

`scripts/verify-dao-redemption.ts` independently decodes the execution transaction,
recomputes its proposal ID and policy payment, and checks receipt events, historical
vault/caller balances, reservations, resolution, consumed holdings, approval,
allocation and journal signatures. It runs without a key. The fork calls the same
read-only verifier before saving its report; a future completed live run produces
`output/live-dao-funded-redemption-verification.json`.

The user approved the exact plan and its spending limits on 2026-10-02. The
Polygon mainnet test completed in 42 successful transactions. Total network
fees were 7.049967171939237358 POL, below the 13.918804906001340892 POL limit.
The vault received 0.1 pUSD and reimbursed Main 0.196211976206520912 POL under
the voted policy. The redemption transaction's actual fee was
0.172446449153581240 POL; the refund uses measured gross gas plus the approved
100,000-unit overhead, so it differs from the receipt fee.

Cleanup returned 0.1 pUSD to the original Safe and 0.403788023793479088 POL to
Main. Together with the refund, all 0.6 POL temporary funding returned to Main.
The new vault holds zero pUSD and zero POL. Main's balance decreased from
26.463946871231216692 to 19.413979716391979334 POL, a net decrease of
7.049967154839237358 POL. This is 0.0000000171 POL less than the sum of receipt
fees; the balance snapshots do not identify the source of that small adjustment.
The reported network cost uses the sum of confirmed receipt fees.
All 13 deployment, 12 execution and five preservation checks passed. The
independent verifier passed 16 historical-state checks and four journal checks
at 55 redemption confirmations. Evidence is in
`output/live-dao-funded-redemption.json` and
`output/live-dao-funded-redemption-verification.json`.

Redemption: `0xd03c14648d255654397e5979484a95b18f10d580bef15939a263bbe3000d72cd`.
Cleanup: `0xb9d2e80b496bc2b6a776e3aba629196af7abeaea819477163863ce4cabe7dffb`.
Governor: `0x2C6eAd1B4983FEDd8a9F2eCbD3f3256D5916e0Db`.
Vault: `0x418D9D09A8A5D2aCfcB669CDf78431e071B445A4`.
Timelock: `0x4449eF997bAad1A3DAFe1CfbC1993E1704248eB2`.

The historical 0.1 pUSD in vault `0x1B3C…6968` remains untouched, DAO 2 retains
zero recovered shares, and its original Safe holds those five shares. The old
immutable vaults keep their original permissionless redemption or absent method;
this work changes new deployments. Historical live and relayer journals remain
unchanged. The paper, Overleaf, diagrams and Worker source remain unchanged.
