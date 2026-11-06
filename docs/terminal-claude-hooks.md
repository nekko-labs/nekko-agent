# Claude Code status in a Nekko terminal

Nekko can observe a terminal's title, shell command markers and attention notifications locally. Claude Code users can optionally supply explicit working, permission and completion events. This does not give Nekko permission to approve tools or access Claude transcripts.

## Optional hook setup (macOS/Linux)

Requires Node on the hook's PATH and a terminal started by a version of Nekko with terminal metadata support. Copy `scripts/claude-terminal-hook.mjs` to a stable location you control. Replace `/absolute/path/claude-terminal-hook.mjs` below with that location. **Merge** these entries into your chosen Claude Code settings file (`.claude/settings.local.json` for one checkout); do not overwrite an existing settings file or existing hooks.

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/claude-terminal-hook.mjs" }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/claude-terminal-hook.mjs" }] }],
    "PermissionRequest": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /absolute/path/claude-terminal-hook.mjs" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/claude-terminal-hook.mjs" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/claude-terminal-hook.mjs" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "node /absolute/path/claude-terminal-hook.mjs" }] }]
  }
}
```

Quote the script path inside the command if it contains spaces. Review the hook configuration with Claude's `/hooks` command. Then start Claude in a **new Nekko terminal** so it inherits `NEKKO_TERMINAL_ID`. Nekko does not install this configuration for you. The script returns no approval decisions and writes nothing to Claude's stdout. It emits only event names and sanitized tool names to `/dev/tty`; prompts, tool arguments and notification bodies never appear in metadata.

- **Working:** a prompt was submitted or a tool is about to run.
- **Needs attention:** Claude requested permission or explicitly notified that input is needed. Answer in the terminal.
- **Ready / Turn finished:** Claude emitted Stop, not proof that the task or PR is complete.
- **Shell open:** no activity signal is available. Silence does not imply completion.

Test just the display transport, without running Claude:

```sh
printf '\033]2;Terminal integration check\007\033]777;nekko;attention;Integration check needs input\007'
```

If no status appears, check that this is a newly created Nekko terminal, the hook's Node path exists, and the process has access to `/dev/tty`. The adapter intentionally fails silently rather than block Claude. Hooks use the documented [Claude Code hook events](https://code.claude.com/docs/en/hooks). Authenticated Claude delivery and Linux runtime behavior have not been exercised in the implementation sandbox; parser/adapter tests and a real macOS PTY have. Windows hook delivery is not implemented (the script is a no-op).

## Pull requests

A GitHub PR URL printed by a program becomes an **observed link**, not a claim that the current task owns that PR or that it is open/merged. Use **Refresh** in the terminal context strip for a read-only lookup using Nekko's existing GitHub integration. A failed lookup says Status unavailable. A successful result is last-fetched state, not continuously polled; refresh it again when needed. Only the latest observed PR is shown; repository discovery, multiple-PR aggregation and GitHub Enterprise URLs are not supported in this first version.
