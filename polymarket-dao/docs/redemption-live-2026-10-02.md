# Vault redemption: implementation and live Polygon test

`RedeemableOrderVault` extends the existing `OrderVault`/`BetVault` treasury
with `redeem(uint256 market)`. `market` is `uint256(conditionId)`. Anyone may
trigger it and pay gas; the fixed adapter pays pUSD to the vault that called it.
The function has no recipient or adapter argument. Withdrawal remains a
Timelock action through `withdrawCollateral`.

The implementation is in `contracts/VaultRedemption.sol`. It checks that the
registered outcomes are the real USDC.e-backed positions for that binary
condition, requires an on-chain payout denominator, and computes the expected
payout with each outcome rounded down. It grants the fixed adapter ERC1155
approval inside a guarded transaction, redeems both balances, revokes approval,
and checks that both balances were consumed and the vault received at least the
expected pUSD. A failed check rolls the whole transaction back. Existing
collateral and pending-buy reservations are preserved.

The adapter is `0xAdA100Db00Ca00073811820692005400218FcE1f`, published in
[Polymarket's position-management documentation](https://docs.polymarket.com/trading/positions/manage).
Its Polygon runtime hash was
`0x93b965351d01c1a128821ac79fc98a18105daefb46bda0d1e5b52306d713aa4f`.
The live script pins that hash and verifies its CTF, pUSD and USDC.e getters.
The repository deployment table lists an older adapter at
`0xADa100874d00e3331D00F2007a9c336a65009718`; both have code, so we used the
current documentation address and tested its actual behavior. This deployment
supports standard binary positions; it does not add a negative-risk route.

## Live test

An isolated zero-delay Timelock, registry and vault were deployed. The registry
reuses DAO 2's existing skill metadata. The test Timelock's proposer is the
funded Main EOA; this fixture exercises the treasury calls, not Governor voting.
Full DAO deployment with the new vault and the usual Governor role handover is
covered separately by a deployment integration test.

The test used the genuinely resolved market **Mukhin Vitalii vs. Semenets
Serhii: Total Games O/U 4.5**, condition
`0x975e29d980948abf207cd5f1379bac2773f2c96ba7a8161f2e64820a2df601c1`.
Polygon already held payout numerators `[1, 0]` and denominator `1`.
The registry's future cutoff was a test trading deadline, not a claim about
the historical market close.

We took **0.1 pUSD** from the original funding Safe, split it through the real
adapter into a complete set for that existing condition, and transferred both
outcomes into the new vault. This was a real mainnet split, not a CLOB purchase.
No oracle reporting, account impersonation or storage editing occurred on
mainnet. An EOA then called the vault's public `redeem` function.

| Balance at redemption | Before | After |
| --- | ---: | ---: |
| Vault pUSD | 0 | 0.1 |
| Vault outcome 1 | 0.1 | 0 |
| Vault outcome 2 | 0.1 | 0 |
| Caller pUSD | 0 | 0 |

The receipt contains both CTF burns, pUSD minted directly to the vault, and
`PositionRedeemed`. The vault's adapter approval was false at the receipt block.
Independent verification at block **94818199** found **118 confirmations** and
checked historical balances before and after redemption.

- Test vault: `0x1B3C2d5D9F2EaB3f8155892696bB3B56fC0b6968`.
- Test Timelock: `0x1034DDB9BCA69E1EDC71bbe0042761ebf73c930e`.
- Test registry: `0x43f13157f7E3279B0297702d74676b9A7c2E776C`.
- [Redemption transaction](https://polygonscan.com/tx/0xe2a98f3acfb3a86a129e1c33dc65c6152edc62efa1fa659b5587244a00e70418).
- [Principal returned through the test Timelock](https://polygonscan.com/tx/0xd871227ae2fda2e43c19902bae8fea5686a310430b33b84fb68648a399e2152c).

After recording the payout, the Timelock returned the full 0.1 pUSD to the
original Safe `0x7a46dCFfa7064Fe54Ee848b125a5C58c3b9f5Ddb`, restoring its
9.05 pUSD balance. The isolated vault ends with no pUSD or test outcome tokens.
DAO 2's original vault retains its 5 unresolved outcome shares and 0.733374 pUSD.
Total gas for all 12 deployment, acquisition, redemption and cleanup transactions
was **2.312648081578601290 POL**, below the script's 3 POL cap.

## Checks and next deployments

- `test/redemption.ts`: permissionless caller, exact payout, fractional rounding,
  losing positions, reservations, unknown/unresolved conditions, incorrect token
  mappings, adapter failures, missing payout, unconsumed tokens, reentry, asset
  configuration and full DAO deployment wiring.
- `scripts/fork-redemption.ts`: real adapter and existing oracle resolution on a
  Polygon fork; only acquisition funding is impersonated there.
- `scripts/live-redemption.ts`: resumable live journal, exact signed bytes saved
  before broadcast, fixed 0.1 pUSD principal, bounded gas, cleanup to the Safe.
- `scripts/verify-redemption.ts`: independent, read-only receipt/log and historical
  balance checks. It does not need a private key.

`scripts/deploy.ts` now supplies the fixed standard adapter to `deployDao`, which
deploys `RedeemableOrderVault`. Callers that omit `collateralAdapter` retain the
older `OrderVault` for compatibility. Existing deployed vaults are immutable and
have not gained this function; DAO 2's existing position was not migrated.

Public evidence is in `output/live-redemption.json`,
`output/live-redemption-verification.json`, `output/fork-redemption.json`, and
`output/redemption-market.json`. The live journal includes already broadcast
signed transactions but no private keys, relayer keys or RPC credentials.
Private keys and RPC credentials were passed only in the process environment.
Direct on-chain calls required no CLOB credentials or relayer API key.

Verification commands, from the project root:

```powershell
npm test
npm run typecheck
# Set POLYGON_RPC_URL in the process environment for network checks.
npx hardhat --config hardhat.fork.config.ts run scripts/fork-redemption.ts
npx hardhat run scripts/verify-redemption.ts
```

Final checks: **87 tests pass**, including 11 redemption/deployment tests;
TypeScript type checking passes. The real-contract fork passed all five
redemption checks, and independent live verification passed all 12 checks.
The existing Safe guard tests emit promise-handling warnings but pass; no
failed checks were hidden. The completed live journal is retained and should
not be reset for an unrequested repeat test.

## Subsequent share recovery

After the redemption test, the user requested return of DAO 2's five existing
unresolved shares to the original funding Safe. Governance completed that
[transfer](https://polygonscan.com/tx/0x2cbb2b9de9e5fe996494c0a1a77246dbb5d554ee7243ad5e184f99489cb21cb6).
The original vault now holds zero of those shares, and the Safe holds five.
pUSD balances remain 0.733374 in the original vault and 9.05 in the Safe.
This later action is recorded in `output/share-recovery.json` and independently
verified in `output/share-recovery-verification.json`. The redemption checks
above refer to the historical test blocks, before this recovery.
