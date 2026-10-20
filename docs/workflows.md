# Workflows: models and unattended runs

A workflow runs with nobody watching it: on a schedule, from a git event, a
connector poll or a webhook. These settings, under **Runs** in the workflow
editor, decide which model it uses and what its agent steps may do.

## Model

- **Model** sets the model for every prompt and skill step. Left on
  **Default model**, steps use the model chosen in Models.
- Each prompt or skill step can override it. **Use workflow model** is the
  default. The step graph names a step's model when the step overrides it.
- Auto is not offered: a run has to know its model before it starts.

## Local models only

With **Local models only** on:

- A step runs only on a model server on this computer: the Nekko engine,
  Ollama, LM Studio, vLLM or llama.cpp (or an OpenAI-compatible server) on a
  loopback address (`localhost`, `127.x.x.x`, `[::1]`).
- Any other model is refused with *This workflow uses local models only;
  &lt;provider&gt; is not local.* and the step fails. The run never falls back
  to another model, including your default.
- The run's chat is offline, so there are no internet tools (`fetch_url`,
  browser), no MCP servers and no connector context.
- Action steps still run: they are the host calling GitHub, Slack and so on
  with your connector, not tools the model calls.

The editor only lists local providers in the picker, and warns when a step or
your default model is not local.

## Tool access

| Setting | Prompt and skill steps can |
| --- | --- |
| None | Use no tools. Answers come from the prompt and context. |
| Read files | Read, search and list files in the workspace. |
| Allowlist | Use only the tools each step lists. |
| Full workspace | Use every tool, under your default chat mode. The default, and what existing workflows use. |

Shell steps and action steps you write in the editor are not agent tools; they
run under every setting.

### Allowlists

Under **Allowlist**, each prompt or skill step lists its tools in Claude Code's
allowed-tools syntax:

```
Read, Grep, Glob, Bash(gh pr view:*), Bash(git diff:*)
```

- `Read`, `Write`, `Edit`, `Glob`, `Grep`, `LS`, `WebFetch` name the matching
  tools; `Bash` allows any command and `Bash(prefix:*)` commands that start
  with those words; `Bash(npm test)` allows exactly that command.
- A listed tool runs without asking. Anything else is denied.
- Commands are matched by their words, not as text: chaining (`&&`, `;`, `|`),
  substitution (`` ` ``, `$()`, any `$`), redirection and subshells never
  match, even when the command starts with an allowed prefix.
- `gh` is limited to `pr view`, `pr diff`, `pr checks`, `repo view`, and
  `api` reads (no `-X`/`--method` other than GET, no `-f`, `-F`, `--field`,
  `--raw-field` or `--input`). `git` is limited to `diff`, `log`, `show`,
  `status`, `rev-parse` and `fetch`. Posting goes through action steps.

## Approvals are denied automatically

Nobody is there to click Approve, so a run never waits for one. A tool call
that would need approval under the chat mode is refused at once and the step
sees:

```
Denied: unattended automation run (write_file: Write /path/to/file)
```

The refusal is in the step's transcript and the agent carries on. Runs never
offer `ask_user` either. This applies to every workflow, including ones made
before these settings existed; nothing else about them changes.

## Skill steps

A skill step runs a skill as one step of the run. The editor's picker groups
every skill this computer has, in the order a name is resolved (the first of a
name wins):

| Group | Where it comes from |
| --- | --- |
| Built-in | Nekko Agent's own skills (`review`, `plan`, `test`…). |
| Installed | Skills installed into Nekko Agent from the Skills tab. |
| Claude Code skills | `SKILL.md` folders under `~/.claude/skills`, `~/.codex/skills`, `~/.gemini/skills`, `~/.agents/skills`, and the same folders in your projects. |
| Plugins | Skills and commands of the Claude Code plugins you have enabled, named `<plugin>:<name>` (for example `nyaa:cr`). |

### Claude Code plugins

Nekko Agent reads the plugins Claude Code has installed; it never installs,
updates or changes one.

- A plugin counts when `~/.claude/settings.json` turns it on under
  `enabledPlugins` (`"nyaa@nekko-labs": true`).
- Its files are read from `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`.
  With several versions installed, the one whose `.claude-plugin/plugin.json`
  has the highest `version` is used.
- `skills/<name>/SKILL.md` becomes `<plugin>:<name>`, and so does
  `commands/<name>.md`. A skill wins over a command of the same name.
- A file larger than 256 KB is skipped, as is a name with characters other
  than letters, digits, `.`, `_` and `-`. A link that points out of the
  plugin's folder is not followed.

### Arguments

**Arguments** fill the skill's `$ARGUMENTS`, and `$1` to `$9` word by word
(quotes keep words together), as Claude Code fills a command's. They can use
templates, so `{{trigger.number}}` hands a PR-triggered skill its PR number. A
skill with no `$ARGUMENTS` gets them on an `ARGUMENTS:` line after its text.
A plugin skill's `${CLAUDE_PLUGIN_ROOT}` becomes its plugin folder, and its
frontmatter is not sent to the model.

### Tools and the skill's folder

- Under **Allowlist** access, a skill step with no allowed tools of its own
  uses the skill's `allowed-tools`. The editor shows them; list fewer to
  narrow them. The usual limits still apply: `gh` and `git` stay reads.
- The run can read the skill's own folder (a plugin's whole folder), so the
  references and scripts it ships are there, even when the workspace jail is
  on. Nothing in that folder can be written or edited.

## Pull request checkouts

With **Check out the pull request** on (`prCheckout`), a run started by a
GitHub `pr_opened` or `pr_updated` event works on the PR's own code:

- The workflow's project folder must be a clone of the repository, with
  `origin` on GitHub. The run fetches `pull/<number>/head` from `origin` into a
  ref of its own and checks it out as a detached Git worktree under the app's
  data folder (`workflow-checkouts/<run>`).
- Your checkout is never touched: no branch switch, no stash, no changed file.
- The worktree and its ref are removed when the run ends, whether it
  succeeded, failed or was cancelled. Ones left by a crash are removed the next
  time the app starts.
- A PR whose head cannot be fetched fails the run before any step.

### Untrusted pull requests

A PR is trusted when its head branch is in the same repository and GitHub
marks its author `OWNER`, `MEMBER` or `COLLABORATOR`. Anything else, a fork or
an outside contributor, is untrusted, and its run never executes the PR's code:

- Prompt and skill steps keep only `Read`, `Grep`, `Glob`, `LS` and `gh`/`git`
  commands (which are reads). Package managers, build tools, linters, test
  runners, scripts, writes, the web and MCP are dropped, from the step's own
  list or the skill's `allowed-tools`.
- Under **Full workspace** access the run is held to a read-only allowlist of
  the same kind.
- The step is told those checks are unavailable, so a review reports
  *lint/audit skipped: untrusted PR* instead of failing.

Shell steps you write are not agent tools: they run as written for every PR,
so keep them out of a workflow that reviews other people's PRs.
