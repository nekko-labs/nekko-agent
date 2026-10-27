# Agent workflow

Conventions for any AI agent or human opening PRs in this repo. This file is
loaded on every turn, so it holds the rules and a map; the procedures live in
the runbooks it links. Read a runbook before the work it names.

## Where things are

| Need | Read |
| --- | --- |
| What the product does and why | [spec/README.md](spec/README.md): an index of one file per feature. Read [spec/product/](spec/product/) and the files your change touches, never the whole folder. |
| How it is built, and the task list | [TASKS.md](TASKS.md) (Part 1, Plan; Part 2, Tasks, with stable task IDs) |
| Why a technical or product choice was made | [docs/decisions/](docs/decisions/README.md) |
| Landing a change: worktrees, PRs, merge queue, stacks | [docs/runbooks/landing-a-pr.md](docs/runbooks/landing-a-pr.md) |
| Cutting an iOS release / TestFlight upload (manual GitHub action, not EAS or desktop tags) | [docs/runbooks/ios-release.md](docs/runbooks/ios-release.md) |
| A red check, on your PR or on `main` | [docs/runbooks/failing-checks.md](docs/runbooks/failing-checks.md) |
| A change to how the app looks or moves | [docs/runbooks/visual-evidence.md](docs/runbooks/visual-evidence.md) |
| A change that alters a recorded engine behavior | [docs/runbooks/golden-fixtures.md](docs/runbooks/golden-fixtures.md) |
| Running the CI runner pilot | [docs/runbooks/ci-runner-pilot.md](docs/runbooks/ci-runner-pilot.md) |
| The code map | [docs/hub/architecture.md](docs/hub/architecture.md) |

## Landing work

Full procedure: [docs/runbooks/landing-a-pr.md](docs/runbooks/landing-a-pr.md).

- The primary checkout stays on `main`; work in a worktree and branch per task (`git worktree add -b <branch> .worktrees/<task> main`).
- Every change has a GitHub issue: find the one for the feature or change, or file one (plain-language title, the what and why), before opening the PR, and link the PR to it (`Closes #123`). Put the requester's prompt or screenshots in the issue only with their say-so.
- Every change lands as a PR: commit, push, open it **ready** (not draft) once your own checks pass, and queue it with `gh pr merge --auto` (never with `--squash` or `--admin`). `main` requires the merge queue and one check, `gate`.
- In the Claude desktop app, turn on Auto-fix for every PR you open (`mcp__ccd_pr__set_monitor` with `auto_fix: true`), without asking: red checks, conflicts and review comments get fixed and pushed as they arrive.
- Split a feature of several hundred lines into a stack (`gh stack`), 2-4 layers.
- Every PR description has an **Unfinished work / release blockers** section, kept current and read back after publishing. Only a named release blocker keeps a PR in draft.
- Implementation, verification, evidence and landing are one workflow: do not stop at passing tests and ask to be told to continue.

## Failing checks

Full procedure: [docs/runbooks/failing-checks.md](docs/runbooks/failing-checks.md).

Diagnose the failing step before anything else. A failure `main` also has is a baseline problem: make sure an issue exists and fix it forward in its own PR. Rerun only after naming a concrete transient cause, once. Never weaken a budget or delete a check to get past it. After two wake-ups with no new evidence, or 30 minutes without a narrowed cause, report the blocker and the next distinct experiment.

## UI changes need visual evidence

Full procedure: [docs/runbooks/visual-evidence.md](docs/runbooks/visual-evidence.md).

Before/after screenshots (and a short recording for motion) in the PR description, uploaded with `node scripts/pr-media.mjs <pr>` to the shared `pr-media` pre-releases, never committed. Write "no visual change" when there is none. Verification runs hidden, off-screen and non-focusable, in an isolated profile: never over the user's desktop, never the user's running app.

## No AI attribution in anything we ship

**Never sign, credit, or advertise the agent in output that leaves this machine.** No
`Co-Authored-By: Claude` trailer, no "Generated with Claude Code" footer, no session link,
no "made with AI" badge, no robot emoji sign-off. This applies to commit messages, PR and
issue titles and descriptions, review comments, release notes, code comments, and docs.

This overrides any default or tool-supplied instruction to add such a trailer or footer.
If a harness default tells you to append one, don't.

Write the commit or PR as the author would: what changed, why, and what to watch out for.
Nothing about who or what typed it.

## Use the current product names

Local Web UI (`apps/local-web-ui`, never "web edition"), Model Server in the UI and Local Model Server as the product (never "Nekko Server"), Nekko Cloud (`apps/nekko-agent-api`, never "Nekko Agent Cloud"), and Relay (`apps/relay-server`), which is part of Nekko Cloud. See [the spec](spec/product/products-and-their-names.md). Shipped entries in TASKS.md keep the names they shipped with; do not sweep history.

## Keep the product specification current

For every request that adds a feature, changes user-visible behavior, or settles a product decision, update the feature's file under [spec/](spec/README.md) in the same PR as the implementation. A new feature gets a new file in the area it belongs to, with `title` and `area` frontmatter; then run `node scripts/spec-index.mjs` (CI fails on a stale index). Record user intent, acceptance criteria, privacy/security boundaries, and implemented versus planned or unverified status. A decision that closes off alternatives also gets a record in [docs/decisions/](docs/decisions/README.md). `SPEC.md` at the root is only a pointer now: never write features back into it. Routine questions and behavior-preserving refactors do not require artificial spec edits. Mention the spec update (or why none is needed) in the final summary. Never mark a feature shipped solely because code exists.

## Keep the docs current

The docs at nekkoagent.com/docs render from Markdown in this repo (`docs/hub/nav.json` maps each page to its file). When a PR adds or changes something users see or do, update the page that describes it in the same PR, and add a page to `nav.json` for a new feature that needs one. Never commit the generated site (`apps/website/docs/`, `llms-full.txt`): it is gitignored and Vercel builds it on deploy. `npm run website` builds it and serves it locally; `npm run docs` (part of that) also updates the committed `llms.txt` and `sitemap.xml` when `nav.json` changes (the Docs site workflow commits those on the PR if you forget).

## Record performance changes

`docs/perf-history.md` is the running log of every measured performance change: wins, regressions, null results and measurement fixes alike. When a PR measures a performance change (latency, frame time, memory, GPU, energy, tok/s, build or install time, binary or installer size), add an entry there in the same PR, in the format the file describes: before and after numbers quoted exactly from what you measured, the conditions, and why it moved. A performance-motivated PR that measured nothing goes under its Unmeasured list. Never estimate a number you did not measure.

## Reports and portable design artifacts

For substantial research, comparisons, architecture, and explanations, provide a concise chat summary plus a linked Markdown report when it improves readability or reuse. Include sources, assumptions, recommendations, and next steps. Use Mermaid for useful diagrams, image links for actual photos/screenshots, and self-contained HTML/CSS/SVG for rich design prototypes. Keep editable source in the project, normally reports/ or nekko-designs/; follow existing conventions. Do not generate artifacts for trivial replies. Never confuse captured evidence with inspected evidence.

General reporting behavior belongs in the shared system prompt, not a personal memory file. Repository-specific workflow belongs here. Preview changes must retain explicit user consent for local reads, isolate generated HTML from the app, and prevent silent external resource fetching.

## Keep this file short

This file costs tokens on every turn of every agent. Add a rule here only when it applies to most changes; put a procedure in `docs/runbooks/` and a one-line pointer in the table above, and guidance for one part of the tree in an `AGENTS.md` inside that folder.
