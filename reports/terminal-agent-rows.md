# Terminal sessions in the Agents panel

## Findings and recommendation

The panel currently builds terminal rows from workspace anchors. A terminal opened beside a chat or directly on the command wall has no guaranteed row. The Rust PTY registry already owns every terminal independently of renderer mounts, so it is the right place to observe lightweight metadata.

Give every real terminal exactly one row, using the existing project grouping, sorting, drag-to-zone and selection behavior. Do not duplicate read-only `agent_` command logs. Keep terminal identity separate from chat identity and keep exited terminals available for inspection.

### Layout

```text
Agents                          Terminal window
  project                       [ terminal icon · Fix login redirect ]
  [agent] Build settings        [ Working · Editing files | directory | PR #42 ]
  [>_] Fix login redirect       [ original interactive terminal output         ]
       Working · Editing files
  [>_] Tests
       Command failed · exit 1
```

The row uses a terminal icon, a terminal-reported smart title (falling back to its saved title), and a concise status/detail line. The header uses the same derived state, current directory when reported, and the most recent observed GitHub pull-request link. A PR link is initially labeled as observed, not open/merged. Explicit refresh uses the existing authenticated PR-info service; failed or missing lookups remain unverified.

## Signals and trust

| Source | Display | Boundary |
| --- | --- | --- |
| PTY lifecycle | Shell open, Exited, exit code | An open shell is not proof of agent activity |
| OSC 0/2 | Smart title | Bounded display-only text, not instructions |
| OSC 133 command markers | Working, Ready, failed command | Only when the shell supplies markers; never infer completion from silence |
| OSC 777 notification | Needs attention and notification detail | Never auto-approve anything |
| Explicit Claude hooks | Working, Needs permission, turn complete, tool name | Opt-in configuration; do not edit global Claude settings |
| GitHub PR URL in output | PR link | Observed link only until GitHub lookup succeeds |

No cloud title generation, transcript uploads, keystroke logging, process scraping, or reads of Claude's private transcript database. Parse bounded output incrementally in the PTY pump, preserve output bytes unchanged, and refresh lightweight terminal metadata independently of mounted terminal panes. Hooks emit metadata to the terminal, never execute supplied terminal content.

## Claude Code integration

Use documented `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Notification`, `Stop`, and `SessionEnd` events. Provide an opt-in hook script/config example that emits a small OSC notification to `/dev/tty` on Unix. Only report event names/tool names, not prompts, tool arguments or responses. Hook failures must not block Claude. Windows requires a separate supported terminal-output path and remains explicitly unverified, not silently configured.

## Delivery and acceptance

1. Bounded Rust metadata observer and shared contract, with split-sequence, invalid-input, flood and lifecycle tests.
2. One panel row per terminal, including unanchored and split terminals; no command-log duplicates. Header, status, smart title and explicitly verified PR details.
3. Focused renderer tests, hidden isolated Electron before/after evidence, and live PTY signal test. Preserve all user-owned running apps.
4. Update feature spec and user docs. Publish evidence and land through the required PR workflow.

## Sources

- Existing implementation: `crates/nekko-term/src/session.rs`, `apps/desktop/src/renderer/views/WorkspacesView.tsx`, `components/WorkspaceCard.tsx`, `components/TerminalPane.tsx`.
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks): explicit lifecycle and permission signals.
- [cmux notifications](https://cmux.com/docs/notifications): workspace attention indicators and Claude hook integrations, OSC 777 transport.

## Alternatives

Screen scraping is fragile for full-screen terminal interfaces and can expose secrets. A cloud summarizer has unnecessary privacy/cost implications for titles. Replacing Claude Code with an SDK session would change the user's terminal workflow. The proposed passive metadata layer preserves it. Automatic shell-hook injection, repository/branch discovery, multi-PR aggregation and automatic Claude hook installation are follow-up scope, not claimed here.
