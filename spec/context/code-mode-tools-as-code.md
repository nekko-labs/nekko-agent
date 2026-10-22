---
title: "Code mode: a chat's tools as code (2026-10-22)"
area: context
---

# Code mode: a chat's tools as code (2026-10-22)

`[implemented 2026-10-22: the daemon engine, the Mode panel choice, Local only on by default, and the savings on each reply's stats line. nekko-codemode unit tests, the store golden set, shared and renderer tests, and an end-to-end daemon turn pass. Not yet run with a live model in the desktop app; not in the phone allowlist; Hypergate's own code-mode endpoint is planned]`

**User intent:** Cloudflare's *Code Mode* (2025, and on by default for its MCP portals since 2026-03) and Anthropic's *code execution with MCP* showed that a model does better, on far fewer tokens, when it writes code against typed tool bindings than when it is handed every tool definition and calls each tool itself. Philip wants that in Nekko Agent as a choice next to the tool list, marked new with a link that explains it; wants each reply to say how many tokens it saved; wants it on by default for the Local only mode, where small local models suffer most from long tool lists; and wants Hypergate to offer the same thing to any harness, not only Nekko Agent.

**What ships:**

- **A per-chat setting**, `Session.toolApproach`: `list` (the default when unset) or `code`. It is a user field like `memory` and `guidance`: set with `setSessionOptions`, kept across a running turn, copied by fork, inherited by `spawn_agent` children, and stored in a saved mode (`SavedModeOptions.toolApproach`; a mode without it matches any value and leaves the chat's as it is).
- **The Mode panel**: the Tools flyout opens with *How tools reach the model*, two options as radio rows: **Tool list** and **Code mode** with a **New** badge, then a *What's code mode, and what does it save?* link to [nekkoagent.com/docs/code-mode](../../docs/code-mode.md). The Tools row reads `N of M on · code mode` while it is on. A sandbox chat keeps the tool list (the options are disabled and say why).
- **Local only starts in code mode**: the starter gains `toolApproach: 'code'` (shared `STARTER_MODES` and nekko-store's copy, held equal by the create golden set). Its rail summary reads *worktree · local models · code mode*. An offline chat that still uses the tool list now reads as changed from Local only. The other starters set no approach.
- **The engine** (nekkod `turns.rs`, crate `nekko-codemode`): in a code-mode turn the tool list is split. The tools that talk to the user or change the chat itself (`ask_user`, `update_plan`, `set_chat_title`, `complete_session`, `spawn_agent`, `delegation_targets`, the goal-run reports) stay direct. Every other tool the chat would have been offered, MCP tools included, goes behind two new tools:
  - `search_tools({ query, limit })` returns the matching tools as TypeScript declarations (`tools.grep(input: { pattern: string; path?: string }): Promise<string>;`), built from their JSON Schemas;
  - `run_code({ code })` runs the model's JavaScript as the body of an async function in an embedded QuickJS sandbox, where each tool is `await tools.<name>(input)`. Results are strings; a failed call throws a `ToolError`. Only the return value (JSON-encoded unless a string) and `console.log` lines go back to the model. `run_code`'s description carries a one-line index of the tools (first sentence each, or names only once that index would pass about 1,200 tokens).
  The system prompt is built from the full tool set, so instructions tied to a tool behind `run_code` (agent watches) still apply.
- **Savings on each reply**: the turn keeps a tally and puts it on the reply's stats as `turnStats.codeMode`. The stats line under the reply adds *≈14k saved by code mode*. Hovering it shows the breakdown: definitions not sent (the wrapped tools' definitions less the two code-mode tools', times the reply's model calls), tool results and arguments kept out of the context (less what the scripts returned), and the cost of `search_tools` output. A reply where code mode came out behind shows nothing on the line, and its hover says how much more it cost. All figures are estimates at about 4 characters a token, the app's `estimateTokens` rule, not provider counts.

**Security and privacy boundary:**

- The sandbox is a bare QuickJS context: no module loader, no `std`/`os` modules, no `fetch`, no timers, no filesystem, no environment. The only way out is a tool the chat already has. `tools` is frozen and the host bridge is removed from the global scope before the model's code runs.
- Every call a script makes runs as `<run_code id>.<n>` through the same path as a direct call: the chat's tool switches, the unattended policy, hooks, guardrails and approvals. In Ask mode each call asks on its own. Code mode grants nothing a direct call would not.
- A run stops at 300 seconds (tool calls included), on the chat's Stop, past 64 MB of memory or 1 MB of stack, or after 100 tool calls. Its output is cut at 40,000 characters.
- Calls run one at a time. `Promise.all` works but does not parallelize.
- Nothing about the sandbox reaches a provider beyond what the model writes and the script returns. Privacy Shield still applies to the model client as before.

**Acceptance:** a chat set to code mode offers `search_tools` and `run_code` in place of its other tools; a script can loop over tool calls and return only a summary; each nested call is approved like a direct one; Stop interrupts a running script; the reply's stats carry `codeMode`; Local only applies `toolApproach: 'code'`; a sandbox chat is unaffected.

**Verified:** nekko-codemode unit tests (declarations from schemas, the index, search ranking, the tally, the sandbox's isolation, errors, console, the timeout, Stop, memory and call caps, output cut). nekkod `a_code_mode_turn_runs_the_models_script_and_asks_for_each_call_it_makes` runs a real daemon turn: a scripted model calls `search_tools`, then `run_code`, whose script calls an MCP tool twice. Each call is approved separately, the result is the joined output, the model never saw the MCP tool or the file tools directly, and the reply's stats carry the tally. Shared saved-mode, store golden, Mode panel and stats-line tests also pass. **Not verified:** a live local or cloud model choosing between `search_tools` and `run_code` well; how much a real chat saves (the tally is an estimate and needs measurements on real sessions, which go in `docs/perf-history.md` once taken).

**Planned:**

- **Hypergate code mode.** The gateway that fronts a user's MCP servers would expose the same `search_tools` / `run_code` pair over MCP, opted into per client with a URL parameter (as Cloudflare's `?codemode=search_and_execute`). Any harness (Claude Code, Cursor, Codex) would then get code mode for those servers, with the sandbox in the daemon and credentials never in it. Nekko Agent would offer it as a third option when the chat's MCP comes through Hypergate, so a script's calls skip a round trip through the app. This lives in nekko-labs/hypergate.
- Code mode for sandbox chats (the script would run in the container).
- Parallel tool calls from one script, under one approval batch.
- Phone support (`toolApproach` is not in the phone allowlist).
- Showing a script's nested calls as their own rows in the transcript (today they appear as approvals and in the run's output).

See [decision 0004](../../docs/decisions/0004-code-mode-in-an-embedded-quickjs-sandbox.md) and [Mode panel and saved modes](mode-panel-and-saved-modes.md).
