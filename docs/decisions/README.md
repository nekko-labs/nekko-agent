# Decisions

One file per decision that closes off alternatives, technical or product: `NNNN-short-title.md`, numbered in order, never renumbered. The format is [MADR](https://adr.github.io/madr/) cut down to what an agent and a reviewer need (see [0000-template.md](0000-template.md)).

- A decision is **append-only**. To change one, write a new record that supersedes it and set the old one's status to `superseded by NNNN`.
- The spec says *what* the product does ([spec/](../../spec/README.md)); a decision says *why this and not that*. Link the two both ways.
- Earlier decisions are still recorded inline: "Key Technical Decisions" in [TASKS.md](../../TASKS.md) and the "(decided …)" sections in the spec. Move one here when you next change it.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-split-the-spec-into-feature-files.md) | Split SPEC.md into feature files, AGENTS.md into rules and runbooks | accepted |
