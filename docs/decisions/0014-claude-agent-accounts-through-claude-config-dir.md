---
status: accepted
date: 2026-10-23
---

# 0014. Give each Claude Agent account its own Claude Code folder through `CLAUDE_CONFIG_DIR`

## Context

Philip asked for several Claude accounts running in one Nekko window, and for easy account switching for every provider. Every other provider already allowed several accounts (one provider per API key, cloud account or ChatGPT sign-in). Claude Agent did not: it runs the user's own Claude Code with the environment unchanged, so every Claude Agent provider used the one default login (`~/.claude`). The harness design (2026-10-19, `projects/nekko-agent/features/claude-code-harness/prompt.md` in the workspace) said Nekko "never sets `CLAUDE_CONFIG_DIR`", to keep Nekko as far as possible from Claude Code's sign-in.

Anthropic's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page (read 2026-10-23) forbids third-party apps from offering Claude.ai login, routing requests on plan credentials, or collecting, storing or intermediating Claude credentials, and explicitly does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription", including where a platform hosts Claude Code. Claude Code documents `CLAUDE_CONFIG_DIR` as the way to keep its home-directory files (settings, sessions, login) somewhere else. The same page says plan usage limits "assume ordinary, individual usage".

## Options considered

1. **Keep one Claude Code login.** Simplest and furthest from credentials, but the user cannot keep a work and a personal Claude account apart in Nekko at all.
2. **A config folder per account through `CLAUDE_CONFIG_DIR`, named, never a path.** The user signs in to each folder through Claude Code's own `/login` in a Nekko terminal; nekkod passes the folder to the child, `claude auth status` and that terminal, and never opens it. The folder is `~/.claude-<name>`, the one a user gets typing `CLAUDE_CONFIG_DIR=~/.claude-work claude` themselves.
3. **A folder inside Nekko's data directory.** Hides the login from the user's own terminal and puts Claude Code's credentials under a Nekko-owned path, which reads as Nekko storing them.
4. **Automatic failover between plan accounts when one is spent.** Rejected outright: it is pooling plans to get around rate limits.

## Decision

Option 2. A Claude Agent provider may carry `claudeCode.account`; nekkod maps a checked name (`[a-z0-9-]{1,32}`, no leading or trailing `-`) to `~/.claude-<name>` and sets only `CLAUDE_CONFIG_DIR`. An invalid name fails the turn rather than falling back to the default login. Sign-in, credential storage and usage stay entirely inside Claude Code. Switching is always the user's click; Auto's Follow capacity & cost never moves a turn onto a Claude Agent.

## Consequences

- The "never sets `CLAUDE_CONFIG_DIR`" rule in the harness design is replaced by "sets it only to a named account's folder". The module docs in `crates/nekko-harness` and `crates/nekkod/src/harness.rs` say so.
- A Claude Code session lives in one account's folder, so a chat that switches account starts a new Claude Code session (`claudeCodeAccount` is saved beside `claudeCodeSessionId`); Nekko's transcript keeps the history, Claude Code on the new account does not see it.
- Whether one person may hold several Pro or Max plans to add up limits is Anthropic's call, not a technical one. The docs page (`docs/accounts.md`) marks it "ask Anthropic first"; if Anthropic says no, nothing in Nekko encourages it (no failover, no pooled usage view), and named accounts remain right for separate people or organizations.
- Not yet verified against two live signed-in Claude Code accounts, including macOS, where Claude Code keeps each folder's login in its own keychain entry (CL8).
