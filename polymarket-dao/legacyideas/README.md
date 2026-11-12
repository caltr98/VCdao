# Prestifilippo × Polymarket

A runnable mini-project where Polymarket markets are governance topics and
members use Prestifilippo's stake-plus-expertise voting to approve purchases.
The current live route executes a purchase decision through a Timelock, opens a
Dutch auction, and pays a solver only when the approved outcome shares reach
the DAO vault. New deployments support Timelock-approved on-chain redemption:
Anyone can execute an approved market proposal after the delay and genuine
resolution. pUSD returns directly to the vault, and a voted treasury POL
allocation reimburses the execution caller within explicit limits. See
[the DAO-funded redemption design and rehearsal](docs/dao-funded-redemption-2026-10-02.md).

**Push delivery and vault redemption have both been verified live on Polygon.**
The new governed reimbursement implementation is verified locally and on a
Polygon fork; its new paid mainnet test awaits approval.
The current route and earlier rejected approaches are recorded in
[the handoff](docs/handoff-codex-2026-10-02.md). The
[redemption report](docs/redemption-live-2026-10-02.md) links the real transaction,
balance checks and test limitations. The contract-order and Safe sections below
describe earlier experiments. See [VALIDATION.md](VALIDATION.md) for what each
check establishes.

## Run

```powershell
cd D:/DAOPrestifilippo/polymarket-dao
npm ci
npm test
npm run demo
```

Use Node.js 22 or newer for the inherited Hardhat toolchain. The demo uses
Hardhat with mock collateral, outcome tokens and an exchange model. It needs
no keys, RPC service or real funds.

It registers two fictional markets, creates two members, issues a signed
blockchain expertise credential and votes on an order. An unrelated account
calls the automation contract to queue and execute it. The mock exchange fills
100 shares for 50 collateral plus 1 fee. A public collection call returns the
position and 1 unused collateral to the DAO. The treasury ends with 949 of its
original 1,000 mock collateral; the order wallet's balance and exchange allowance
end at zero. The caller receives no treasury payment.

The script simulates an automation service sending transactions. It does not
register a hosted service or send an HTTP order. Its one-block voting delay,
30-block voting period and ten-second Timelock are demonstration settings.

## Approved contract order

| Field | Meaning |
| --- | --- |
| `market` | `uint256(conditionId)`; the proposal's market topic |
| `tokenId` | Specific outcome token from that registered market |
| `principal` | Maximum order principal, in six-decimal collateral units |
| `shares` | Outcome quantity at that principal; defines the limit price |
| `feeBudget` | Additional collateral exposed to the configured exchange |
| `deadline` | End of live signature authorization; cleanup must revoke cached spending |
| `exchange` | One of two exchange addresses fixed at vault deployment |
| intent ID | Unique identifier shared across contract and delivery routes |

For principal 50, shares 100 and fee budget 2, the price limit is 0.50 per share
and the wallet receives at most 52 collateral. Each intent gets a separate
wallet with one exact V2 order digest. The wallet is both maker and signer,
using `POLY_1271`. Its public `0x01` signature marker requests contract validation;
the transport needs no treasury signing key.

The wallet caps total spending through its balance and allowance. The exchange
enforces price, cumulative fills and fee accounting. Partial fills are possible
at contract level. Collection after a full position or expiry returns actual
shares and remaining collateral to the immutable DAO recipient. A balance
threshold is not historical proof of a Polymarket fill.

## Automatic triggering

`GovernanceAutomation.checker(targets, values, calldatas, descriptionHash)`
returns readiness and calldata for `advance` on the automation contract:

1. A succeeded proposal is queued through the Governor.
2. A queued proposal is executed after its Timelock delay.
3. Execution creates and funds its `OrderWallet`, emitting `ContractOrderAuthorized`.

An external automation service can evaluate this checker repeatedly and send
the transaction when ready. `advance` rechecks the state. The service receives
no Governor role, treasury allowance or discretionary trading key. Readiness
covers governance timing; a service must also simulate execution and report
failures such as insufficient funds or an expired purchase deadline.

After wallet creation, `collectionChecker(wallet)` returns readiness and calldata
for **the wallet's** `collect()` function. Its execution target is the wallet,
not the automation contract. Keep cleanup active through expiry even if
submission fails. Anyone can send these transactions if the service stops.

Contracts require incoming transactions. A hosted service supplies the trigger
and needs gas funding; CLOB transport supplies the separate HTTP request. The
Worker below provides both, within the limits described there.

## Hosted automation

`automation/` is a Cloudflare Worker with a one-minute cron and one SQLite-backed
Durable Object per configured vault. Each run performs these stages in order:

1. Reconcile the pending transaction: settle its actual fee after 32
   confirmations, resend bytes the RPC lost, and reprice a transaction the node
   refused or one priced below current fees. If repricing a governance
   transaction would spend the cleanup reserve, it is cancelled with a
   same-nonce self-transfer instead.
2. Discover `ProposalCreated` and `ContractOrderAuthorized` events at 32
   confirmations. A changed confirmed block triggers a rescan.
3. Collect every known wallet whose position arrived or whose deadline passed.
4. Queue or execute ready proposals through `GovernanceAutomation.advance`.
5. Reconcile posted orders by digest, then post at most one new exact order.

The stages fail independently. A discovery or RPC error, or a proposal whose
execution would revert, is reported without stopping the cleanup of wallets
that are already known. One gas signer sends one transaction at a time. A
refused or unrepriceable transaction is reported as an issue, and no new order
is posted while it holds the nonce.

| Variable or secret | Effect |
| --- | --- |
| `DAO_CONFIG` | JSON with `governor`, `vault`, `automation`, `startBlock` and `confirmations` (at least 32); the deployment manifest prints it |
| `EXECUTION_ENABLED` | `"true"` lets the Worker broadcast; otherwise it only reports ready work and never rebroadcasts stored bytes |
| `ORDER_SUBMISSION_ENABLED` | `"true"` enables CLOB posting; it also requires execution, so cleanup stays funded |
| `MAX_TOTAL_GAS_WEI` | Cap on confirmed spending plus the pending worst case |
| `GAS_PRIVATE_KEY` | Secret. Pays gas for permissionless calls; holds no DAO authority |
| `CLOB_CREDENTIALS` | Secret. JSON with `address`, `key`, `secret` and `passphrase` |

Before a post, the Worker checks the digest at the configured exchange and the
live book: outcome, exchange type, tick, minimum size, principal and shares with
at most two decimals, and a price within [tick, 1 - tick]. It also calls the exchange's own `validateOrder`
and requires gas for one more cleanup. It persists the attempt, posts once and
classifies the response as the official SDK does. Uncertain posts stay
`unknown` and are never resubmitted automatically. Later runs record the CLOB's
record and the exchange's onchain `orderStatus` for each posted digest.
Authenticated requests go only to the fixed CLOB host and do not follow
redirects. Public `GET /health` returns the latest report: addresses, digests,
codes and revert reasons, never keys, credentials or the RPC URL.

```powershell
cd automation
npm ci
npm run check
npm test
npm run build
```

`npm run deploy` performs an actual Cloudflare deployment and has not been run.
Deploying with an empty `DAO_CONFIG` only publishes `needs-deployment-config`.

## Deployment

`scripts/deployment.ts` deploys the reused Prestifilippo contracts and the
market contracts from an explicit plan: Timelock delay, voting delay and period
in blocks, skill weight, trusted credential issuer and at least one bootstrap
market. Every proposal needs a registered topic, including one that registers a
further market. The Timelock starts with zero delay so the deployer can register
the bootstrap markets. The final delay is then applied through the Timelock
itself, the Governor receives the proposer and canceller roles, and every
deployer role is revoked. The local demo, the tests and the Polygon script share
this sequence.

```powershell
npm run deploy:rehearsal                    # Polygon fork; sends nothing
$env:DEPLOYMENT_PLAN = "path/to/plan.json"
npm run deploy:polygon                      # live; not run
```

The rehearsal writes `output/deployment-rehearsal.json` with the addresses,
start block, post-deployment checks and the Worker's `DAO_CONFIG`. A live run
needs `POLYGON_RPC_URL`, `DEPLOYER_PRIVATE_KEY` and `CONFIRM_POLYGON_DEPLOYER`
set to the deployer address. It refuses the example's placeholder issuer and
market, and it never overwrites a live manifest. `examples/deployment.json`
holds illustrative values to review, not recommended settings.

## Polygon fork rehearsal

```powershell
npm run check:fork       # exchange digest, ERC1271 signature and cancellation
npm run check:fork-e2e   # the complete primary route on a fork
npm run check:fork-safe  # Safe route: guard, revocation, redeem (see DESIGN.md)
npm run check:fork-mandate  # Safe mandate handler: probe, DAO vote, attacks, redeem
```

`check:fork-e2e` forks the latest Polygon block and chooses a live binary
market from Gamma. It deploys the DAO against the real pUSD, CTF and exchanges
and passes a proposal through the stake-plus-expertise vote. The Worker's runner
then queues and executes it with the production Polygon profile. The runner
checks the order against the market's public book and posts it to a local
stand-in for the CLOB. An impersonated exchange operator then settles the
order against a complementary buyer with the deployed V2 `matchOrders`. The
receipt verifier checks the fill, and the runner collects the position into the
treasury. The run also reproduces the cached-approval window on the deployed
bytecode. Order submission and API authentication are simulated; the DAO, its
transactions and the match exist only on the local fork.

## Market and proposal tools

```powershell
npm run market
npm run proposal -- examples/contract-buy.json
```

Replace the example's fictional market, outcome, deployment addresses and
deadline. Discovery reads public Gamma data; governance admits the mapping
and expertise domain. The proposal tool prints unsigned propose/vote/queue/
execute calls and automation checker/advance calldata. It sends no transactions.

For an already deployed Polygon order wallet:

```powershell
# Set POLYGON_RPC_URL in the environment first.
npm run contract-order -- VAULT_ADDRESS AUTHORIZATION_ID
```

This read-only tool checks chain, assets, treasury, exchange, state and deadline,
reads the exact order, compares its digest with the exchange and calls the
exchange's signature validator through `eth_call`. It prints the protocol
order with integers as decimal strings. It sends no API request and cannot
establish CLOB admission. The live command has not been exercised against a
deployed DAO wallet.

## Delivery fallback

The earlier route remains available: an executor fronts the purchase and
receives a fixed payment after delivering the exact position. Its SDK helper
and historical-receipt verifier are documented in [DELIVERY.md](DELIVERY.md).

```powershell
npm run demo:delivery
npm run proposal -- examples/buy.json
```

The Python helper and `npm run verify` belong to this fallback. They do not
submit or verify the primary contract-wallet workflow.

## Files and checks

| File | Responsibility |
| --- | --- |
| `contracts/prestifilippo/` | Pinned membership, credentials, skills and Governor |
| `contracts/MarketRegistry.sol` | Immutable market/outcome/expertise mapping |
| `contracts/MarketGovernor.sol` | Topic binding and permitted governance actions |
| `contracts/OrderVault.sol` | Creates and funds approved wallets; retains fallback |
| `contracts/OrderWallet.sol` | Exact-order authorization, allowance and DAO recovery |
| `contracts/GovernanceAutomation.sol` | Public governance trigger and collection checker |
| `scripts/deployment.ts`, `deploy.ts` | Explicit-plan deployment, verification and manifest |
| `scripts/contract-demo.ts` | Local contract-wallet demonstration |
| `scripts/contract-order.ts` | Read-only protocol order export and signature check |
| `scripts/fork-check.ts`, `fork-e2e.ts` | Polygon-fork signature check and primary-route rehearsal |
| `automation/src/runner.ts` | Worker stages, cleanup reserve and order reconciliation |
| `automation/src/chain.ts` | Deployment checks, discovery and the gas-signer transaction lifecycle |
| `automation/src/transport.ts` | CLOB HTTP: exact body, HMAC, response classes and book checks |
| `automation/src/index.ts` | Durable Object, cron handler and public status endpoint |
| `DESIGN.md` | Execution choices and live integration boundary |
| `UPSTREAM.md` | Source revision and exact upstream adaptation |

```powershell
npm test
npm run typecheck
npm run demo
npm run demo:delivery
python -m unittest discover -s test -p "test_*.py" -v
cd automation; npm run check; npm test; npm run build
```

See [VALIDATION.md](VALIDATION.md) for results. BUY acquisition, cancellation,
expiry, collection and governed transfers are implemented. Automatic SELL/
redemption, a web UI and new expertise domains are outside this mini-project.
