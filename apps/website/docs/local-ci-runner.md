# Local CI runner

Use a machine running Nekko Agent as a CI runner for a GitHub or GitLab repo: when a commit is
pushed or a pull request opens, a workflow checks the code out, runs your build and tests **on
that machine**, and reports the result back to the provider as a commit status - with a comment
on the PR when it fails. It saves hosted-runner minutes by burning your own hardware instead.

## What it is - and what it is not

A "Local CI runner" is a **workflow template**, not a new subsystem. Create it from
**Workflows → New workflow → Local CI runner** (it's also one of the cards on the empty state).
Behind the scenes it is ordinary workflow pieces you already have:

- a **trigger** that fires on repo events (see [Getting events in](#getting-events-in)),
- **shell steps** that check out the commit and run your build/test commands,
- **action steps** (`github.setCommitStatus`, `gitlab.setCommitStatus`, `github.commentPR`,
  `gitlab.commentMR`) that report the outcome back through the saved connector credentials.

**This is not a GitHub Actions self-hosted runner.** Nekko Agent does not speak the
`actions/runner` broker protocol, will not pick up `runs-on: self-hosted` jobs, and does not use
the Checks API (no annotations, no check-suite lifecycle). It produces a plain **commit status**
(`nekko-agent/<workflow>` context) and PR comments - enough for "did this commit pass on my
machine", not a replacement for the Actions job queue. If you need real self-hosted runners, use
GitHub's or GitLab's official runner.

## The template

The workflow looks like this:

```
checkout (shell)  ──fail──▶  report failure (action)  ──▶  comment on PR (action) ──▶ fail
    │
  success
    ▼
build + test (shell) ──success──▶ report success (action) ──▶ end
```

- **Check out the commit** - `git fetch origin {{trigger.branch}} && git checkout {{trigger.sha}}`
- **Build and test** - `npm ci && npm run build && npm test`
- **Report success / failure** - `github.setCommitStatus` with context
  `nekko-agent/<your-workflow-name>` (the default when the `context` param is empty)
- **Comment on the PR** - `github.commentPR` with the tail of the test step's output.
  On plain `push` events there is no PR number, so this step fails and the run still ends red.

**The two shell steps are placeholders.** Edit them for your project - your package manager,
your test command, your merge strategy. The action steps are ready as-is: they take repo, sha,
and PR number from the event when the `{{trigger.*}}` params render empty.

For GitLab, swap the action steps for `gitlab.setCommitStatus` (state `failed`/`success`,
status name `nekko-agent/<workflow>`) and `gitlab.commentMR`.

## Getting events in

A run only happens when an event reaches the workflow. Pick **one** delivery mode per workflow ,
arming two means double runs.

### Poll mode - works anywhere, including the desktop app

The desktop app can't receive real webhooks (it's behind NAT), so the honest default is polling:
Nekko Agent asks the provider's API what's new, on an interval, with a per-trigger cursor stored
in `workflow-cursors.json` next to `workflows.json`.

The template ships a disarmed **Connector** trigger as the starter:

1. Connect GitHub (or GitLab) under **Connectors** - the poller uses that token.
2. On the workflow's Connector trigger: set **Repo** to `owner/name`, set the event name, arm it.
   - GitHub event names are the API's `type` strings: `PushEvent`, `PullRequestEvent`,
     `PullRequestReviewEvent`, … One trigger matches one name, so add a second trigger for PRs.
   - GitLab polls the project events feed; filter with the **Filter** substring field.
3. **Poll every N minutes** defaults to 1. Each new matching event starts a run; a late or
   duplicated page can't refire (events are deduped by id, and the cursor survives restarts).

Polling is eventually-consistent by design: expect up to a poll interval of latency, and note
that repo events APIs are shallow (recent events only).

### Webhook mode - server / Docker edition

When Nekko Agent runs somewhere a provider can reach (the server edition, Docker, a VM with a
public URL), inbound webhooks give instant triggers:

```
POST https://<your-host>/api/hooks/<workflow-slug>?key=<trigger secret>
```

The template ships a disarmed **Webhook** trigger with a generated secret. Arm it, copy the URL
shown in the editor, and add it as a webhook on the repo (GitHub: repo → Settings → Webhooks,
content type `application/json`; GitLab: project → Settings → Webhooks).

- The secret is **per trigger** and travels in `?key=` (or you can relay it). It's compared in
  constant time and never logged. Regenerate it in the editor if it leaks.
- The route enforces a 10 MB body cap and a 60-requests/minute limit per slug+IP.
- The raw provider JSON body becomes the event payload - the action steps understand the common
  shapes (`repository.full_name`, `pull_request.head.sha`, `object_attributes.iid`, …), so the
  template's status/comment steps work without a normalizing layer.
- A `webhook` trigger fires on *any* authenticated POST. Use the trigger's **Filter** field, or
  the git trigger below, if you want to restrict which deliveries start a run.

**Desktop opt-in:** the desktop app can expose the same route on loopback ,
Settings → Experimental → workflow loopback listener binds `127.0.0.1:1441` only. Useful for
local relays and tunnels, off by default.

### Dispatching git events directly - `workflow:event`

The `git` trigger (the one the template ships armed) matches **normalized** events - provider,
event name, repo, branch - dispatched through the generic event door. On the server edition:

```
POST https://<your-host>/api/workflow:event
Authorization: Bearer <NEKKO_TOKEN>
{ "args": [{
    "kind": "git", "provider": "github", "event": "pr_opened",
    "repo": "owner/name", "branch": "feature-x",
    "payload": { "sha": "abc123…", "number": 12 }
}] }
```

This is the door a relay script uses when it sits between a provider webhook and a machine that
can't be reached directly: accept the webhook, map it onto the normalized shape, POST it on.
Inside the desktop app the same call goes over the internal API (`workflow:event`).

## The payload contract

Steps read the event through `{{trigger.*}}` templates (`repo`, `branch`, plus every payload
key) and the action steps fall back to the event when a param renders empty. These keys are
understood - normalized names first, then the raw provider body:

| Need | Normalized | Raw GitHub body | Raw GitLab body |
|---|---|---|---|
| Repo / project | `repo` | `repository.full_name` | `project.path_with_namespace`, `project_id` |
| Commit SHA | `sha` | `after`, `head_commit.id`, `pull_request.head.sha`, `head` | `checkout_sha`, `object_attributes.last_commit.id` |
| PR / MR number | `number`, `pull_number` | `number`, `pull_request.number`, `issue.number` | `iid`, `object_attributes.iid` |
| Branch | `branch` | `ref` (`refs/heads/…`) | `ref` |

Reported statuses use context `nekko-agent/<workflow-slug>` on GitHub (states
`success`/`failure`/`error`/`pending`) and the same name on GitLab (`success`/`failed`/
`running`/`pending`/`canceled`) - each op accepts the other's spelling for `state`.

## Security model, honestly stated

| Threat | Defense |
|---|---|
| A stranger's PR runs code on your machine | **None by default - this is the big one.** Shell steps run unattended, as you, in the workflow's workspace. Only point this at repos you control, or gate it (see below). |
| Webhook spoofing | Per-trigger secret in `?key=`, constant-time compare, 60 req/min rate limit, 10 MB body cap |
| Exposed endpoint | Server edition binds `127.0.0.1` by default; the desktop listener is loopback-only and off unless enabled |
| Credential theft via the workflow | Connector tokens live in settings, never on the step; a workflow file carries no secrets except its webhook keys |
| Event injects a shell command | The command line comes from your workflow, not the event - but `{{trigger.*}}` values are interpolated *before* exec, so only interpolate fields you trust (git SHAs and ref names can't contain shell metacharacters; a free-text payload field can) |

**Untrusted pull requests need review.** Anyone who can open a PR against your repo could get
their code executed on this machine. Guardrails that actually help:

- Restrict the trigger's **Repo** and **Branches** (e.g. `main`, `release/*`) so random forks
  and branches don't fire it.
- Prefer the git trigger with an explicit event list over a wide-open webhook trigger.
- For public repos, keep the runner on a dedicated workspace you don't mind being compromised,
  or add a `prompt` step that reviews the diff before the shell steps run.
- One run per workflow at a time: events that arrive while a run is in flight are skipped, not
  queued - so a push flood can't stack runs, but it can also drop builds.

## Limits

- Local execution only: runs happen on the machine hosting Nekko Agent, with its CPU, its
  toolchain, and its uptime. A closed laptop is a runner that's down.
- Shell steps time out after 600s by default (`timeoutSec` per step); step output kept in the
  run log is trimmed to ~4 KB.
- No parallelism beyond one run per workflow, no job matrix, no artifacts - it's a
  workflow engine, not a CI fleet.
