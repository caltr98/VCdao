# Validation record — 2026-09-27

Results below were observed on 2026-09-27 on the final files. Fork runs read
Polygon through the public RPC and executed on an in-process Hardhat fork;
nothing was sent to Polygon, Cloudflare or an authenticated Polymarket API.

## Local checks

| Check | Result |
| --- | --- |
| `npm run compile` | Solidity 0.8.28, Cancun target |
| `npm run typecheck` | Passed; includes the Worker modules imported by tests and scripts |
| `npm test` | 62 passing |
| `npm run demo` | DAO received 100 mock shares for 50 principal + 1 fee; 1 unused collateral returned; treasury 949 of 1,000; wallet balance, allowance and caller payment 0 |
| `npm run demo:delivery` | Vault received 100 mock shares, executor received 55 mock pUSD, reserved balance 0 |
| Python executor tests | 9 passing |
| `automation`: `npm run check` | Passed |
| `automation`: `npm test` | 6 passing in the Workers runtime (workerd 1.20260925.1) |
| `automation`: `npm run build` | Dry-run bundle 995 KiB (238 KiB gzip), down from 1,120 KiB after removing a second ethers copy |
| `npm audit --omit=dev` | 0 production findings in both packages |
| Full audit, root | 48 findings in the inherited Hardhat toolchain (13 low, 9 moderate, 25 high, 1 critical); the Worker package has none |

The Hardhat suite exercises the reused Governor, membership token, credential
verification and skill calculator. Local collateral, positions and exchanges
are mocks; the mock exchange follows V2's digest, `validateOrder`, per-digest
`orderStatus` packing, operator-only fills and approval cache.

The Worker tests cover these behaviors:

- Transport: exact salt serialization and HMAC over the posted bytes; persist
  before POST; a single attempt per digest; SDK-aligned acceptance, rejection
  and unknown classes; credential values redacted from diagnostics; order reads
  by digest without following redirects; book checks for tick, minimum size,
  two-decimal principal and shares, and price range.
- Transactions: the worst-case reservation and the actual fee settled after 32
  confirmations; a mined revert counted against its label with its fee; no
  broadcast or rebroadcast while execution is disabled; same-nonce replacement
  of an underpriced transaction and of one the node refused; a governance
  transaction cancelled when repricing it would spend the cleanup reserve;
  release of a nonce used by another sender.
- Discovery: confirmation delay, and a rescan without duplicates after a
  changed confirmed block.
- Configured runner on Hardhat: discovery, queue, execute, one simulated post,
  reconciliation, collection and final balances. Read-only mode reports ready
  work and sends nothing. Cleanup continues while log discovery fails, and a
  failing proposal is skipped for the next ready one. A cap one wei short of a
  governance transaction plus one cleanup reservation blocks it, while the same
  cap without a posted order lets it through. A step that reverted twice waits
  for review without blocking the next step. A post is refused when the budget
  could not pay for cleanup. A refused broadcast is reported as a stalled signer
  and stops new posts. No report contains the gas key or CLOB credentials.
- Workers runtime: the scheduled handler and status endpoint; one tick at a time
  while an earlier tick is held open; HMAC equal to the
  official SDK's `build_hmac_signature` for a URL-safe secret; a provider without
  ethers' external gas-station plugin. A fully configured runner with an
  unreachable RPC fails at deployment validation, saves no state and reports no
  key, secret or key-bearing RPC URL.

An independent review of the Worker code on 2026-09-27 reported ten findings.
The most serious was a refused broadcast that could hold the nonce and block
cleanup indefinitely. The others covered the cleanup reserve, pending-record
release, the FOK amount rule, revert labels, response classes, redirects and
test coverage. Each finding is fixed and covered by a test listed above.

The unreachable-RPC runtime test logs `Network connection lost` as an uncaught
promise. A caught, plain `fetch` to a closed port logs the same line in local
workerd, so the message comes from the runtime rather than the Worker's code.

## Polygon fork evidence

| Run | Block | Result |
| --- | --- | --- |
| `npm run check:fork` | 94,506,940 | Both deployed exchanges accepted the wallet's exact signature and rejected an altered order and the cancelled order; allowance 0 after cancellation |
| `npm run deploy:rehearsal` | 94,508,821 | Deployment from `examples/deployment.json` against the real pUSD, CTF and exchanges; all 10 post-deployment checks passed (also at 94,506,601) |
| `npm run check:fork-e2e` | 94,508,669 | Complete primary route on the final code; details below and in `output/fork-e2e.json`. Earlier runs at 94,506,836 and 94,507,253 gave the same figures |

The end-to-end rehearsal chose "Will the U.S. invade Iran before 2027?"
(standard exchange; public book tick 0.01, minimum size 5). The DAO voted to
buy 10 "Yes" shares at a 0.50 limit with 5 pUSD principal and a 0.10 pUSD fee
budget. The Worker's runner, using the production Polygon profile, queued and
executed the proposal. It then validated the order against the live public
book and the deployed exchange's `validateOrder`, and posted it to a local
stand-in. The stand-in recomputed the digest from the posted JSON with the
deployed `hashOrder`. An impersonated operator settled the order through V2
`matchOrders` as a MINT against a complementary "No" buyer:

- The receipt verifier found one fill of the wallet's digest: 10 shares
  received and 5.05 pUSD spent, including a 1% fee, within the 5.10 budget. A
  fee one unit above the budget reverted.
- The runner read `orderStatus` as filled and collected. The treasury received
  the 10 real CTF shares and the 0.05 pUSD refund; the wallet's allowance ended
  at 0. That first collection estimated 129,012 gas and used 109,361, within
  the Worker's 200,000-gas cleanup bound.
- The deployed standard exchange reports `getMaxFeeRate() = 0`, which V2 treats
  as no fee limit. The wallet budget is the only fee bound.
- Cached window: after a second wallet's deadline, the live signature returned
  `0xffffffff` and `validateOrder` rejected the order. An operator-preapproved
  copy with an empty signature still filled half of the order. After collection
  (state Expired, allowance 0), the next cached fill reverted.

These fork runs establish compatibility with the deployed contracts. They do
not establish CLOB admission for the custom wallet, the operator's offchain
matching policy, or any mainnet transaction. The operator was impersonated, and
the counterparty was a local key funded from an impersonated pUSD holder.

## Not verified

- Authenticated CLOB admission of the custom order wallet: no request with real
  credentials has been sent, and no wallet or credentials were provided.
- Any Polygon deployment, funded gas signer or real order; any Cloudflare
  deployment or cron registration. `npm run deploy` in `automation` has not run.
- The Durable Object's configured flow against a reachable RPC in the Workers
  runtime. The same runner code ran configured in Node, locally and on the fork.
- The historical-receipt CLI (`npm run verify`) against real receipts; its log
  validation ran on the fork receipt through `verifyPurchaseLogs`.
- A smart-contract security review.

The upstream `VCdao` working tree, the paper, the thesis and the betting
strategies were not edited. Earlier notes still apply: the Solidity build
needs Cancun for the inherited OpenZeppelin version, and a typed field helper
(`scripts/order.ts`) replaces ethers' `toObject()` for TypeChain tuples.

## Re-run after the SDK-alignment fix — 2026-09-27

The order salt is now the top 53 bits of the intent ID and the posted body
includes `postOnly: false`. On the changed files: 62 Hardhat tests and 6
Workers-runtime tests passing, Worker build 994.80 KiB (237.74 KiB gzip),
`npm run check:fork` passing at block 94,531,148, and `npm run check:fork-e2e`
passing at block 94,531,316 ("Will the US confirm that aliens exist before
2027?"): the deployed exchange recomputed the digest from the posted JSON, 10
shares received for 5.05 pUSD, a fee above the budget rejected, 10 shares
collected to the treasury, allowance 0, and the cached fill after collection
rejected.

## Safe route on a Polygon fork — 2026-10-01

`npm run check:fork-safe` (`scripts/fork-safe.ts`, report in
`output/fork-safe.json`) ran at block 94,776,731 on "nfl-pit-cle-2026-10-02"
through an Alchemy RPC (`POLYGON_RPC_URL`; the public node had pruned state).
In-process fork only: nothing was sent to Polygon or to an authenticated API.

- A Polymarket factory Safe (`0xaacF…541b`, Safe 1.3.0) was created from a
  fresh trading EOA's `CreateProxy` signature. The EOA enabled two modules (a
  Timelock stand-in and `SafeSweeper`), approved pUSD to the V2 exchange, set
  `SafeReceiverHandler` as fallback handler and `SafeTraderGuard` as guard.
- An approved BUY (maker = Safe, signer = EOA, signature type 2) was matched by
  the real operator: 10 shares for 5 pUSD. A type-2 order with a maker that is
  not the signer's factory Safe, and the Safe as maker under type 0, both
  reverted with `InvalidSignature` (`0x8baa579f`).
- Guard: the owner's pUSD transfer, approval to itself, share transfer, guard
  removal, module removal, owner addition and fallback-handler change all
  reverted with `OwnerTransactionNotAllowed`; the exchange approval passed. The
  Safe answers no `isValidSignature`.
- Residual trust, observed: an unapproved order (the other outcome) signed by
  the EOA filled. After the Timelock swapped the EOA out as owner, an EOA-signed
  order still filled — the exchange checks the factory address derivation, not
  current ownership. After the Timelock zeroed the exchange allowance, the next
  order reverted. Revocation is the allowance (or a sweep), not the owner set.
- Removing the fallback handler entirely made every fill revert: the Safe must
  answer `onERC1155Received`.
- CTF positions are USDC.e positions (`getPositionId(USDC.e, …)` equals the
  CLOB token ID), not pUSD. With the oracle (`0x6507…f2A7`, reproducing the
  conditionId with the Gamma questionID) impersonated to report [1, 0],
  `SafeSweeper.redeem` reverted before resolution and, after it, an
  unprivileged caller redeemed 20 YES + 10 NO into 20 USDC.e at the treasury;
  the unspent 5 pUSD stayed in the Safe.
- 65 Hardhat tests passing (3 new `SafeTraderGuard` unit tests).

Not verified: CLOB admission of a Safe order. Polymarket's geoblock answered
`blocked: true, country: IT` for this machine, so a posted order would only
show the geoblock. Neg-risk redemption is not implemented.

### Live CLOB admission of a Safe order — 2026-10-01

From Greece (geoblock `blocked: false, country: GR`), with the user's throwaway
EOA `0x4b1f…1589` and its existing Polymarket factory Safe `0x7a46…5Ddb`
(14.05 pUSD; V2 exchange allowance already max). Through
`polymarket-client` 0.11.0 (`create_limit_order` + `post_order`, no allowance
recovery): a post-only GTC BUY of 5 "Aurora" shares at 0.01 on
`dota2-aur1-liquid-2026-10-01-game1` (best bid 0.26), maker = Safe, signer =
EOA, signature type 2. The CLOB answered `ok: true, status: live` (order
`0x727c…54ba`), nothing matched, and the cancel returned `CANCELED` with
`size_matched: 0`. The API key is the EOA's derived L1 key, so a Safe with a
DAO guard and modules is admitted the same way; the CLOB does not see them.

## Safe mandate handler on a Polygon fork — 2026-10-01

`npm run check:fork-mandate` (`scripts/fork-mandate.ts`, report in
`output/fork-mandate.json`) ran at block 94,778,370 on
"dota2-aur1-liquid-2026-10-01-game1" through an Alchemy RPC. In-process fork
only; order posts were simulated by handing the signed order to the forked
operator. The exchange source (`0xE111…996B`) is a full Sourcify match.

Probe (`ProbeReceiverHandler` as the Safe's fallback handler, guard set):

- MINT, Safe as taker BUY, half fill with a 0.05 taker fee: at the hook the
  Safe had already paid 2.55 pUSD (fill + fee). `operator = from = exchange`.
- MINT, the same order as maker BUY, other half with a 0.05 maker fee: 2.55
  pUSD already paid at the hook. `operator = from = exchange`.
- Complementary, Safe taker BUY against a resting SELL of the same token: 0
  pUSD paid at the hook; the 5 pUSD left after. `from` = the seller.
- The CTF credits the shares before the hook; no batch hook occurred. The
  exchange has only `matchOrders` and never calls its batch transfer helper.

Mandate (DAO deployed with `deployDao`; two members joined and voted; the
Timelock executed one proposal: `withdrawCollateral(safe, 20.2)` and
`setMandate(safe, market, YES, 0.50, 20, 0.20, +1 day)`; the Safe was guarded,
with the DAO Timelock and `SafeSweeper` as modules):

- Reverted: wrong outcome (`WrongToken`); YES at 0.60 (`PriceAboveLimit`);
  self-dealing MINT at 0.99 against the trader's second account
  (`PriceAboveLimit`); the second account selling YES directly at 0.99 and at
  0.50 (`NotExchangeSettlement`); the approved order with a fee above the cap
  (`PriceAboveLimit`); after two partial fills, a third fill at 0.60
  (`PriceAboveLimit`); after the deadline and after `clearMandate`
  (`NoActiveMandate`).
- Filled: the approved order (10 YES for 5 pUSD + 0.05 fee) and two partial
  fills of 2.5 pUSD each. The Safe held 20 YES and 10.15 pUSD; still no
  `isValidSignature`.
- `SafeSweeper.recover` reverted (`MandateActive`) before the deadline; after
  it, an unprivileged caller returned the unspent 10.15 pUSD to the vault.
- Release by vote: while guarded, the owner's handler change reverted
  (`OwnerTransactionNotAllowed`) and a direct `releaseSafe` call reverted
  (`OnlyTimelock`); after a second proposal executed `releaseSafe`, the guard
  was zero and the same handler change passed.
- After resolution [1, 0], an unprivileged caller redeemed 20 YES into
  20 USDC.e at the vault.

Also run: `npm test` (73 passing, 8 new in `test/safe-mandate.ts`),
`npm run typecheck`, `npm run check:fork-safe` (unchanged results after the
helpers moved to `scripts/safe-fork.ts`) and `npm run check:fork-e2e` (all
deployment checks, including the new `mandateHandler`, pass).

## Live Safe mandate run on Polygon — 2026-10-01

`scripts/live-mandate.ts --network polygon` (state in `output/live-mandate.json`),
from Greece, paid by the user's throwaway EOA `0x4b1f…1589` (an EIP-7702
delegated account: one transaction in flight at a time). Rehearsed first on a
fork with the same script. Live result: DAO deployed (governor `0xD2fe…48b2`,
handler `0x2c59…e6F2`, vault `0x5D51…A6C8`), the EOA joined, voted and the
Timelock executed one proposal funding a fresh guarded factory Safe
`0x8c76…0548` (trading EOA `0xDc93…629d`, derived from the deployer key) with
0.05 pUSD and setting the mandate (YES on `mlb-phi-atl-2026-10-01`, limit 0.01,
budget 0.05, fee cap 0, 3 days). About 3.2 POL of gas.

Posting (`scripts/post-safe-order.py`, geoblock `blocked: false`): the CLOB
refused the post-only BUY with "maker address not allowed, please use the
deposit wallet flow". The CLOB admitted the pre-existing Safe `0x7a46…5Ddb`
earlier the same day, so it appears to admit only Safes it already knows;
new accounts must use Polymarket's deposit wallet. Nothing was filled.

## Vault redemption on Polygon — 2026-10-02

`RedeemableOrderVault.redeem(market)` was exercised on the real standard adapter
with real tokens on an already resolved market. The isolated vault received
0.1 pUSD, both 0.1-share outcome balances were burned, the external caller's
pUSD balance stayed zero, and adapter approval was cleared. The receipt was
independently verified with historical balances and 118 confirmations at block
94818199. The test used a complete-set split, not a CLOB purchase or simulated
mainnet resolution. Its zero-delay Timelock fixture did not exercise Governor
voting; full DAO wiring and role handover are covered by the deployment test.

The principal was then returned to the original Safe through the fixture
Timelock. The Safe ended with 9.05 pUSD, the test vault with zero, and the
original DAO 2 position remained 5 shares plus 0.733374 pUSD. Total gas was
2.312648081578601290 POL. Source, addresses, transactions, exact commands and
public journals are described in
[the redemption report](docs/redemption-live-2026-10-02.md).

## DAO-funded, governed redemption — 2026-10-02

The new Timelock-only redemption and Governor reimbursement implementation passes
89 affected Hardhat tests, four isolated signed-byte journal tests, TypeScript
checking, both local demos and nine Python tests. Worker type checking, six
runtime tests and a dry-run build also pass without source changes or deployment;
the runtime test process emitted a `Network connection lost` diagnostic while
reporting all six tests passed.

`npm run check:fork-redemption` passes against Polygon block **94,827,543**. It
deploys the complete DAO, hands over roles, votes on a 0.5 POL allocation, acquires
real complete-set positions on the pre-existing resolved condition, votes and
queues redemption, waits for the Timelock, and executes through the Governor.
The fixed adapter paid exactly **0.1 pUSD** into the vault and consumed both
outcomes. The execution caller received **0.155601836219928996 POL**, within the
voted gross-gas-plus-overhead policy. Allocation and native balances decreased by
exactly that amount, approval was false and reservations remained unchanged.

All 13 deployment, 12 execution and five asset-preservation checks pass, as do
16 independent receipt/historical-state checks and four journal checks. The
entire saved scenario also resumes with **no nonce increase and no new broadcast**.
Only the Main EOA is impersonated locally; no oracle result, CTF balance or
contract storage is injected. Cleanup returns the principal and unused native
funds. Existing DAO 2/Safe assets and the historical fixture's 0.1 pUSD are preserved.

At the fixed snapshot gas price of **278.395338579 gwei**, all 42 transactions use
24,296,433 gas and cost **6.764013691296988707 POL**. Summed buffered gas limits
are 30,300,936. With the proposed **417.593007868 gwei** ceiling, worst-case
network fees are 12.653459005455764448 POL; the proposed total network-fee limit,
including 10% additional room, is **13.918804906001340892 POL**. Temporary native
funding is another 0.6 POL (0.1 membership and 0.5 treasury allocation), with
0.1 pUSD recoverable principal from the original Safe.

The approved Polygon mainnet test subsequently completed on 2026-10-02 in 42
successful transactions. Network fees were 7.049967171939237358 POL. Redemption
paid 0.1 pUSD to the vault and reimbursed the caller 0.196211976206520912 POL.
Governed cleanup restored the Safe's 9.05 pUSD and returned the remaining
0.403788023793479088 POL to Main. All 30 scenario checks and all 20 independent
checks passed; redemption had 55 confirmations at independent verification.
The completed journal and verification are
`output/live-dao-funded-redemption.json` and
`output/live-dao-funded-redemption-verification.json`. Do not repeat this test.
The exact plan and artifact hashes are in
`output/dao-funded-redemption-live-plan.json`, the complete evidence in
`output/fork-dao-funded-redemption.json`, and the execution/accounting model in
[the implementation report](docs/dao-funded-redemption-2026-10-02.md).
