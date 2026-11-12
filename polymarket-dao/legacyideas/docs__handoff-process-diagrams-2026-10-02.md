# Detailed handoff: process diagrams and description

Assigned chat: `01a0fc11-8c2c-7d43-a695-5ebc4e30477d`.
First read `docs/agents-current-workflow-plan-2026-10-02.md`. This document adds
the diagram work plan and acceptance criteria. Preserve any useful work already
done; correct it to the latest Deposit Wallet push/sponsored-redemption route.

## Objective and reference diagrams

Produce an editable diagram and complete process description that a reader
can follow from DAO creation and governance to **redemption into DAO custody**.
Use the actual style of the human's supplied diagrams:

- `https://app.diagrams.net/#G1a-TjfUT2-dFrQtC9rLwe5lsbYJGQoYoM#%7B%22pageId%22%3A%220%22%7D`
- `https://app.diagrams.net/#G1b-FFjjembdzLLeryabNQwvASCyPxRsQy#%7B%22pageId%22%3A%220%22%7D`
- Additional reference: `https://app.diagrams.net/#G1ZLsvRSdEiTFaCH_nKdFMxjHjMdmbo4JG`

Drive file IDs are respectively `1a-TjfUT2-dFrQtC9rLwe5lsbYJGQoYoM`,
`1b-FFjjembdzLLeryabNQwvASCyPxRsQy`, `1ZLsvRSdEiTFaCH_nKdFMxjHjMdmbo4JG`.
Use the applicable Drive/computer-use skills and tool access checks to read the
real contents, not a guessed page. Useful existing local reference artifacts:
`docs/auction-source.drawio`, `docs/open-auction-push.drawio`,
`docs/open-auction-push.url.txt`. Verify their relationship to the linked files.

## Execution steps

1. Inspect all accessible reference pages. Record the actual visual vocabulary:
   actor arrangement, flow direction, shapes, arrow types, colors, fonts,
   grouping, label language, abbreviation style and amount of prose. Follow
   the reference's language/notation rather than inventing a new presentation.
2. Read the common plan and core contracts: `MarketRegistry`, `MarketGovernor`,
   `BetVault`, `RedeemableOrderVault`, `VaultRedemption`, and the voting/credential
   upstream files. Read deployment, actual push delivery, latest relayer probe
   and receipt-verifier scripts. Follow transactions through their callers.
3. Write a source-to-diagram mapping: each node/edge has a concrete contract
   method, off-chain API step, or external resolution event. Identify separately
   the voting-power path, pUSD custody path, outcome-token path and gas payer.
   Match their visual distinctions to the supplied references.
4. Draft a compact full workflow plus a detailed description covering every
   stage in the common plan. Include the Dutch price rule and the distinction
   between member stake and pUSD trading funds. Explain exact push/payment
   atomicity and the fixed-recipient redemption guarantee.
5. Produce a separate editable `.drawio` file; keep originals intact. The end
   state must show pUSD in the DAO vault after sponsored redemption. Show the
   Deposit Wallet as a relay caller and solver, never as the DAO payout recipient.
6. Show actual gas sponsorship on the two supported wallet-call routes: push
   delivery and vault redemption. Governance transaction submission is a
   separate payer question; the production paid keeper requirement is
   DAO funding/control. Do not imply governance sponsorship was demonstrated.
7. Keep evidence annotations concise. Link the actual acquisition/delivery
   receipts and latest redemption receipt. State that the historic live auction
   and isolated redemption test are separate demonstrations; the process diagram
   can describe the composed implementation without mislabeling the evidence.
8. Render/open the new diagram and inspect it: legible labels, connected arrows,
   adequate spacing, no clipping or overlapping actors, complete flow through
   redemption, consistent style. Fix visual problems before delivery.
9. Cross-check every invariant against code and every evidence claim against
   journals/receipts. Write a dedicated handoff identifying artifact paths,
   reference inspection results and unresolved access issues.

## Deliverables

- `docs/system-process-current.drawio`: editable final diagram.
- `docs/system-process-current.md`: coherent process description, actor/custody
  mapping, concise source references and verified evidence annotations.
- `docs/system-process-current-preview.svg` or `.png`: inspected preview.
- `docs/system-process-current-handoff.md`: what was completed and how to edit/review it.
- If native Drive creation is available within the task, provide a separate
  reviewable copy matching these artifacts and its direct URL. Do not publish
  externally or modify the supplied originals merely to make a review link.

## Completion checks

The result must include Governor/Timelock authorization, open-executor auction,
solver-funded acquisition, exact sponsored push/payment, actual vault custody,
external resolution, and sponsored permissionless fixed-adapter redemption.
Every principal/gas flow has the correct payer/recipient. Older Safe/pull/session
routes are not the active route. The real latest sponsored receipt is cited.
The actual supplied style was inspected, or any inaccessible reference is named
precisely. Deliver the editable artifact, preview and description; do not stop
at a textual proposal or a generic explanation of the repository.

No mainnet keys are needed for this assignment. Credential access instructions
are available in the common plan for context; do not retrieve/use secrets for
diagram authoring. No paper edits, transaction, contract or benchmark changes.
