---
status: accepted
date: 2026-10-22
---

# 0004. Run code mode's scripts in an embedded QuickJS sandbox, calling back through the turn's own tool path

## Context

Code mode ([spec](../../spec/context/code-mode-tools-as-code.md)) has the model write JavaScript that calls the chat's tools, instead of calling each tool itself. The script needs a runtime that is on every machine the daemon runs on (macOS, Windows, Linux, the Docker image, the CLI), starts in milliseconds, can be stopped, and reaches nothing but the tools. Each call the script makes must still pass the chat's approvals, guardrails, hooks and unattended policy, since those are what make it safe to let a model act.

## Options considered

1. **Where the script runs:**
   - **QuickJS embedded via `rquickjs`.** About a megabyte of C compiled into the daemon. A bare context has no I/O at all. It has memory, stack and interrupt limits and starts in well under a millisecond. It runs JavaScript only, not TypeScript, and is far slower than V8 (irrelevant when the time goes to tool calls).
   - **V8 via `deno_core`.** Fast and close to Node, but adds tens of MB to the daemon and minutes to the build. Its permission model is more surface than we need.
   - **`boa_engine` (pure Rust).** No C toolchain needed, but a slower and less complete engine, and a heavy compile.
   - **A Node or Deno child process.** Node ships with Electron but not with the CLI or the Docker image. Isolation would rest on that runtime's flags, plus a process per run.
   - **The sandbox container.** Strong isolation, but needs Docker. Only sandbox chats have that.
2. **How a script's calls run:** through the turn's `TurnTools::guarded` (hooks, then `inner`: tool switches, unattended policy, approvals, guardrails), the same as a direct call; or a separate allowlist inside the sandbox. A separate path would be a second policy to keep in step with the first.
3. **How the script waits on a call:** run it on a blocking thread whose host function sends the call over a channel to the turn's async task and blocks on the answer; or QuickJS's async runtime with Rust futures as promises. The async runtime needs `Send` futures and a different lifetime model, and gains only parallel calls.

## Decision

Embed QuickJS (`rquickjs` 0.14, no loader, no std modules). Run each `run_code` on a blocking thread. Send every tool call it makes back to the turn's async side, which runs it through `guarded`, so a script's call is approved, guarded and hooked exactly like a direct one. Calls are sequential for now.

## Consequences

- Code mode works everywhere the daemon does, with no runtime to install, and grants nothing a direct call would not.
- `rquickjs-sys` compiles QuickJS with the platform C compiler. The workspace already needs one (`ort`, `portable-pty`), but a new target may need bindgen.
- Scripts are JavaScript. A model that writes TypeScript annotations gets a syntax error back and retries. If that proves common, strip types before evaluation (a small transform, or SWC behind a feature).
- Parallel calls, a script's calls as their own transcript rows, and code mode for sandbox chats are follow-ups.
- Wrong if live sessions show models misusing `run_code` more than they save, or QuickJS's speed matters for real scripts. The per-reply tally (`turnStats.codeMode`) is how we will see the first.
