# Claude Code stream-json fixtures

- `api-key/`, `signed-out/`: recorded from Claude Code 2.1.284 on Windows by
  `scripts/claude-code-probe.mjs` (H0), with an isolated config directory and a
  workspace-scoped test API key (`api-key/`) or no credentials (`signed-out/`).
  Local paths are scrubbed to `C:\work\...`; nothing else is edited.
- `synthetic/`: hand-written, for shapes no probe run recorded yet (a tool
  round trip with partial messages, a sub-agent, `system/api_retry`). Field
  names follow the recorded events and Claude Code's SDK types; replace them
  with recordings once a live run captures them. `wake-up.jsonl` is the turn
  Claude Code starts on its own when a background command finishes, with the
  shapes a Claude Code 2.1.303 run on macOS printed (`task_notification`, then
  `init` ... `result`, nothing written to it); ids and paths are made up.
