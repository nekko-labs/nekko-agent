---
status: accepted
date: 2026-10-22
---

# 0001. Split SPEC.md into feature files, AGENTS.md into rules and runbooks

## Context

By October 2026 `SPEC.md` was about 720 KB in one file and `TASKS.md` about 770 KB. Every feature PR, often several agents in parallel, edited the same `SPEC.md`, so PRs conflicted with each other in the merge queue, and new sections were pasted wherever an agent happened to look (some landed inside the file's frontmatter). No agent could read the spec whole: it is several times larger than a model's useful context, and research on context files ("Evaluating AGENTS.md", ETH Zurich, ICLR 2026; Chroma's "Context Rot", 2025) finds that loading instructions a task does not need lowers success and raises cost. `AGENTS.md`, loaded on every turn, had grown to about 19 KB of procedures most turns never use.

The research behind this choice, with sources, is in [reports/agent-knowledge-layout.md](../../reports/agent-knowledge-layout.md).

## Options considered

1. **Keep one SPEC.md, add a table of contents.** Cheapest. Does nothing for merge conflicts or for what an agent has to load.
2. **Spec Kit layout** (`specs/NNN-feature/{spec,plan,tasks}.md`, a constitution). Good for new features, but organizes by *when* a feature was built, so the current behavior of an area is spread over many folders.
3. **OpenSpec layout** (`openspec/specs/<capability>/spec.md` as current truth, `openspec/changes/<id>/` for proposals with delta specs, archived on merge). The closest fit for a large existing product, but it brings a tool and a requirement grammar (SHALL, scenarios) that our prose sections do not follow yet.
4. **Feature files by area, generated index** (`spec/<area>/<feature>.md`, `spec/README.md`), plus runbooks and decision records. The current-behavior half of OpenSpec without its tooling; per-feature files are what parallel PRs need, and the index is the small always-readable map.

## Decision

Option 4. `scripts/split-spec.mjs` split SPEC.md mechanically (one file per top-level section, and per `###` under the "User Journeys" and "Feature Set" containers), rewrote every `SPEC.md#anchor` link to the new file, and left `SPEC.md` as a pointer. `scripts/spec-index.mjs` regenerates the index from each file's `title`/`area` frontmatter and `npm test` fails on a stale one. `AGENTS.md` keeps the rules that apply to most changes and a map; the long procedures moved verbatim into `docs/runbooks/`. Decisions get records here.

## Consequences

- Two PRs touching different features no longer conflict on the spec. Each feature file is small enough to read whole (a few are still 40-70 KB and should be split further when next edited: `chat/chat-cowork-unified-surface.md`, `phone/native-ios-app.md`, `phone/native-android-app.md`, `agents/agent-activity-and-panel-polish.md`).
- An in-flight branch that edited `SPEC.md` conflicts once with the pointer: move its edit into the feature file (or rerun `node scripts/split-spec.mjs` on main's old `SPEC.md` before merging, which is how this PR was produced).
- The area assignment is heuristic (the rules are in `split-spec.mjs`); moving a file between areas is a rename plus `node scripts/spec-index.mjs`.
- Not done yet: `TASKS.md` stays one file. The next step is OpenSpec's other half: in-flight work as `changes/<id>/` folders that archive on merge, with "Part 1, Plan" moving to `docs/architecture/` and its "Key Technical Decisions" into this folder.
