# Current DAO execution

The DAO defines the mapping from Polymarket classifications to its expertise
topics and certified skills. `scripts/topic-policy.ts` selects a topic from
category/subcategory or substantive tags, applies explicit DAO overrides,
and records source and policy hashes. Country and display tags alone do not
select expertise. Equal-priority conflicts require a DAO decision.

`DaoSkillCalculator` stores the catalog and relevance matrix selected at
deployment. `DaoGovernanceSkill` retains issuer verification, member-bound
DIDs, bitmap merging and per-topic checkpoints from the inherited implementation.
The original eight skill identifiers keep their bit positions in the example
catalog. A DAO can deploy a different catalog; it is fixed for that deployment.

`MarketRegistry` admits each market through the Timelock and fixes its condition,
outcomes, expertise topic and cutoff. Voting uses stake plus the credential
score for that topic at the proposal snapshot.

An approved `authorizeBuy` reserves pUSD and opens the auction. The solver can
be a DAO member or the proposer. The solver uses their own wallet and capital
for the CLOB purchase. Exact ERC1155 delivery to the vault triggers payment in
the same call. Audit references identify the order and settlement; receipt of
the approved shares determines payment. Open fulfillment permits any solver;
the experiment demonstrates a member acting as the solver.

If delivery does not occur, no purchase payment occurs. After the deadline,
the existing public `expire()` call releases the reservation. There is no
penalty or automatic replacement purchase.

Polymarket operates order settlement, relaying and oracle resolution. These
are external platform services. The DAO uses the resolved payout as an input
to redemption. A successful market-bound Governor proposal and Timelock call
redeem the vault's position through the fixed adapter. pUSD stays in DAO custody.
The Execution Caller calls Governor.queue and, after the delay, Governor.execute.
Each transaction reimburses its own immediate caller under the voted POL caps;
the callers may differ. Both payments consume the shared allocation. A successful
queue payment remains earned if execution later fails or is cancelled.
See [the redemption implementation](docs/dao-funded-redemption-2026-10-02.md)
and [the updated measurements](output/queue-reimbursement/results.md).

Deployment and member activation are setup costs. Governance, delivery and
redemption receipts are operation costs. Principal, auction payment, payout
and caller reimbursement are recorded separately from network fees. Internal
calls in a transaction share that transaction's network fee.
