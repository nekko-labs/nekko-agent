---
title: "Accounts and switching (2026-10-23)"
area: models
---

# Accounts and switching (2026-10-23)

**Why:** Philip asked for easy account switching for every provider, and for several Claude accounts running in one window, with the docs clear on what Anthropic allows. People keep a work and a personal plan, or a client's API key beside their own, and want each chat on the right one without reconfiguring anything. Decision: [0014](../../docs/decisions/0014-claude-agent-accounts-through-claude-config-dir.md). User docs: [docs/accounts.md](../../docs/accounts.md).

**An account is a provider.** Adding a second provider of the same kind is a second account: another ChatGPT sign-in (told apart by its email), another API key or cloud account (by its label), or another Claude Agent account (by its name). Local model servers are machines, not accounts.

**Switching** `[implemented 2026-10-23; renderer tests]`. When the chat's provider has another enabled account of the same kind, the model picker opens with an **Account** row (`accountSiblings`): one pill per account, the current one checked, named by email or label. A click moves the chat to the same model on that account; an account whose model list lacks the model is greyed with the reason. Nekko-engine providers keep the chat's history, so the conversation continues. For Claude Agent the picker says the switch starts a new Claude Code conversation. New chats start on the last used provider and model (`defaultProviderId`/`defaultModelId`), or the one set with **Set as default**.

**No automatic rotation onto a Claude plan.** Switching is the user's click. Auto's opt-in **Follow capacity & cost** may still run a spent provider's turn on another provider (another ChatGPT plan, say), but never on a Claude Agent: the cross-provider pools leave out `claude-code` providers, and a Claude Agent chat has no Auto.

**Several Claude Agent accounts** `[implemented 2026-10-23; daemon end-to-end test on a fake claude; not yet against two live signed-in accounts]`.

- Setup: Add provider → Claude Agent offers **My usual Claude Code login** or **Another account** with a name. The name becomes `claudeAccountName` (lowercase, `[a-z0-9-]`, up to 32), shown as the folder `~/.claude-<name>`. The status check and **Open Claude Code to sign in** run on that folder; the user signs in with Claude Code's own `/login`. Saving makes a provider labelled `Claude Agent · <Name>` with `claudeCode: { account }`.
- Engine: nekkod maps the account to `CLAUDE_CONFIG_DIR=~/.claude-<name>` (`nekko_harness::account_config_dir`) for the chat's Claude Code child, for `claude auth status` (`claude:codeStatus(providerId?, account?)`), and for the sign-in terminal (`terminal:create` `claudeAccount`). Only a checked name is accepted, never a path; an invalid one fails the turn instead of using the default login. The account is a launch setting, so a change relaunches the child.
- Sessions: Claude Code keeps a session in its account's folder, so the chat saves `claudeCodeAccount` beside `claudeCodeSessionId` and resumes only a session made under the same account; after a switch the next launch starts a new Claude Code session there.
- Boundaries unchanged: Nekko never reads the folder, never reads, copies or stores the login, never sets a token, never wraps the binary. Plan usage is shown in Claude Code only.

**What Anthropic allows** (as documented 2026-10-23, shown on the docs page as a table and a diagram): your own plan through the unmodified Claude Code, separate accounts for separate people or work, and any number of API keys or cloud accounts are fine; one person holding several Pro or Max plans to add up limits is "ask Anthropic first", since plan limits "assume ordinary, individual usage"; sharing a login, a third-party Claude sign-in or credential handling, and rotating accounts to get around rate limits are not allowed, and Nekko does none of them.

**Not yet:** Claude Agent chats on another computer (today an SSH terminal from Terminal → SSH hosts reaches another machine's Claude Code, as a terminal, not a chat); a live check with two signed-in Claude Code accounts on macOS and Windows.
