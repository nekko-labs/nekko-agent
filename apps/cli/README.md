# Nekko Agent CLI + MCP server (`nekko-agent`)

Drive your local Nekko Agent agent from the terminal, or expose it to other tools
(Claude Code, Codex, any MCP client) so they can trigger agents, make chat
requests, spin up sessions, and read status. Runs the same engine (`createHost`)
in-process against your data dir.

Current published installation:

```bash
npm install -g nekko-agent   # publishing with the next release
nekko-agent status
```

The package name is **`nekko-agent`**. It has not reached the registry yet: the
v0.7.0 release is blocked on macOS signing (see [TASKS.md](../../TASKS.md)) and
the publish step runs only once the whole matrix passes. Until then, run it
from a source checkout (below).

The package installs a single executable: `nekko-agent`.

From a checkout:

```bash
npm run build --workspace=apps/cli
node apps/cli/dist/index.js status        # or: npm link, then `nekko-agent status`
```

### Where it connects

- **Local (default)**: runs the engine in-process against a data dir: `~/.nekko`
  (shared with the web/Docker edition). Set `NEKKO_DATA_DIR` to the desktop app's
  dir to share that instead (`%APPDATA%/Nekko Agent/nekko-agent` on Windows,
  `~/Library/Application Support/Nekko Agent/nekko-agent` on macOS).
- **Remote**: pass `--url http://host:1440` (or `NEKKO_URL`) to talk to a
  **running** Nekko Agent (formerly Nekko Agent) server over HTTP+WS, your live instance, a Docker
  container, or another machine. Add `--token` (or `NEKKO_TOKEN`) if it's secured.

Add `--json` to `status`/`sessions` for machine-readable output.

## CLI

```bash
nekko-agent status                          # providers, model, workspaces, sessions, relay
nekko-agent sessions                        # list chats
nekko-agent chat "summarize README.md" \    # run an agent turn (streams the reply)
  --workspace <id> --new
nekko-agent chat "and now add tests" --session <id>
```

`chat` defaults to guardrails approval. Use `--approve yolo` only when you
explicitly want unattended tool approval.

## MCP server

```bash
nekko-agent mcp        # JSON-RPC 2.0 over stdio
```

Register it in **Claude Code**:

```bash
claude mcp add nekko-agent -- nekko-agent mcp
# (or once published/linked: claude mcp add nekko-agent -- nekko-agent mcp)
```

Or in any MCP client config:

```json
{ "mcpServers": { "nekko-agent": { "command": "nekko-agent", "args": ["mcp"] } } }
```

### Tools exposed

Discovery lists canonical `nekko-agent_*` names only. Existing MCP configurations
using the `nekko-agent` executable and calls to the corresponding `nekko-agent_*` tool
names remain supported, with the same arguments and results. Environment
variables, data directories, `nekko-agent/run` imports, and the `nekko-agent` skill
installation target are unchanged.

| Tool | What |
| --- | --- |
| `nekko-agent_chat` | Run an agent turn (reads/edits/runs in your workspace); returns the reply. Omit `sessionId` to start fresh. |
| `nekko-agent_list_sessions` | List sessions. |
| `nekko-agent_new_session` | Create a session, returns its id. |
| `nekko-agent_get_session` | Get a transcript. |
| `nekko-agent_status` | Providers, default model, workspaces, session count, relay status. |
| `nekko-agent_train_start` | Start a **training run**: a local data-scientist agent benchmarks candidates, fine-tunes, evaluates, and reports experiments with scores. |
| `nekko-agent_train_status` | Experiment tree + leader for one run (or a summary of all runs). |
| `nekko-agent_train_hint` | Queue guidance the agent folds into its next experiments. |
| `nekko-agent_train_stop` | Stop a run. |
| `nekko-agent_local_status` | Built-in engine and local runtimes: running, loaded models, memory. |
| `nekko-agent_local_models` | Downloaded models, with size, quantization, loaded state and GPU fit. |
| `nekko-agent_model_search` | Find GGUF models on Hugging Face. |
| `nekko-agent_model_download` | Download a model (returns a job id); `nekko-agent_downloads` / `nekko-agent_download_cancel` follow it. |
| `nekko-agent_model_load` / `nekko-agent_model_unload` | Run or free a local model; load starts the engine if needed. |
| `nekko-agent_runtime_start` / `nekko-agent_runtime_stop` | Start or stop the engine (or Ollama/LM Studio via `providerId`). |

So an MCP client can say "run this model": load it (downloading first if
needed), then pass the returned `provider` and `model` to `nekko-agent_chat`.
The same operations are in the CLI as `nekko-agent local status|list|search|download|downloads|cancel|load|unload|start|stop`.

So an MCP client can say "train me a model for X": start a run whose goal is
to benchmark existing models for X (reported as scored experiments, i.e. the
recommendation step) and then fine-tune to beat the best of them.

**Swarms**: call `nekko-agent_new_session` a few times and fan out `nekko-agent_chat`
across the session ids, each is an independent agent driving your local model.
