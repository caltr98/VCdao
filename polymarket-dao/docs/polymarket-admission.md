# Polymarket admission of DAO-controlled wallets

Findings from 2026-10-01, updated with the live Deposit Wallet implementation
and contract-owner fork investigation. Fork checks ran in-process on Polygon state. The live
run used the user's throwaway EOA, from Greece (geoblock `blocked: false`).
No keys appear in this file.

## Question

Can a DAO make a wallet that (a) Polymarket's order book (CLOB) admits as an
order maker and (b) enforces the voted order on-chain (token, price, budget,
deadline), so the trader cannot place a different bet?

## Short answer

A new Gnosis Safe can be created on Polygon. The three fresh factory Safes tested
here, including one created through the builder relayer, have not been admitted
by Polymarket's CLOB. The DAO mandate works on-chain;
admission remains the unresolved part of this Safe route. The current Deposit
Wallet implementation supports ERC-1271 contract owners. Ownership handover and
exact batch approval have passed a fork test against the deployed wallet. This
provides a current route to investigate without legacy Safe admission.

| Wallet | Enforces the voted order on-chain | Admitted by the CLOB |
|---|---|---|
| `OrderWallet` (ours, ERC-1271) | yes | no (deployed by us) |
| New Safe + `SafeTraderGuard` + `SafeMandateHandler` (ours) | yes (fork-tested) | **no** (tested live, 5 attempts) |
| New factory Safe, before installing any guard or modules | no mandate installed | **no** (direct-deployment control test) |
| New factory Safe created by Polymarket's builder relayer | no mandate installed | **no** (relayer-first control test) |
| Safe created before 2026-05-04 | yes, once guarded | yes in our test; mixed reports |
| Polymarket deposit wallet + EOA session key | **no** (session key is full power until expiry) | standard supported flow |
| Current deposit wallet + DAO ERC-1271 owner | contract ownership, exact batches and ERC-7739 order signatures verified on fork | after contract handover, not yet tested |

## 1. The mandate route works on-chain

`npm run check:fork-mandate` (`scripts/fork-mandate.ts`) ran on the deployed V2
exchange `0xE111…996B`, whose source is a full Sourcify match. The DAO voted one
proposal that funded a guarded factory Safe and called `setMandate`.

- Reverted: the wrong outcome, a worse price, self-dealing (through MINT and
  directly), a fee above the cap, a third partial fill above the limit, a fill
  after the deadline, a fill after `clearMandate`.
- Filled: the approved order, plus two partial fills within the terms.
- `SafeSweeper.recover` reverts before the deadline, then returns the unspent
  pUSD to the vault. `redeem` sends the winnings to the vault. Anyone can call
  either.
- `releaseSafe`, passed by a vote, removes the guard; nobody else can call it.

The handler refuses complementary fills, i.e. a BUY matched directly against
resting SELLs. The V2 exchange delivers tokens before payment on that path, so
a balance check could not price those fills.

## 2. Live run on Polygon

`scripts/live-mandate.ts --network polygon`; state in `output/live-mandate.json`.

| Item | Address |
|---|---|
| Governor | `0xD2feeCaD284d1EE895Ca728dd864c3E4763048b2` |
| Timelock | `0xBAe4e63a65E8819538564f9c3C6F7d01268D97Dd` |
| Vault | `0x5D5102D43de7CC209d34AaBfD2C546D93AA2A6C8` |
| Mandate handler | `0x2c59F4fAc2CF35315474e7D2880D5eeA03b7e6F2` |
| Sweeper | `0xdFf51A8164EDb0A8370320659E40971CF3D1a34B` |
| Trading EOA | `0xDc9311c53D3d1Cb1d9eD87B9028FB35c2168629d` |
| Guarded Safe | `0x8c76A13d1D4aEFDf5d04a94a6ec5c6A35D600548` |

The member joined and voted, and the Timelock executed the proposal (state 7).
The Safe held 0.05 pUSD under the mandate: YES on `mlb-phi-atl-2026-10-01`,
limit 0.01, budget 0.05, fee cap 0, a 3-day deadline. Gas: about 3.2 POL.

Posting a post-only BUY of 5 YES at 0.01 (`scripts/post-safe-order.py`, signature
type 2, maker = Safe, signer = trading EOA):

| Attempt | Change | CLOB answer |
|---|---|---|
| 1 | none | `maker address not allowed, please use the deposit wallet flow` |
| 2 | trading EOA logged in on polymarket.com | same |
| 3 | plus the relayer API key | same |
| 4 | plus `/balance-allowance/update` (COLLATERAL and CONDITIONAL, type 2); the server read balance 50000 and max allowance | same |
| 5 | retry at 21:26 UTC | same |

The server sees the Safe's funds and approval and still refuses the address as
maker. The same morning, from the same machine, the CLOB accepted (and then
cancelled) a post-only order from the user's pre-existing Safe `0x7a46…5Ddb`.

## 3. Current Deposit Wallets support contract owners

The earlier ECDSA-only conclusion used implementation
`0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB`. Reading the live beacon
`0x7A18EDfe055488A3128f01F563e5B479D92ffc3a` returned current implementation
`0xf7f27c29e60fe6325bef8da7f93250353d2e3294`. Its verified sources change the
conclusion:

- **Session-key scope is off-chain.** The wallet stores only
  `sessionSignerAuthorizedUntil`. `isValidSignature` checks just the expiry, so
  the `CLOB`/`ALL` scopes exist only on Polymarket's servers.
- **A session signer can sign arbitrary batches** through `execute`, including
  pUSD transfers. It is barred only from calling the wallet itself.
- **Owners can be contracts.** `SignatureVerifierLib.isValidSignatureNow`
  attempts ECDSA recovery and falls back to ERC-1271 for a deployed contract.
  `completeOwnershipHandover` uses this verifier for the pending owner.
- **Contract owners can authorize exact batches.** The fresh supported wallet
  `0x03360EEC0D055a915e5cBf075447Ef36C6B6Ffb6` was created with the SDK and builder
  credentials. On a Polygon fork, it accepted an ERC-1271 contract owner,
  rejected an unapproved batch, rejected a change from 50,000 to 50,001 units,
  executed the approved 50,000-unit allowance and rejected replay. The probe
  contract is a test harness, not a production governance controller.
- **Contract order signatures work on-chain.** The same fork accepted an
  ERC-7739 wrapped order signature from the contract owner, using the deployed
  exchange's `hashOrder`. Reusing that signature after changing the order
  principal from 50,000 to 50,001 returned the invalid-signature value. The
  assertions use nonzero gas price to select transaction-style validation;
  Solady's zero-gas-price RPC fallback deliberately burns gas on invalid
  simulations. This check validates signatures, not a matched settlement.
- **Polymarket controls it.** `factory.deploy` and `factory.proxy` are
  `onlyOperator`, and `execute` is `onlyFactory`. Upgrades go only to
  factory-authorized implementations.
- **The client** (`polymarket-client` 0.11.0) offers only the session-key scopes
  `ALL`, `CLOB` and `COMBOSRFQ`, with a fixed 180-day expiry.

The candidate architecture is a new supported Deposit Wallet whose owner is an
ERC-1271 mandate contract controlled by the DAO Timelock. The transport signer
does not receive a full-power session authorization. The controller approves
the exact ERC-7739 order digest and exact maintenance batches, including bounded
allowance and recovery to the DAO. The CLOB must still be tested after handover;
on-chain compatibility alone does not establish account admission.

Public evidence: `scripts/fork-deposit-owner.ts`, `output/deposit-owner-fork.json`,
and `output/current-deposit-wallet-sources.json`.
Source: [verified current implementation](https://sourcify.dev/server/v2/contract/137/0xf7f27c29e60fe6325bef8da7f93250353d2e3294?fields=sources).

### Live new-account order control

The fresh Deposit Wallet above posted a real signature-type-3 post-only BUY:
5 YES at 0.01 on `xi-jinping-out-before-2027`, principal 0.05 pUSD.
The CLOB accepted order
`0x24bfc8ff7a9e9c123fa2b55d725ab85a5daf49eaef00a0217286b85b5bbe8cc7`
as `live`. Cancellation succeeded; the subsequent order read returned
`CANCELED`, `size_matched: 0`, and no associated trades. Cleanup transaction
`0x837918e4a9b0923344dfd7b244aa405f110c1a957e3dbb149ee7382b0d2af264`
was confirmed and the wallet's subsequent pUSD balance was zero.

The relayer rejected an exchange approval of 50,000 units before submission:
its policy requires `MaxUint256`. The control therefore used the standard
maximum approval while exposing only the funded 0.05 pUSD. This is material
to production design: the fork's bounded approval is supported by wallet
bytecode, but the current relayer policy does not admit that approval batch.
The wallet still has maximum allowance after cleanup, with zero pUSD balance.

This proves new Deposit Wallet admission with its EOA owner. It does not yet
prove admission after handover to the DAO contract owner. Evidence is recorded
under `depositExecutor` in `output/relayer-safe-probe.json`; the posting script
is `scripts/post-deposit-probe.py`.

## 4. Public reports (GitHub, Polymarket SDK repositories)

- New makers refused with the same error:
  [#53](https://github.com/Polymarket/py-clob-client-v2/issues/53) (new EOA),
  [#61](https://github.com/Polymarket/py-clob-client-v2/issues/61) (new Safe, type 2),
  [#90](https://github.com/Polymarket/py-clob-client-v2/issues/90) (Safe deployed
  through Polymarket's builder relayer, type 2; its suggested fix is our setup),
  [#116](https://github.com/Polymarket/py-clob-client-v2/issues/116) (all types).
- The deposit wallet (type 3, ERC-7739 wrapped) works:
  [#111](https://github.com/Polymarket/py-clob-client-v2/issues/111).
- Pre-existing Safes, mixed reports. Refused:
  [#48](https://github.com/Polymarket/py-clob-client-v2/issues/48) and
  [#115](https://github.com/Polymarket/py-clob-client-v2/issues/115) (closed, no
  explanation). Working: comments in #48 and #53, and our own test.
- Polymarket docs: wallets deployed on or after 2026-05-04 use the deposit
  wallet type ([Deposit Wallets](https://docs.polymarket.com/trading/deposit-wallets),
  [Wallets and Authentication](https://docs.polymarket.com/trading/wallets-auth)).
- A third-party write-up, consistent with the source reading (the execute path
  is operator-gated):
  [polymarket-v2-starter](https://github.com/dcpf1/polymarket-v2-starter/blob/main/docs/deposit-wallet-flow.md).

## Claims the evidence supports

1. Settlement-time enforcement of a voted order works on Polymarket's deployed
   exchange, and anyone can reproduce it on a Polygon fork.
2. The CLOB refused all three fresh factory Safes tested here, including
   unguarded Safes created directly and through the builder relayer, with funds
   and exchange approval. The guarded Safe's balance
   and approval were also read successfully by the server. These tests do not
   establish the admission policy for every new maker.
3. An EOA session key alone does not impose the mandate. The current Deposit
   Wallet additionally supports ERC-1271 contract owners, which opens a DAO
   controller route. Factory execution remains operator-gated.
4. This project has not yet demonstrated a fresh DAO wallet with both CLOB
   admission and on-chain enforcement after contract ownership handover. The
   current contract-owner Deposit Wallet route is the next concrete candidate.

## Fresh unguarded Safe control test

At the user's request, `scripts/new-safe-probe.ts` created a second fresh Safe
through the same Polymarket factory on live Polygon. Safe:
`0x9a18082a17A41e2d7EBe1BA8A47d7AD56B35584b`; owner:
`0xB21edEd138b2f1d60E679709734fD0c976b0ec95`; threshold: 1. No DAO modules,
guard or custom fallback handler were installed. The Safe received 0.05 pUSD
and approved exactly 0.05 pUSD to the V2 exchange.

`scripts/post-new-safe-probe.py` made one post-only BUY attempt for 5 YES at
0.01 on the same market, using signature type 2 and the fresh owner as signer.
The geoblock check passed (`country: GR`). The CLOB returned
`maker address not allowed, please use the deposit wallet flow`.
No order was accepted. This control establishes that installing the DAO guard
and mandate handler was not necessary to produce the admission refusal.

Authentication was checked separately with `--auth-check`: the SDK classified
the explicit wallet as `GNOSIS_SAFE`, and an authenticated API-key listing for
the fresh signer contained the credentials used by the client. Credentials
were derived from the same private key that signed the order; the existing
personal account's API key was not supplied. The signed order checks confirmed
maker = fresh Safe, signer = fresh owner, signature type = 2 and principal =
50,000 units. A signer/API-key mismatch therefore does not explain this test's
refusal.

The public run record is `output/new-safe-probe.json`. The script recovered the
unused 0.05 pUSD to the original personal Safe and returned the remaining signer
gas funds. The new Safe remains deployed and can be reused for further tests.
The signer returned 0.153595341879269121 POL from its 0.3 POL gas funding;
the full probe also used the original account's gas for funding transactions.

## Relayer recognition and admission control

`scripts/relayer-safe-probe.py` tested the relayer after direct Safe deployment.
Public results are in `output/relayer-safe-probe.json`.

- For the unguarded Safe `0x9a18…584b`, the relayer's `/deployed` endpoint
  returned `deployed: true`, and `/nonce` returned `2`. Direct deployment had
  therefore not left the Safe invisible to the relayer.
- The supplied relayer key authenticated successfully (`GET /transactions`,
  HTTP 200). A `SAFE-CREATE` request for a different fresh signer was refused:
  `from … does not match auth …`. This tests credential scope, not whether a
  fresh signer with its own relayer key or builder credentials could create a Safe.
- A signed `SAFE-CREATE` request from the matching credential owner returned
  `proxy already deployed`. The endpoint did not register that existing Safe
  again. The official builder-relayer client's `deploy()` also stops when
  `/deployed` returns true.
- The matching owner and key successfully relayed a transaction for the
  guarded Safe `0x8c76…0548`, repeating its existing exchange approval. The
  transaction reached `STATE_CONFIRMED`:
  `0xa19d854fc1f96bb8d4d225c412a39e0a7ed2ca446a4403c6595aaf8aea083020`.
- After confirmation, one new post-only 0.05 pUSD BUY attempt, with the matching
  signer, Safe maker and signature type 2, was refused with the same
  `maker address not allowed, please use the deposit wallet flow` error.
  The geoblock check passed (`GR`). No order was accepted.

These results separate relayer access from CLOB admission: a confirmed relayer
transaction did not grant this fresh Safe admission. The public account-creation
documentation routes new users to Deposit Wallets. No separate Safe-registration
endpoint was found in the inspected official SDK or documentation. A Safe
created through the relayer from the outset, with matching fresh-signer relayer
credentials or builder credentials, was subsequently tested below.

The user reported a Discord reply, "Only if you're Jump Trading", to the
question of new Safe accounts. Its author and context have not been verified;
it is not evidence here of a documented institutional admission exception.

Sources: [official relayer client](https://github.com/Polymarket/builder-relayer-client/blob/main/src/client.ts),
[Safe creation payload](https://github.com/Polymarket/builder-relayer-client/blob/main/src/builder/create.ts),
[account creation documentation](https://docs.polymarket.com/trading/wallets-auth).

## Safe created through the builder relayer from the outset

The existing account successfully created a Builder API key through the
installed SDK's `create_builder_api_key()`. The returned key, secret and
passphrase were saved only to the user's external secrets file.

With builder authentication, a signed `SAFE-CREATE` request for the fresh signer
`0x131ce525B1bD34faC49065CaC20b8EC6aF7F9653` was accepted. The Safe was verified
undeployed before submission. Its deployment reached `STATE_CONFIRMED`:

- Safe: `0x3ae91CEAcf1073A31683c9A1646e70822AA11938`.
- Deployment transaction:
  `0x7face227f5c384b85941b88b6872bd84d1653991e952f76e24b7ba9b21f96c71`.
- A relayed exchange approval for exactly 0.05 pUSD was confirmed.
- The attempted relayed funding from the legacy Safe reverted on-chain
  (`STATE_FAILED`, receipt status `0x0`). It was not retried. The existing
  owner-execution path funded the new Safe instead.
- Direct Polygon reads at block 94,790,862 verified the fresh signer as sole
  owner, threshold 1, balance 50,000 and exchange allowance 50,000.
- One post-only BUY for 5 YES at 0.01 used the new Safe as maker, its fresh
  owner as signer and signature type 2. The signer-authenticated API-key list
  contained the client's credentials, and the geoblock check passed (`GR`).
- The CLOB refused the order:
  `maker address not allowed, please use the deposit wallet flow`.
- A relayed cleanup transfer returned the 0.05 pUSD to the original legacy
  Safe and reached `STATE_CONFIRMED`. A subsequent Polygon read verified that
  the new Safe's pUSD balance was zero. No order was accepted.

The relayer-first experiment is now complete: builder-relayer creation did not
grant this fresh Safe CLOB admission. This establishes the result for the
tested standard flow; a privately approved venue exception is still unverified.
The public evidence remains in `output/relayer-safe-probe.json`.

## Not established

- Whether a pre-May Safe *carrying the guard and handler* is admitted. Our
  legacy Safe was admitted without them. Testing it means installing them on
  `0x7a46…`, reversible by a `releaseSafe` vote.
- Whether legacy-Safe admission is permanent. A deposit-wallet migration page
  is linked in #48 and has not been read.
- Only one market (non-neg-risk); no audit.

## Open funds

0.05 pUSD is in the Safe `0x8c76…`. Anyone can call `recover` after the deadline
(timestamp 1791147503), or a `releaseSafe` vote frees the Safe. 0.95 pUSD is in
the vault and needs a `withdrawCollateral` vote.

## DAO-owned Deposit Wallet and exact order check (2 October 2026)

The current Deposit Wallet factory created wallet
`0x4F316002CdbA27B4303B9f1a84Ca203D6c46d69E` with
`DepositMandateOwner` at `0x969BfB78C6212117C117c44624259110Ff1416D8`
as its initial on-chain owner. This avoids a handover through the relayer: it
refused a wallet self-call for `transferOwnership`, while direct calls to the
factory are operator-only. The DAO executed a market-specific Governor vote to
fund the controller with 0.05 pUSD, and the controller released exactly that
amount to its wallet. Public transaction details are in
`output/deposit-from-dao-2.json`.

The owner contract reconstructs the complete order digest and accepts only the
voted market, wallet, outcome, side, amount, price, salt, deadline and associated
fields. On Polygon, `wallet.isValidSignature` returned `0x1626ba7e` for that
exact type-3 order. A fork test rejected a changed principal and verified that
the controller's recovery path sends collateral to the DAO vault. Its batch
permissions are limited to the exact approval/refund calls. The owner contract
cannot sign an arbitrary order or redirect recovery to the transport EOA.

An additional live, unfunded authentication probe used the earlier EOA-owned
control Deposit Wallet. The owner's ERC-7739-wrapped `ClobAuth` signature
returned ERC-1271 magic when checked against that wallet on Polygon. Both
`/auth/derive-api-key` and `/auth/api-key` nevertheless returned HTTP 401,
`Invalid L1 Request headers`, with `POLY_ADDRESS` set to the wallet. No
wallet-bound credentials were issued. Evidence is in
`output/clob-wallet-auth-wrapped.json` and
`output/clob-wallet-auth-wrapped-create.json`; the reproducer is
`scripts/clob-wallet-auth-wrapped.ts`. This isolates the admission gap at
the CLOB authentication service rather than the wallet's signature code.

The live post-only BUY for 5 YES at 0.01 was **rejected before admission**:
`the order signer address has to be the address of the API KEY`. The submitted
API credentials belonged to the EOA whose signature the owner contract checked;
the order's signer field was the contract-owned Deposit Wallet. A separate CLOB
L1 authentication probe used a deployed ERC-1271 contract whose signature
verified on Polygon. CLOB returned HTTP 401, `Invalid L1 Request headers`,
for that contract address; the matching EOA control request returned HTTP 200.
The evidence is in `output/clob-contract-auth.json`. Thus the tested CLOB
authentication path does not issue usable contract-signer credentials, even
though the wallet verifies the order on-chain. No DAO-owned-wallet order was
accepted or filled.

The wallet is paused for emergency recovery. After the factory's one-hour
timelock from the `recovery.start` transaction, the controller can revoke any
exchange allowance and send the 0.05 pUSD to the DAO vault. Record the final
transaction and balance checks here once confirmed.

A Polygon fork test of the deployed wallet bytecode confirmed the session-key
restriction failure. After setting the session authorization storage on the
fork to the value `authorizeSessionSigner` writes, the wallet returned ERC-1271
magic for an order with 50,001 pUSD units, while the DAO controller rejected
that digest; the voted amount was 50,000 units. Before that fork-only
authorization, the wallet rejected the same signature. The test made no live
authorization or order request. See `scripts/fork-deposit-session-mandate.ts`
and `output/deposit-session-mandate-fork.json`. This route cannot preserve the
exact-order mandate with the current wallet implementation.

The [current wallet documentation](https://docs.polymarket.com/trading/wallets-auth)
describes Deposit Wallets for new accounts. Its
[session-key flow](https://docs.polymarket.com/trading/session-keys) is a
possible supported transport for an EOA signer, but session-key management
requires Builder API authorization from Polymarket during beta. It has not been
established for a contract owner in this experiment; the documented examples
use an EOA owner key. This route should be tested only if the builder key is
enabled and the relayer accepts the controller's exact ERC-1271 authorization.
