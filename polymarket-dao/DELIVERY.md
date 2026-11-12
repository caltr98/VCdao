# Optional delivery route

This is the retained fixed-price executor fallback. The primary contract-wallet route is in [README.md](README.md).

## Governance and fixed-price delivery

A runnable prototype in which a Polymarket market is a governance topic. Members
approve a concrete purchase using Prestifilippo's stake-plus-expertise voting.
The Timelock authorizes the purchase, and an executor delivers the approved
outcome tokens in exchange for the agreed treasury payment.

The local demonstration runs without keys, an RPC service or real funds. It
uses mock pUSD and outcome tokens. The accompanying tools discover real markets,
prepare unsigned governance calls, submit an explicitly requested order through
Polymarket's official SDK, and verify a settlement receipt. No live deployment
or real trade is included in the demonstration.

## Run the complete local example

Node.js 22 or newer is recommended for the inherited Hardhat 2 toolchain.

```powershell
cd D:/DAOPrestifilippo/polymarket-dao
npm ci
npm test
npm run demo:delivery
```

The demo deploys the contracts, registers two fictional market topics, creates
two members, issues a signed blockchain expertise credential, and runs a
proposal through voting and the Timelock. A local mint substitutes for a
Polymarket purchase. The executor transfers 100 mock YES shares to the vault
and receives 55 mock pUSD. The reservation returns to zero.

The demo's one-block voting delay, 30-block voting period and ten-second Timelock
are demonstration settings. They are not proposed settings for a funded DAO.

## What the purchase authorizes

| Field | Meaning |
| --- | --- |
| `market` | Polymarket `conditionId`, represented as a `uint256` topic |
| `tokenId` | The specific outcome token, bound to that registered market |
| `shares` | Exact quantity delivered to the DAO, in six-decimal base units |
| `payment` | Fixed total pUSD paid for delivery, in six-decimal base units |
| `deadline` | Latest delivery timestamp; bounded by the registered market cutoff |
| `executor` | Wallet that acquires and delivers the position and receives payment |
| authorization ID | Unique identifier that cannot be executed or reopened twice |

For example, “receive 100 YES shares for 55 pUSD” fixes the DAO's acquisition
price at 0.55 pUSD per share. The executor pays its own trading fees and gas and
keeps any difference between acquisition cost and the fixed quote. This is a
delivery contract, not reimbursement of an unverified expense claim.

## Real-market tools

Read public market metadata:

```powershell
npm run market
npm run market -- xi-jinping-out-before-2027
```

The output includes the condition ID, outcome labels and token IDs, trading
status, market URL and the V2 exchange address. Check outcome labels explicitly;
the UI's first outcome must not be assumed to mean YES. Governance registration
chooses the expertise domain and a conservative execution cutoff.

Prepare a proposal after replacing the fictional values in `examples/buy.json`:

```powershell
npm run compile
npm run proposal -- examples/buy.json
```

This prints the authorization ID, proposal ID and unsigned calls for proposing,
voting For or Against, queueing, and executing. Use the deployed Governor and
vault addresses. Submit each call from a wallet at the appropriate stage; the
contracts enforce the vote and Timelock. `scripts/local.ts` demonstrates the
deployment and role configuration. There is no mainnet deployment script.

For the executor, install the optional Python dependency:

```powershell
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt
```

Set `POLYGON_RPC_URL` in the executor's environment. Preview an already
authorized purchase by reading the actual vault state:

```powershell
./.venv/Scripts/python.exe scripts/execute.py VAULT_ADDRESS AUTHORIZATION_ID
```

The preview reads no private key. An operator can acquire the specified position
through Polymarket's interface or run the SDK path with `--submit` and an
explicitly configured `POLYMARKET_PRIVATE_KEY`. The SDK uses the authorized
executor wallet as the funder. That wallet must already be funded, supported
by Polymarket, and have trading approvals in place. EOA trading currently
requires allowlisting; existing supported Safe, Proxy or Deposit Wallet setups
have their own authentication requirements. The script does not deploy a wallet
or grant exchange allowances.

```powershell
# This command submits a real purchase from the executor's wallet.
./.venv/Scripts/python.exe scripts/execute.py VAULT_ADDRESS AUTHORIZATION_ID --submit
```

The script checks Polygon, the authorized action, the expected assets, current
book identity, tick size, minimum size and execution deadline. It uses a FOK BUY
with `max_spend` including fees and a price bounded by the DAO's quote. It checks
trading availability and rereads authorization after signing, immediately before
submission. The fixed payment is also the executor's purchase spending cap in
this helper. Fees, price rounding and liquidity can leave fewer net shares than
the delivery obligation. Before posting, the script rejects a signed order
requesting fewer shares than required or using the wrong wallet, outcome, side,
order type or excessive notional. Use `--max-price 0.50`, for example, to request
a lower limit within the approved quote and leave room for fees. Final net
delivery still requires receipt verification. There is no automatic top-up or retry.

An exclusive file under `output/` records the attempt before submission. After
a timeout or crash, reconcile that attempt with Polymarket before creating any
new attempt. `accepted` and `settlement_reported` in the journal are separate
from verified delivery. A delayed order may have no trades or transaction hashes
yet. The SDK settlement helper follows the fills listed in the response; later
updates require reconciliation using the recorded order ID.

## Verify the purchase and deliver the position

With the transaction that emitted `BuyAuthorized`, the settlement transaction,
and the order hash:

```powershell
npm run verify -- VAULT_ADDRESS AUTHORIZATION_ID AUTHORIZATION_TX SETTLEMENT_TX ORDER_HASH
```

The verifier checks successful canonical receipts with at least 32 confirmations,
ordering after authorization, the execution deadline, official V2 exchange event
emitter, order hash, buyer, BUY side, outcome ID, filled quantity, and net pUSD
and ERC1155 movement. It uses the configured RPC as its source of chain data;
32 confirmations are a policy threshold, not an independent consensus proof.
The initial verifier accepts one settlement transaction per authorization. Use
a dedicated executor wallet and one acquisition order per intent; do not combine
unrelated purchases in the same transaction.

For a still-authorized intent, it prints unsigned calls to:

1. Approve the vault to transfer the executor's ERC1155 tokens.
2. Call `fulfill(id, settlementTx, orderHash)` from the executor wallet.
3. Revoke the vault's ERC1155 approval after delivery.

A smart-contract executor wallet must submit these calls through its own wallet
execution mechanism. `fulfill` checks the deadline and executor, transfers the
exact shares, checks the balance increase, and pays the fixed quote atomically.
If transfer fails, both the payment and state changes revert. The position is
held by the DAO vault after success.

**The vault enforces delivery. The receipt verifier establishes historical
purchase evidence offchain.** The transaction and order hashes logged by the
vault are audit references; the contract does not read or validate historical
receipts. An executor can deliver existing inventory with a false reference;
the independent verifier must reject that reference. Venue-specific proof as a
mandatory payment condition would require an attestation or receipt-proof
component, as described in `DESIGN.md`.

## Files and scope

| File | Responsibility |
| --- | --- |
| `contracts/prestifilippo/` | Preserved membership, credential, skill and Governor logic |
| `contracts/MarketRegistry.sol` | Immutable market-to-outcomes and expertise-domain mapping |
| `contracts/MarketGovernor.sol` | Market topics and validation of allowed proposal actions |
| `contracts/BetVault.sol` | Reservations, delivery, payment, cancellation and expiry |
| `scripts/demo.ts` | Entire local governance and delivery example |
| `scripts/execute.py` | Read-only preview or explicit single SDK order attempt |
| `scripts/verify.ts` | RPC-backed purchase evidence and delivery calldata |
| `DESIGN.md` | Execution alternatives, trust boundaries and next experiments |
| `UPSTREAM.md` | Source revision and the exact upstream adaptation |

This version implements BUY acquisition, cancellation, expiry and governed
asset transfers. A governed transfer to another wallet is a custody action;
it does not itself prove a sale or redemption. Automatic SELL, redeem, strategy
selection, a web UI, V3/combinatorial markets and a continuous keeper are outside
this prototype. The four inherited technology expertise domains are retained
for the initial demonstration; adding sports or politics requires an explicit
credential and relevance model.

The original contracts retain their inherited membership and credential trust
assumptions. The Governor accepts direct calls to the vault's supported actions
and append-only market registration. It rejects arbitrary external targets and
nested Timelock calls. Treasury maintenance uses the proposal's declared market
electorate. Changing issuer policy or governance configuration would require an
explicit extension to this action policy.

## Checks

```powershell
npm test
npm run typecheck
npm run demo:delivery
python -m unittest discover -s test -p "test_*.py" -v
```

Tests cover credential-derived market votes and snapshots, successful and
defeated proposals, topic substitution, deployment role removal, reserve
accounting, cancellation, expiry, unauthorized and repeated fulfillment,
wrong assets and forged receipt events, and the order tool's spending limits
and no-retry behavior. See `VALIDATION.md` for the recorded results and limits.

