---
title: "Automating repeatable work (Workflows tab)"
area: automation
split-from: SPEC.md (2026-10-22)
---

# Automating repeatable work (Workflows tab)

Some work isn't a conversation, it's a **procedure that should run the same way every time**, often without anyone watching. The **Workflows** tab is that surface, modelled on GitHub Actions but with the steps a coding agent actually needs: a step is an **agent prompt**, an installed **skill**, another **workflow**, or a **shell command**.

The part that makes it more than a script runner is that steps are **routed rather than merely sequenced**. Every step declares where the run goes when it succeeds and when it fails, and a route can point **back at an earlier step**, so the natural shape of real work is expressible: build, then verify, and when verify finds problems, go back to build and try again. Loops are bounded (a step can be re-entered a fixed number of times) so a workflow that never converges still stops and says so, rather than running forever. Steps also carry **retries**, a **timeout**, and a **continue-on-error** flag. Agent steps report their own outcome with a PASS/FAIL token, which is what lets an agent step be routed the way a shell step's exit code is; a run's agent steps all share one chat session, so a verify step sees what the build step actually did.

A workflow starts from whatever fires it: **by hand**, on a **schedule** (a cron expression or a plain interval), from the **CLI** (`nekko-agent workflow run <name>`, or `trigger <command>` to fire everything listening for it), from **Slack** (a channel, optionally filtered to messages containing a word), or from a **git provider event**, a pull request opened, updated, closed, merged, commented on or reviewed, a push, a tag, an issue, filtered by repo and branch. Provider events are **normalized across GitHub, GitLab, Bitbucket and other**, so a workflow reacts to "a PR opened" without caring whose vocabulary it was. One workflow can carry several triggers.

The tab is built for an install that accumulates **hundreds** of these, and written for people who have never made one. A collapsible **How workflows work** strip defines the vocabulary in place: an automation is the whole thing (steps plus triggers), a manual trigger is the Run button or the CLI (every workflow can run by hand even with its other triggers off), a scheduled job is a cron or interval trigger, and event triggers are a pull request, a Slack message, a connector poll, or a webhook. A left rail filters by search (which reaches into step bodies, not just names), enabled state, category, and trigger kind, and the trigger filter is grouped by family (**you start it**: manual, CLI; **on a schedule**; **on an event**), with each kind carrying its own explanation. The list groups either **by category** ("what do I have?") or **by trigger** ("what happens when a PR opens?"), with a workflow appearing under every event it listens for. A row shows its state, step count, triggers, and how the last run went; expanding it reveals the **step canvas**, a node graph in the same visual language as the Skills tab, where failure routes are drawn in the danger color and a loop back to an earlier step dips under the row, so a retry loop is something you see rather than something you read. The same canvas doubles as the live run view, each node wearing that run's outcome, beside the attempt-by-attempt run log (with a link into any step's transcript) and that workflow's run history. Workflows are created either **from a ready-made template** (see "Template gallery" under Workflows below), **from an example** of a pattern (a build/verify loop, a local CI runner), or **from scratch**, and the picker presents those as visibly different starting points rather than one undifferentiated list; the editor's canvas redraws as you type and flags steps nothing routes to and validates a cron expression against its next fire. Workflows can be duplicated, enabled/disabled, and deleted.


## Guided first workflow

Implemented in the shared desktop and responsive phone-width Workflows tab: once
an empty workflow snapshot has loaded, show an interactive first-workflow wizard
instead of the filter rail and empty template list. Loading and load errors are
not treated as an empty account. Existing workflows retain the normal list and
filters; a filtered-to-empty list never shows onboarding.

The guide has three stages: choose an idea, personalize its target, and review
and create in the existing workflow editor. Expandable categories cover Shopping
& web browsing, Developer, Research, and Email & productivity. Starter ideas
include stock checks, web-page updates, new GitHub PR reviews, project health,
research briefings, and email summaries. Each explains the services or tools it
needs. A back action preserves the selected category; templates and blank setup
remain available without completing the guide. Desktop and narrow widths use the
same wizard and stack cards into one column on phones.

The introduction, category panels, and selected-example setup contain clearly
labeled video placeholders for Travis. Producing and hosting the videos is
planned work, not implemented playback. There are no external embeds or requests.

Selecting an example or continuing only prepares an editable draft. Targets stay
local until the user explicitly creates the workflow. Every starter initially has
one manual trigger; scheduled execution and automatic new-PR reviews require the
user to configure and confirm schedule/event triggers in the editor. Creating a
manual workflow does not run it. Models, connectors, tools, and permissions must
be configured before useful execution; this guide does not connect accounts or
promise an integration exists. Starter instructions ask for read-only reports,
but prompts are not a security boundary and the editor's tool settings remain
the actual access control. No purchases, outgoing email, or posted reviews are
requested by starters.

Acceptance: categories expand with native keyboard-accessible disclosure;
choosing an example shows requirements and an editable target; blank/invalid web
URLs cannot continue; Back returns to ideas; Continue opens an editor seeded
with the target and manual trigger without calling create/run APIs. Before/after
renderer evidence covers desktop and 390px phone width. Real scheduled runs,
connector authorization, native-app onboarding, and completed videos are outside
this change's verification scope.
