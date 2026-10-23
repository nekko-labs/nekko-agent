# Nekko Agent CLI and MCP

The CLI makes the Nekko Agent host a subagent for Devin, Claude Code, Codex,
Cursor, and other harnesses. It uses the same host engine as the desktop and
Local Web UI installs.

## Install and target

Published package:

```bash
npm install --global nekko-agent   # publishing with the next release
npx nekko-agent status
```

From a checkout:

```bash
npm install
npm run build --workspace=apps/cli
node apps/cli/dist/index.js status
```

Use `nekko-agent` after a global install or linking the built package, or invoke
the bundled binary from `apps/cli/dist/index.js`. Without `--url`, the CLI talks
to the running app if there is one, else starts a private `nekkod` (the engine
daemon) against `~/.nekko` (override with `NEKKO_DATA_DIR`) and stops it when it
exits. To drive a Local Web UI,
use:

```bash
nekko-agent --url http://127.0.0.1:1440 --token "$NEKKO_TOKEN" status --json
```

`--url` can also be supplied as `NEKKO_URL`; `--token` can be supplied as
`NEKKO_TOKEN`.

## Safety and approval

Chat defaults to `--approve guardrails` (or `NEKKO_APPROVE=guardrails`).
Guardrails mode sets the session to `guardrails`: ordinary tools run, ask-rule
approvals are refused and reported as structured `blocked` entries, and the
turn continues. The result tells the harness to use `--approve yolo` when an
override is intentional.

`--approve yolo` explicitly opts into the previous unattended behavior. Deny
rules remain a hard floor in every mode. `--approve ask` prompts on the TTY;
it is an error when stdin is not a TTY.

These policies govern the agent tool loop, not every process the host can
launch. In particular, `bash` is not confined by `workspace-jail`; use the
host's deployment and workspace controls when granting an external harness
access.

## Commands

```text
status [--json]
sessions [--json]
chat "<prompt>" [--session ID] [--new] [--workspace ID] [--provider ID] [--model ID]
  [--approve guardrails|yolo|ask] [--json|--stream ndjson] [--timeout SECONDS] [--quiet]
workspace list|add PATH|remove ID|index ID|search ID QUERY [--json]
prompts [--json]
tasks list|add|run ID|delete ID [--json]
skills [--json]
skills install ID [--target nekko-agent|claude|codex] [--json]
tools [--json]
models [PROVIDER_ID] [--json]
local status|list [--json]
local search [QUERY] [--json]
local download OWNER/REPO [--quant LABEL] [--json]
local downloads [--active] | local cancel JOB_ID [--json]
local load MODEL_ID [--provider ID] [--ctx N] [--gpu-layers N] [--ttl SECONDS] [--json]
local unload MODEL_ID [--provider ID] | local start [--provider ID] | local stop [--provider ID] [--force]
train start NAME GOAL [--provider ID] [--model ID] [--workspace ID] [--json]
train status|hint ID TEXT|stop ID [--json]
watch [--session ID] [--json]
mcp
```

Prompts may be positional, piped through stdin (`nekko-agent chat -`), or loaded
from a file (`nekko-agent chat --file prompt.md`). `--quiet` suppresses human
progress on stderr.

## Machine output

`--json` emits exactly one JSON object on stdout. Chat objects have this shape:

```json
{
  "sessionId": "…",
  "provider": "…",
  "model": "…",
  "text": "…",
  "toolCalls": [{ "name": "read_file", "input": { "path": "README.md" } }],
  "blocked": [{ "ruleLabels": ["…"], "command": "…", "severity": "high", "reason": "…" }],
  "durationMs": 1234,
  "usage": { "inputTokens": 100, "outputTokens": 40 }
}
```

`--stream ndjson` emits one typed event per line:

```json
{"type":"text","delta":"Hello"}
{"type":"tool_call","call":{"name":"read_file","input":{"path":"README.md"}}}
{"type":"tool_result","toolCallId":"…","ok":true,"output":"…"}
{"type":"blocked","ruleLabels":["ask"],"command":"…","severity":"high","reason":"…"}
{"type":"done"}
```

Progress and diagnostics go to stderr. Other commands accept `--json`;
`watch --json` emits the same typed event objects as NDJSON and exits cleanly
when it receives Ctrl-C. Watch events are `text`, `tool_call`, `tool_result`,
`blocked`, `done`, and `error`; reasoning and usage-only events are omitted.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Success |
| 2 | Usage or invalid flags |
| 3 | Nothing configured (provider/model missing) |
| 4 | Guardrail-blocked tool call |
| 5 | Provider/model failure |
| 6 | Chat timeout |
| 7 | Cannot reach or unauthorized against `--url` |

## MCP

Start the JSON-RPC stdio server:

```bash
node apps/cli/dist/index.js mcp
```

Claude Code:

```bash
claude mcp add nekko-agent -- node /abs/path/nekko-agent/apps/cli/dist/index.js mcp
```

Codex:

```bash
codex mcp add nekko-agent -- node /abs/path/nekko-agent/apps/cli/dist/index.js mcp
```

Cursor and generic `mcpServers` configuration:

```json
{
  "mcpServers": {
    "nekko-agent": {
      "command": "node",
      "args": ["/abs/path/nekko-agent/apps/cli/dist/index.js", "mcp"]
    }
  }
}
```

`nekko-agent_chat` accepts the same `approve` policy as the CLI and defaults to
`guardrails`. `nekko-agent_train_start` also accepts an explicit `approve` argument;
unattended training that intentionally permits ask-rules must pass
`"approve": "yolo"`. The server negotiates MCP protocol versions, echoing a
supported client version and otherwise selecting its newest supported version.
`nekko-agent_task_create` exposes `title`, `prompt`, `kind`, `runAt`, `intervalMs`,
`workspaceId`, `providerId`, `modelId`, `condition`, and `keepAlive` directly;
`title`, `prompt`, and `kind` are required. A `nekko-agent_chat` result presents
the assistant reply first, followed by a metadata block containing session,
tool-call, blocked-entry, duration, and usage details.

The MCP tool list mirrors the CLI coverage: `nekko-agent_chat`,
`nekko-agent_list_sessions`, `nekko-agent_new_session`, `nekko-agent_get_session`,
`nekko-agent_workspace_list`, `nekko-agent_workspace_add`, `nekko-agent_workspace_remove`,
`nekko-agent_workspace_index`, `nekko-agent_workspace_search`,
`nekko-agent_prompts_list`, `nekko-agent_tasks_list`, `nekko-agent_task_create`,
`nekko-agent_task_run`, `nekko-agent_task_delete`, `nekko-agent_skills_list`,
`nekko-agent_skill_install`, `nekko-agent_tools_list`, `nekko-agent_models_list`,
`nekko-agent_train_start`, `nekko-agent_train_status`, `nekko-agent_train_hint`,
`nekko-agent_train_stop`, `nekko-agent_status`, and the local-model tools below.

### Local models

An MCP client can run a model on this machine without opening the app: check
what is installed and loaded, download a model, load it, send it work through
`nekko-agent_chat`, and unload it again. The CLI's `local` command does the same
from a terminal.

| Tool | CLI | What it does |
| --- | --- | --- |
| `nekko-agent_local_status` | `local status` | The built-in engine (installed, running, loaded models, memory budget) and every enabled local runtime (Ollama, LM Studio, vLLM). |
| `nekko-agent_local_models` | `local list` | Models in the engine library: id, size, quantization, loaded, and whether it fits on the GPU (`full`, `partial`, `cpu`, `wont`). |
| `nekko-agent_model_search` | `local search` | Hugging Face GGUF repos the engine can download (the curated list with no query). |
| `nekko-agent_model_download` | `local download` | Start downloading one quantization; `Q4_K_M` (or the closest) when none is named. Returns a job id at once. |
| `nekko-agent_downloads` | `local downloads` | Progress of each download: state, percent, size, ETA. |
| `nekko-agent_download_cancel` | `local cancel` | Cancel a download. |
| `nekko-agent_model_load` | `local load` | Load a model; the engine starts itself if it is not running. Returns the `provider` and `model` to pass to `nekko-agent_chat`. |
| `nekko-agent_model_unload` | `local unload` | Unload a model to free memory. |
| `nekko-agent_runtime_start` | `local start` | Start the engine, or a runtime named by `providerId`. |
| `nekko-agent_runtime_stop` | `local stop` | Stop it. A server Nekko Agent did not start is refused with `needsConfirmation`; ask before retrying with `force`. |

Every tool targets the built-in engine unless it is given a `providerId` (CLI
`--provider`) for another local runtime; cloud providers are refused. Download,
load and stop are the same operations as the Model Server page and follow its
rules: a download is several GB more often than not, so compare its size with
the memory budget in `local_status` first.

Who keeps the model running depends on whether the app is open. With the app
serving, the engine is the app's and a loaded model stays loaded after the CLI
or MCP client exits. Without the app, `nekko-agent mcp` runs the engine itself
for the length of its session and stops it when the client disconnects, so no
model server is left behind. The one-shot `local load` and `local start`
commands need the app for that reason, and an in-process `local download` waits
until the files have landed.

A typical hand-off from Claude Code: "run qwen3 4B locally and have it review
this file" becomes `nekko-agent_local_models` (or `model_search` and
`model_download`, polling `nekko-agent_downloads`), then `nekko-agent_model_load`,
then `nekko-agent_chat` with the returned `provider` and `model`. A chat turn
carries the agent's system prompt and tool list, several thousand tokens, so a
model loaded with a very small `contextTokens` cannot answer one; leave it unset
for the engine default.

## Recipes

### Drive a repeated workflow

```bash
nekko-agent tasks add --title "daily review" --kind recurring \
  --interval-ms 86400000 --prompt "Review the current workspace diff and summarize risks" \
  --workspace "$WORKSPACE_ID" --provider "$PROVIDER" --model "$MODEL" --json
nekko-agent tasks list --json
nekko-agent tasks run TASK_ID --json
```

### Fan out several sessions

```bash
nekko-agent chat "Review security" --new --workspace "$W" --json > security.json &
nekko-agent chat "Review tests" --new --workspace "$W" --json > tests.json &
nekko-agent chat "Review API design" --new --workspace "$W" --json > api.json &
wait
```

### Hand off training and poll it

```bash
nekko-agent train start "ranking-v1" "Improve ranking accuracy" \
  --workspace "$W" --provider "$PROVIDER" --model "$MODEL" --json
nekko-agent train status --json
nekko-agent train hint RUN_ID "Try a larger validation split" --json
nekko-agent train stop RUN_ID --json
```

### Run a local model from a script

```bash
nekko-agent local status --json
nekko-agent local download unsloth/Qwen3-4B-GGUF --quant Q4_K_M --json
nekko-agent local downloads --active --json   # poll until done
nekko-agent local list --json                  # find the model id
nekko-agent local load "$MODEL_ID" --json
nekko-agent chat "Summarize README.md" --provider nekko-engine --model "$MODEL_ID" --new --json
nekko-agent local unload "$MODEL_ID" --json
```
