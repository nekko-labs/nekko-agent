---
status: accepted
date: 2026-11-13
---

# 0090. A design is versioned as files beside it, and is a different output from a report

## Context

[Decision 0089](0089-designs-are-files-in-the-projects-designs-folder.md) made a design
an ordinary file in the project's `nekko-designs/` folder. Three things were left open
(#2690):

- The prompt still offered "reports/ or nekko-designs/", so designs kept landing in
  `reports/`, and no rule told a model whether an HTML page it was writing was a report
  or a design.
- "Revise a design by editing its file" loses the version the person already looked at.
  Only the Design board kept earlier HTML, in the app's own store, where no agent and no
  other tool can see it.
- Claude Code chats run on Claude Code's own prompt and were told nothing.

The rule has to be one any model can follow from a sentence, with file tools only.

## Options considered

1. **New file per version, numbered** (`checkout-design-v2.html`). Models already do this
   unprompted. Every version is a real file any tool can open, diff or delete; it needs
   no git and no app. Costs: the folder fills up, and "which is current" is a naming
   rule, not a fact.
2. **Edit in place, history kept by the app.** One file, no clutter. The history is only
   in Nekko Agent, only for designs the Design board has loaded, and invisible to agents.
3. **Edit in place, history in git.** Correct for people who commit every step. Agents
   rarely commit mid-design, many projects are not repositories, and a viewer would
   need git to show a version.
4. **Versions inside the file** (a frame or section per version). One file, and the
   versions sit side by side. Files grow without bound, a model has to rewrite the whole
   file to add one, and an old version cannot be opened alone.
5. **A folder per design** (`checkout/v1.html`, `checkout/v2.html`). Clean, and room for
   assets. One more level for a model to get wrong, and a single-file design becomes a
   folder for no reason.

For telling Claude Code chats: a note on each message behind the existing `context_note`
policy row, a bridge tool, or only the project's own instruction file.

## Decision

Option 1. A design the person has seen is changed by saving a new version beside it,
`<name>-v2.html`, then `-v3`; the highest number is current, and a file without a number
is version 1. A file is edited in place only while it is still being made.

A report and a design are named as different outputs in the same rule: a report is a
document to read and goes in `reports/`; a design is something to look at and build from,
one self-contained HTML file in `nekko-designs/` laid out as a canvas of labelled frames.

Claude Code chats get the two rules as a note on every message where `context_note` is
enabled, and nothing where it is not. On a Claude plan the rules come from the project's
own instruction file. No new policy row and no way around the existing one.

## Consequences

- Any model, on any harness, can version a design with the tools it has, and Library can
  group the versions from file names alone.
- Old versions stay until someone deletes them. A project that commits designs commits
  every version.
- The Design board shows each version file as a card until it learns the grouping.
- People on a Claude plan depend on their project's instructions. An in-app way to write
  the rules into that file is the next step if this proves to be a gap.
- This naming rule is the first piece of what an open design-file format would have to
  say. If one is published, it supersedes this record.
