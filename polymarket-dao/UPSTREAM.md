# Prestifilippo source

The nine Solidity files in `contracts/prestifilippo/` come from
[mattiaprestifilippocolombrino/VCdao](https://github.com/mattiaprestifilippocolombrino/VCdao/tree/6bed7766996d200b508a09361315302fdae5e119/dao/contracts),
commit `6bed7766996d200b508a09361315302fdae5e119`, fetched on 2026-09-26.
Their original SPDX headers and comments are preserved.

`MyGovernor.proposeWithTopic` is `public virtual` instead of `external`, allowing
`MarketGovernor` to validate market actions before invoking the original implementation.

On 2026-10-02, `GovernanceSkill` gained internal virtual catalog hooks and
view catalog getters. The original contract still uses its original four-topic,
eight-skill library. `DaoGovernanceSkill` overrides those hooks to use the
catalog selected by the DAO in `DaoSkillCalculator`. Issuer verification,
member-bound DIDs, bitmap OR merging, score caps and checkpoint writes remain
in the inherited implementation. New deployments use the DAO-selected catalog.
The original eight IDs and their bit positions are retained in the example
policy. Previously deployed contracts are unchanged.

The package lock started from the same commit's `dao/package-lock.json`. The
package name and scripts identify this independent prototype. Nothing in the
student's working tree or the Polymarket experimentation strategies was edited.

The inspected Polymarket experimentation source is
`D:/PolymarketExperimentation/1)REAL BETTING/real_betting_common.py`, particularly
`_V2ClobAdapter` and `build_authenticated_client`. Its existing V2 client usage
informed the external-order workflow. This prototype uses the currently
documented `polymarket-client==0.11.0` through a small independent entry point;
importing the strategy helper would also import unrelated strategy modules and
their runtime dependencies. Credentials and funded wallets are not copied.
