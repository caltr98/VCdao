# Topic-governed Polymarket DAO

Members use stake and issuer-signed skill credentials to vote on a registered
Polymarket market. A member, including the proposer, can acquire shares with
their own capital and deliver them to the DAO. The vault pays the current
auction price atomically after exact delivery. Governed redemption returns
pUSD to the vault and reimburses the queue and execution callers separately within voted POL limits.

All contracts deployed for the DAO belong to the DAO. The existing Polymarket
exchange, relayer, oracle and collateral adapter provide external services.

The DAO selects its topic catalog, credential skills, relevance matrix and
classification policy at setup. The example policy has 10 expertise topics
and 56 skill identifiers. Skills remain one bitmap per member. An existing
credential issuer trust model is assumed. See [DESIGN.md](DESIGN.md) and
[the current benchmark and assumptions](docs/bitmap-topic-benchmark-2026-10-02.md).

## Local commands

```powershell
npm run compile
npm run typecheck
npx hardhat test test/topic-policy.ts test/governance.ts test/vault.ts test/redemption-governance.ts test/redemption.ts
npx hardhat run scripts/benchmark-bitmap.ts
npx ts-node scripts/map-topics.ts events.json output/topic-mapping.json
```

The bitmap benchmark uses five fresh local DAO deployments, 64 members per
run, and eight signed credential skills per member. It reports cumulative
upgrade gas for 1, 2, 4, 8, 16, 32 and 64 members. Activation and deployment
receipts are retained separately. It never broadcasts to Polygon.

Purchase/delivery and governed redemption have separate verified live records.
Recorded mainnet receipts remain evidence of their deployed versions. No new
deployment or paid execution is authorized by the local benchmark.

Superseded design notes and the old integration harness are in `legacyideas/`.
Historical receipts remain in `output/`. [UPSTREAM.md](UPSTREAM.md) records
the source and explicit adaptations of inherited governance code.
