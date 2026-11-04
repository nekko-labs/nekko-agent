# Spec, Nekko Agent

The source of truth for **what** Nekko Agent does and **why**: one file per feature, grouped by area. How it is built lives in [TASKS.md](../TASKS.md) (the plan) and [docs/decisions](../docs/decisions/README.md); how to work in this repo lives in [AGENTS.md](../AGENTS.md).

## How to use this folder

- **Find** a feature with `node scripts/spec-index.mjs`: it prints every file by area with its size, and also writes `spec/INDEX.md` (gitignored, never committed). Each area is a folder: [product](product/), [chat](chat/), [desktop](desktop/), [agents](agents/), [context](context/), [models](models/), [code](code/), [automation](automation/), [phone](phone/), [platform](platform/), [brand](brand/).
- **Read** [product/](product/) first for vision, users, product names and scope; then only the feature files your change touches. Do not read the whole folder: it is several hundred KB.
- **Change** the feature's file in the same PR as the code. A new feature gets a new file in its area with `title` and `area` frontmatter (`node scripts/spec-index.mjs --check` validates it in CI). A new area also needs a line in `AREAS` in `scripts/spec-index.mjs`. This file does not list features, so it does not change when one is added.
- **Record** user intent, acceptance criteria, privacy and security boundaries, and status (implemented, planned, unverified) inside the feature file. A product decision that closes off alternatives also gets a record in [docs/decisions](../docs/decisions/README.md).
- **Status words** stay in the text (`[shipped]`, `[implemented 2026-10-17; not yet ...]`); never mark a feature shipped only because code exists.

The index used to live here and was committed. Every line carried its file's size, so about half of all PRs rewrote this file and collided in the merge queue; see [decision 0048](../docs/decisions/0048-keep-the-spec-index-and-task-log-out-of-prs.md).
