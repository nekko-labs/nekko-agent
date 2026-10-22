# Golden fixtures

The frozen fixtures under `crates/*/tests/golden` and how a behavior change edits them.

## Golden fixtures

The engine is all Rust (`crates/`); the TS engine it was ported from
(`packages/host`, `packages/core`) is deleted. The golden fixtures under
`crates/*/tests/golden` were recorded from that TS code and are now frozen: no
test rewrites them any more, and the `UPDATE_GOLDEN=1` notes in their doc
comments name writers that no longer exist. A change that alters a recorded
behaviour (the system prompt in `crates/nekko-context/src/prompt.rs`, a
provider's request, a store write) edits the fixture by hand in the same
change, and the PR says why.
