# Automations

An automation is a workflow that runs on its own: on a schedule, when something happens in a
connected app, or when you start it. They live in the **Workflows** tab. This page covers the
ready-made ones, how you hear about their runs, and how to stop them all at once. For building
your own step by step, see the Workflows tab's **How workflows work** strip; for running a repo's
CI on your machine, see [Local CI runner](git-runner.md).

## Turn on a ready-made automation

**Workflows → New workflow** opens on a gallery. An empty Workflows tab shows the same cards.

| Automation | When it runs | What it needs |
|---|---|---|
| Summarize my GitHub notifications every morning | Weekdays at a time you pick | GitHub connected, the `gh` CLI signed in, a default model |
| Review every PR I open | Each pull request you open in a repo you pick (checked every 2 minutes) | GitHub connected, the `gh` CLI signed in, a default model |
| Diagnose failed CI | Each failed GitHub Actions run in a repo you pick (checked every 2 minutes) | GitHub connected, a local model |
| Review new PRs with a skill | Each new pull request in a repo you pick (checked every 2 minutes); new commits too if you turn on its second trigger | GitHub connected, a project folder that is a clone of the repo, a model (local if you leave **Local models only** on) |
| Nightly dependency check | Every night at a time you pick | A project folder, a default model |

Each card marks what you already have. Click one to open its setup sheet:

1. **What it needs.** Anything missing has a button: **Connect** opens Connectors, **Choose a
   model** opens Models. A template that runs in a project asks which folder. One that runs on
   a local model only lists your local models to pick from (your default model, if it is local,
   is already picked); with none set up, **Set up a local model** opens Models.
2. **Its questions.** A time of day, or a repository (`owner/name`) and your GitHub username.
   Only PRs you open start a review: the trigger checks the event's author and its `opened`
   action exactly, so other people's PRs, reopened PRs and closed ones never reach the agent.
3. **Notify me.** Digests default to *After every run*; change it here or later in the editor.
4. **Turn on.** The automation is created, enabled and armed. The toast says when it runs first.

**Customize** opens the same automation in the workflow editor instead, where you can change its
steps, triggers and model before saving.

Every ready-made automation but two only reads: it summarizes or reviews, and never comments,
posts, installs or changes anything. Results land in the run history (and a notification, if you
asked for one). The exceptions are **Diagnose failed CI**, which keeps one comment on the failing
PR (see [Diagnose failed CI](git-runner.md#diagnose-failed-ci)), and **Review new PRs with a
skill**, below.

## Review new PRs with a skill

Runs a skill on every new pull request in a repo and keeps its verdict in one comment on the PR.

- **The skill.** The setup sheet picks `nyaa:cr` when the nyaa Claude Code plugin is enabled,
  else the built-in `review`; any skill a step can run is offered. It gets the PR number as its
  arguments and runs with only the tools its `allowed-tools` lists.
- **Where it runs.** On a checkout of the PR's head made for the run and removed after it; your
  own checkout is never touched. A draft PR waits until it is marked ready.
- **Untrusted PRs.** A PR from a fork, or from someone who cannot push to the repo, never runs its
  code: package managers, builds, linters and scripts are off, and the comment says
  *lint/audit skipped: untrusted PR*.
- **The comment.** Posted by an action step, not by the model: one comment per PR, marked with the
  workflow's name, with @mentions quieted and the length capped. Turn on the template's second
  trigger (*PR updated*) to re-review each new commit; the same comment is updated.
- **Model.** **Local models only** starts on when you have a local model set up; turn it off to
  use your default model.

How skills, plugins and the checkout work: [Workflows](workflows.md#skill-steps).

Digests read text other people wrote, such as notification titles or package advisories. So a
fixed command fetches it first, and the agent that summarizes it has **no tools**: it can only
write the summary, so nothing in that text can make it run a command. You can set **No tools** on
any prompt or skill step in the editor. Keep such a step last, because later steps share its
chat and see the same text.

## How a run went

Expand a workflow to see its runs. The selected run shows how long it took and when it started,
then either:

- **Failed at "step"**: the step that failed, its error, and a **Transcript** button for that
  step's chat, or
- **Result**: the last agent step's answer, which for a digest is the digest itself.

The history on the right lists the last ten runs with their status, duration, what started
them, and the step a failed run stopped at.

## Notifications

Each workflow's **Notify me** setting decides when a finished run tells you:

- **When a run fails** (the default, also for workflows made before this setting existed),
- **After every run**, for digests, or
- **Never**.

Clicking a notification opens the Workflows tab on that run. Notifications follow
**Settings → Notifications → Desktop notifications**, and stay quiet while the Workflows tab is on
screen. A run cut short because the app quit is reported as a failure the next time it starts.

Phone notifications for failed runs are not available yet.

## Pause all automations

The **Pause all automations** switch in the Workflows header is the kill switch:

- schedules, pull request and push events, Slack messages, connector polls and webhooks start no
  runs, and scheduled tasks (from a chat's **⚡ Automate** menu) wait;
- whatever is running when you switch it on is stopped;
- the **Run** button, a task's **Run now** and `nekko-agent workflow run` still work.

A schedule that came due while paused runs once when you resume. Events that arrived during the
pause are skipped, not replayed. The setting is shared, so pausing from one window or the web
edition pauses everywhere.
