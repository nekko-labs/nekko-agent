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
