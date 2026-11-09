# Agent workflow

Conventions for any AI agent or human opening PRs in this repo. This file is
loaded on every turn, so it holds the rules and a map; the procedures live in
the runbooks it links. Read a runbook before the work it names.

## Where things are

| Need | Read |
| --- | --- |
| What the product does and why | [spec/](spec/README.md): one file per feature. `node scripts/spec-index.mjs` prints the index (and writes `spec/INDEX.md`, never committed). Read [spec/product/](spec/product/) and the files your change touches, never the whole folder. |
| How it is built | [TASKS.md](TASKS.md), the plan only |
| The task list | GitHub issues (one per change, see Landing work). Tasks up to 2026-11-04, and the task IDs code comments cite, are in [docs/history/tasks-archive.md](docs/history/tasks-archive.md) |
| Why a technical or product choice was made | [docs/decisions/](docs/decisions/README.md) |
| Landing a change: worktrees, PRs, auto-merge, stacks | [docs/runbooks/landing-a-pr.md](docs/runbooks/landing-a-pr.md) |
| Version numbers, cutting a release (a `vMAJOR.MINOR.0` tag; never bump a version in a PR) | [docs/runbooks/releasing.md](docs/runbooks/releasing.md) |
| Cutting an iOS release / TestFlight upload (manual GitHub action, not EAS or desktop tags) | [docs/runbooks/ios-release.md](docs/runbooks/ios-release.md) |
| A red check, on your PR or on `main` | [docs/runbooks/failing-checks.md](docs/runbooks/failing-checks.md) |
| Designing or restyling a screen (layout, spacing, rows, status) | [docs/design-system.md](docs/design-system.md) |
| A change to how the app looks or moves | [docs/runbooks/visual-evidence.md](docs/runbooks/visual-evidence.md) |
| A change that alters a recorded engine behavior | [docs/runbooks/golden-fixtures.md](docs/runbooks/golden-fixtures.md) |
| Running the CI runner pilot | [docs/runbooks/ci-runner-pilot.md](docs/runbooks/ci-runner-pilot.md) |
| Adding a package, crate, icon, font, image, model or anything else we did not make | [docs/runbooks/third-party.md](docs/runbooks/third-party.md) |
| The code map | [docs/hub/architecture.md](docs/hub/architecture.md) |

## Landing work

Full procedure: [docs/runbooks/landing-a-pr.md](docs/runbooks/landing-a-pr.md).

- The primary checkout stays on `main`; work in a worktree and branch per task (`git worktree add -b <branch> .worktrees/<task> main`).
- Every change has a GitHub issue: find the one for the feature or change, or file one (plain-language title, the what and why), before opening the PR, and link the PR to it (`Closes #123`). The issue is the task: its plan notes and checklist live there, never as a new group in TASKS.md. Put the requester's prompt or screenshots in the issue only with their say-so.
- Every change lands as a PR: commit, push, open it **ready** (not draft) once your own checks pass, and arm auto-merge with `gh pr merge --auto --squash` (never `--admin`). `main` requires one check, `gate`; there is no merge queue, so `gate` waits for the speed contract (when the PR touches what it measures; `ci:perf` forces it) and the loopback itests on the PR itself ([decision 0059](docs/decisions/0059-speed-contract-and-itests-run-on-every-pr.md)).
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

## Check the license before adding anything

Before adding anything third-party, free or paid (a package, crate, icon, font, image, sound, model, vendored file, downloaded runtime), read its actual license and follow [docs/runbooks/third-party.md](docs/runbooks/third-party.md). Assets go in [ASSETS.md](ASSETS.md), the public credits page. Stop and ask Philip about anything outside the usual permissive licenses, including no license at all.

## Use the current product names

Local Web UI (`apps/local-web-ui`, never "web edition"), Model Server in the UI and Local Model Server as the product (never "Nekko Server"), Nekko Cloud (`apps/nekko-agent-api`, never "Nekko Agent Cloud"), and Relay (`apps/relay-server`), which is part of Nekko Cloud. See [the spec](spec/product/products-and-their-names.md). Entries in the task archive (docs/history/tasks-archive.md) keep the names they shipped with; do not sweep history.

## Keep the product specification current

For every request that adds a feature, changes user-visible behavior, or settles a product decision, update the feature's file under [spec/](spec/README.md) in the same PR as the implementation. A new feature gets a new file in the area it belongs to, with `title` and `area` frontmatter (CI checks it with `node scripts/spec-index.mjs --check`; the index is generated, never committed). Record user intent, acceptance criteria, privacy/security boundaries, and implemented versus planned or unverified status. A decision that closes off alternatives also gets a record in [docs/decisions/](docs/decisions/README.md). `SPEC.md` at the root is only a pointer now: never write features back into it. Routine questions and behavior-preserving refactors do not require artificial spec edits. Mention the spec update (or why none is needed) in the final summary. Never mark a feature shipped solely because code exists.

## Keep the phone apps in step

iOS and Android carry the same features, existing and new. If a feature depends on something only one OS has, build the other OS's equivalent when there is one (Apple Pay and Samsung Pay); it stays on one app only when the other has nothing that can do the job. Each app follows its own platform's design guidance while keeping the same themes, mascot, wording and screen order. When one app lands first, the same PR files the other app's issue and adds a gaps row in [the spec](spec/phone/ios-and-android-stay-in-step.md).

## Keep the docs current

The docs at nekkoagent.com/docs render from Markdown in this repo (`docs/hub/nav.json` maps each page to its file). When a PR adds or changes something users see or do, update the page that describes it in the same PR, and add a page to `nav.json` for a new feature that needs one. Never commit the generated site (`apps/website/docs/`, `llms-full.txt`): it is gitignored and Vercel builds it on deploy. `npm run website` builds it and serves it locally; `npm run docs` (part of that) also updates the committed `llms.txt` and `sitemap.xml` when `nav.json` changes (the Docs site workflow commits those on the PR if you forget).

## Record performance changes

`docs/perf-history.md` is the running log of every measured performance change: wins, regressions, null results and measurement fixes alike. When a PR measures a performance change (latency, frame time, memory, GPU, energy, tok/s, build or install time, binary or installer size), add an entry there in the same PR, in the format the file describes: before and after numbers quoted exactly from what you measured, the conditions, and why it moved. A performance-motivated PR that measured nothing goes under its Unmeasured list. Never estimate a number you did not measure.

## Reports and portable design artifacts

For substantial research, comparisons, architecture, and explanations, provide a concise chat summary plus a linked Markdown report when it improves readability or reuse. Include sources, assumptions, recommendations, and next steps. Use Mermaid for useful diagrams, image links for actual photos/screenshots, and self-contained HTML/CSS/SVG for rich design prototypes. Keep editable source in the project, normally reports/ or nekko-designs/; follow existing conventions. Do not generate artifacts for trivial replies. Never confuse captured evidence with inspected evidence.

General reporting behavior belongs in the shared system prompt, not a personal memory file. Repository-specific workflow belongs here. Preview changes must retain explicit user consent for local reads, isolate generated HTML from the app, and prevent silent external resource fetching.

## Keep this file short

This file costs tokens on every turn of every agent. Add a rule here only when it applies to most changes; put a procedure in `docs/runbooks/` and a one-line pointer in the table above, and guidance for one part of the tree in an `AGENTS.md` inside that folder.
