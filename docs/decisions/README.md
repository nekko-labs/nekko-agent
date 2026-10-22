# Decisions

One file per decision that closes off alternatives, technical or product: `NNNN-short-title.md`, numbered in order, never renumbered. The format is [MADR](https://adr.github.io/madr/) cut down to what an agent and a reviewer need (see [0000-template.md](0000-template.md)).

- A decision is **append-only**. To change one, write a new record that supersedes it and set the old one's status to `superseded by NNNN`.
- The spec says *what* the product does ([spec/](../../spec/README.md)); a decision says *why this and not that*. Link the two both ways.
- Earlier decisions are still recorded inline: "Key Technical Decisions" in [TASKS.md](../../TASKS.md) and the "(decided …)" sections in the spec. Move one here when you next change it.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-split-the-spec-into-feature-files.md) | Split SPEC.md into feature files, AGENTS.md into rules and runbooks | accepted |
| [0002](0002-bundled-model-feed-with-measured-calibration.md) | Recommend models from a bundled feed, with speeds calibrated on measurements | accepted |
| [0003](0003-pseudonymize-private-values-at-the-model-client.md) | Pseudonymize private values at the model-client seam (Privacy Shield) | accepted |
| [0004](0004-supabase-for-identity-only.md) | Use Supabase Auth for identity only; keep accounts and data in Nekko Cloud | accepted |
| [0005](0005-recovery-key-as-a-p256-key-and-sealed-account-record.md) | Seal key epochs to the recovery key's public half; pin trust in a sealed account record | accepted; account record superseded by 0007 |
| [0006](0006-lockout-recovery-without-a-vendor-key.md) | Recover lockouts without a key Nekko Labs can use | proposed |
| [0007](0007-authenticated-wraps-and-join-codes.md) | Authenticate keyring wraps, approve devices with a join code, one account record per key epoch | accepted |
