# Polymarket-sponsored DAO vault redemption — verified on Polygon

Polymarket's official Deposit Wallet `WALLET` relayer route sponsored a real
call to the custom vault's permissionless `redeem(uint256 market)`. The vault
received **0.1 pUSD**, both resolved outcome positions were consumed, and the
signer and Deposit Wallet paid **zero Polygon gas**.

- [Successful mainnet transaction](https://polygonscan.com/tx/0xf8f291d359136bdce000e84cf0861fda83e829c4ec92df85896e07d20c11b442)
- Block: **94819405**; independent verification found **160 confirmations**.
- Relayer transaction ID: `01a0fbff-de30-743e-b970-3a7e0a616641`;
  the relayer reported `STATE_CONFIRMED`.
- Gas payer: `0xd3447596d282d62bc94240d17caee437efcfde62`.
- Gas used: **749,937**; gas fee paid by the relayer:
  **0.290420670235819794 POL**.
- DAO test vault: `0x1B3C2d5D9F2EaB3f8155892696bB3B56fC0b6968`.
- Calling Deposit Wallet: `0x92DC8012d9C27703d9EBE7a3EdD1037eE8ac4f2a`.
- Trading signer: `0xDc9311c53D3d1Cb1d9eD87B9028FB35c2168629d`.
- Fixed adapter: `0xAdA100Db00Ca00073811820692005400218FcE1f`.

## Execution and evidence

The test reused the deployed `RedeemableOrderVault` and the genuinely resolved
condition recorded in `output/redemption-market.json`:
`0x975e29d980948abf207cd5f1379bac2773f2c96ba7a8161f2e64820a2df601c1`.
The on-chain denominator was 1 and payout numerators were `[1, 0]`.

One signed EIP-712 Deposit Wallet batch performed five ordered calls:

1. Approve exactly 100,000 pUSD base units to the fixed adapter.
2. Split that 0.1 pUSD into both real outcome positions for the resolved condition.
3. Transfer both 100,000-unit positions from the Deposit Wallet into the vault.
4. Call `vault.redeem(uint256(conditionId))`.
5. Clear the Deposit Wallet's pUSD allowance to the adapter.

The acquisition principal came from the solver Deposit Wallet's existing
pUSD. No existing DAO shares were moved into that wallet. Acquisition,
delivery, and redemption were sponsored in the same atomic transaction.
The script first simulated the signed wallet batch using a read-only `eth_call`
in the factory's caller context. No state override, oracle change, impersonated
broadcast, paid preparation transaction, or deployment occurred.

Historical balances and decoded receipt logs establish the full asset flow:
the CTF minted the complete set to the adapter, the adapter delivered it to
the Deposit Wallet, the wallet transferred it to the vault, the adapter took
both positions from the vault and burned them, and pUSD was minted directly
to the vault. `PositionRedeemed` recorded the Deposit Wallet as caller,
100,000 of each outcome, and a 100,000-unit payout.

| Asset | Before successful transaction | After successful transaction |
|---|---:|---:|
| Vault pUSD | 0 | 0.1 |
| Vault YES / NO | 0 / 0 | 0 / 0 |
| Solver Deposit Wallet pUSD | 2.016626 | 1.916626 |
| Solver Deposit Wallet POL | 0 | 0 |
| Trading EOA pUSD | 0 | 0 |
| Trading EOA POL | 0.751860212021684873 | 0.751860212021684873 |
| Original Safe pUSD | 9.05 | 9.05 |
| Original Safe unresolved shares | 5 | 5 |
| DAO 2 vault pUSD | 0.733374 | 0.733374 |
| DAO 2 vault unresolved shares | 0 | 0 |

Vault outcome balances start and end at zero because the same transaction
delivers and redeems them. The delivery, adapter transfer, burn, and redemption
event checks establish actual consumption. The vault's CTF operator approval
was false afterward; the solver's adapter pUSD allowance was zero.

Independent verification recovered the signer from the EIP-712 signature,
matched the entire factory transaction ABI argument encoding against the
journaled batch and signature, verified the successful receipt and asset-flow
logs, and read balances at the block before and the block of execution. All
**19 checks passed**. The factory's outer selector is distinct from the wallet's
`execute` selector; the verifier compares the complete encoded arguments.

## Diagnostic attempts

The first call targeted `redeem` while the vault had no positions. The local
read-only simulation reverted with `No position`; `/submit` returned HTTP 500
and `{"error":"internal error"}`, without a transaction ID. The next params
request returned the same wallet nonce, 3. This attempt proves neither
successful redemption nor a custom-target allowlist rejection.

Two distinct sponsored controls resolved that uncertainty:

- A zero-value pUSD self-transfer was confirmed:
  [receipt](https://polygonscan.com/tx/0x091db72bc6d43b470c00620c1e14c1076b34b8adcfb3b25dca6030d0a313886b).
  It established working relayer authentication and the existing Deposit Wallet route.
- A call to the custom vault's harmless `redemptionAdapter()` getter was confirmed:
  [receipt](https://polygonscan.com/tx/0xfac0109a87d2b5d2d6deb8956bca26dc12481970955b08fde6db894f5418c53e).
  It established that this custom vault target was accepted.

The successful funded batch followed with fresh nonce 5. No request was
submitted twice. The initial HTTP 500 was left recorded, without a blind retry.

## Final state and scope

**The 0.1 pUSD test principal remains in the isolated DAO test vault.** Returning
it requires that fixture's Timelock withdrawal authorization; this task did
not spend POL to schedule or execute a withdrawal. The solver wallet is the
source of this bounded test principal. Existing DAO assets and the original
Safe's five unresolved shares and 9.05 pUSD remain unchanged.

The recorded result is a sponsored standard-market redemption on the existing
test vault. It exercised neither Governor voting nor a CLOB purchase, and
does not add a negative-risk route. The same documented wallet-call mechanism
can submit a standalone `redeem` when the vault already holds resolved shares;
the mined successful test included acquisition and delivery in its batch.
Sponsorship remains subject to Polymarket's server policy and relayer availability.

No contract, Worker, paper, Overleaf document, or diagram was changed. For any
future paid keeper fallback, the gas account must be **DAO-funded and
DAO-controlled**, as required by the user. A personally funded operator
account does not satisfy that requirement. No fallback was implemented here.

## Files and resumption

- `scripts/probe-relayer-redemption.py`: official SDK signing and payload builder;
  one-shot phases `preflight`, `probe`, `control`, `targetControl`, `fundedProbe`,
  plus read-only `reconcile`. `RELAYER_KEY` is process environment only.
- `output/relayer-redemption.jsonl`: append-only public journal, fsynced before
  each submission; stores signed payloads, snapshots, server replies and confirmation records.
  A prepared phase cannot be automatically submitted again.
- `scripts/verify-relayer-redemption.py`: read-only historical receipt verifier;
  reads only this project's Polygon RPC credential.
- `output/relayer-redemption-verification.json`: all checks, exact integer
  balances, gas payment, and decoded receipt logs.

Run the verifier from the project root with
`.venv/Scripts/python.exe scripts/verify-relayer-redemption.py`.
Both new Python scripts passed syntax compilation. The completed earlier
`output/live-redemption.json` was preserved byte-for-byte; SHA-256:
`18806f8230a5fd1329e46761b2a998de2a89b833cbf15de6b1d6f9239f6eb80e`.
Do not repeat the funded phase or reset either journal.

Official references checked on 2026-10-02:
[Deposit Wallet gasless calls](https://docs.polymarket.com/trading/wallets-auth#execute-gasless-transactions),
[position management](https://docs.polymarket.com/trading/positions/manage),
and [submit API](https://docs.polymarket.com/api-reference/relayer/submit-a-transaction).
The accepted mainnet receipt establishes sponsorship beyond the documentation's
general wallet-call interface.
