---
title: "Scope Boundaries"
area: product
split-from: SPEC.md (2026-10-22)
---

# Scope Boundaries

- **No native node modules**: keeps Electron rebuild pain away; ripgrep/git are spawned via child_process with JS fallbacks. Native speed comes from the separate Rust engine daemon (`nekkod`), a standalone binary shipped beside the app, never a module loaded into Node or Electron. (Technical constraint; see `TASKS.md`.)
- **Not a full IDE**: the file editor is a lightweight mono textarea (+ rendered markdown), not Monaco/CodeMirror; no language servers, debugger, multi-cursor, or refactoring tooling. The browser pane is a preview/utility surface, not a hardened general web browser. The Design board (planned) shows snapshots, not an editable vector canvas.
- **Cloud never runs your shell/filesystem tools on our servers**: inference and tool calls always execute on *your* paired machine. The cloud is a sync + relay + billing layer, not a remote executor.
- **The OSS app never checks a license**: paid features are gated server-side in Cloud only; the open-source editions are fully functional and free.
- **The relay is a dumb pipe**: it authenticates/routes and forwards ciphertext; it does not inspect or store message bodies.
- Pricing tiers (Free OSS / Pro / Team) are drafts pending cost modeling, see [spec-web-and-hosted.md](spec-web-and-hosted.md) §6.
- **Workflows don't execute untrusted code from strangers**: a git-triggered workflow that checks out a pull request runs that contributor's code with this machine's tool access. Local CI runner templates must only auto-fire on trusted refs (own branches, collaborators' PRs); running arbitrary fork PRs is an explicit opt-in with sandboxed (yolo-off, approval-gated) tool policy, not a default.
- **Subscription sign-in rides first-party OAuth clients**: the ChatGPT subscription flow uses the public OAuth client of the Codex CLI. OpenAI's terms are written around its own apps, so the feature is offered as-is, clearly labelled, with the API-key path unaffected. If OpenAI cuts it off, the app degrades to API keys, not a broken product.
- **Claude plan sign-in removed** (decided 2026-10-19): Anthropic does not permit third-party apps to offer Claude.ai login, route requests on Free/Pro/Max credentials, or collect Claude credentials (code.claude.com/docs/en/legal-and-compliance). Nekko Agent no longer signs in with Claude Code's OAuth client, no longer sends Claude Code's identity line or the OAuth beta header, no longer reads Claude Code's credential file or accepts pasted Claude tokens, and no longer reads plan limits. On first start after the update nekkod deletes every Claude token from `tokens.json`, turns off each Anthropic provider that ran on one (kept, so chats keep their history; the Models card offers an API key) and records a one-time notice in `settings.notices` (`claude-sign-in-changed`) for the renderer. Kept dormant: the generic OAuth machinery, token store, sign-in UI and limits UI (ChatGPT and OpenRouter use them) and an empty Claude approved-client slot (`CLAUDE_APPROVED_CLIENT`, TS and Rust); filling it needs Anthropic's written approval. `scripts/check-claude-compliance.mjs` fails CI if any of it comes back. Status: built and tested, held as a draft until the Claude Code harness (Claude Agent) and its UI land the same day, so plan users always have a path.
