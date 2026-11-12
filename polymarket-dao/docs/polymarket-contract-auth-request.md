# Contract-owned Deposit Wallet CLOB authentication request

We need to submit a POLY_1271 order from a current Deposit Wallet whose
on-chain owner is a DAO contract. The owner approves only one DAO-voted order
digest. We cannot authorize an EOA session key because the wallet verifies
session orders against that EOA, bypassing the DAO's exact-order check.

The DAO-owned wallet `0x4F316002CdbA27B4303B9f1a84Ca203D6c46d69E`
returned ERC-1271 magic for the voted order, but the CLOB rejected the order
because its API key belongs to transport EOA
`0x131ce525B1bD34faC49065CaC20b8EC6aF7F9653`. The wallet is now paused
for recovery, so this address is evidence only, not the proposed live account.

We also tested CLOB L1 authentication with an unfunded control Deposit Wallet
`0x03360EEC0D055a915e5cBf075447Ef36C6B6Ffb6`. Its ERC-7739-wrapped
`ClobAuth` signature returned `0x1626ba7e` from the wallet's
`isValidSignature` on Polygon. With `POLY_ADDRESS` set to that wallet,
`/auth/derive-api-key` and `/auth/api-key` both returned HTTP 401,
`Invalid L1 Request headers`. No credentials were issued.

**Question for Polymarket:** What supported process can issue CLOB API
credentials whose registered signer is a contract-owned Deposit Wallet, while
the wallet's ERC-1271 check remains the authority for every order? If the
current L1 authentication service cannot validate ERC-1271 or ERC-7739,
can Polymarket provision a wallet-bound API key or enable that validation?
We can provide the exact signed request and transaction evidence privately.
We do not need an EOA session key or permission for arbitrary orders.
