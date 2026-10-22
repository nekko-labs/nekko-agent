# iPhone app vs Orca: feature audit and finish-line gaps, 2026-10-19

A refresh of [ios-native-competitive-2026-10-16.md](ios-native-competitive-2026-10-16.md). That report worked from Orca's README and repo layout. This one reads the Orca phone app's source: `stablyai/orca`, `mobile/` at `b6325ef` (2026-10-18). Each row says where the feature lives in Orca and what the native Nekko iPhone app (`apps/ios`) has today. The gap list it produces is in TASKS.md, *iOS finish line* (IO-18 onward).

Legend: **Have** = shipped in the native iPhone app. **Gap** = we should build it. **Decision** = needs the owner's security or product call first. **Skip** = deliberately not copying.

## What Orca's phone app is now

Orca's phone app is an Expo / React Native client with about 2,000 source files. It has grown well past the 10-16 snapshot:

- A **Tasks** surface (233 files) that reads Jira, Linear and GitHub Issues / Projects, edits fields and comments, and starts an agent from an issue.
- A **Source control** surface (110 files) that commits, generates commit messages with AI, compares branches, creates PRs and starts hosted reviews.
- **Files** with editable source, a live **terminal**, and a **browser** screencast.
- Most screens now arrive **over the air from the desktop** (`mobile-web-shell`, 133 files).

Its transport (349 files) is the most engineered part. Its offline story is "paint the last snapshot, keep the draft, reconnect fast". There is no outbox: a prompt typed while offline can't be sent until the host is back.

## Inventory

### Connection and offline

| Orca feature | Where in Orca | Nekko iPhone |
| --- | --- | --- |
| QR pairing, E2E (X25519 + NaCl box), several hosts | `transport/mobile-relay-pairing-*`, `app/pair*.tsx` | **Have** (PBKDF2 + AES-GCM, relay v2) |
| LAN direct socket and hosted relay, **switching between them automatically** with hysteresis (needs N direct successes, a cooldown after a failure, a minimum dwell) | `mobile-endpoint-supervisor`, `mobile-endpoint-hysteresis`, `mobile-relay-direct-upgrade*` | **Gap** (IO-20). We dial one relay URL per computer. A computer reachable both on the tailnet and through the hosted relay can't fail over. |
| Keep a healthy relay socket for a short grace period across app switches | `mobile-relay-background-grace` | **Gap** (IO-20) |
| Reconnect controller with backoff, recovery evidence, auth-failed banner with re-pair | `mobile-relay-reconnect-controller`, `relay-recovery-*`, `AuthFailedBanner` | **Have** (relay state machine, denied state) |
| Tailscale or custom VPN route | none | **Have** (route detection, ATS exception, Relay on this computer), but **not working end to end on Philip's devices**: see IO-19 |
| Instant paint from a persisted snapshot on cold start and resume | `cache/home-snapshot-cache`, `repo-cache`, `worktree-cache` | **Partly**: chat list only, opt-in (IO-13). Transcripts aren't cached. Gap in IO-18 (OF-5, OF-6). |
| Composer drafts outlive the screen | `session/mobile-native-chat-draft-store` (memory only, lost when the app is killed) | **Gap**: our drafts are view state. IO-18 (OF-1) persists them, which goes further than Orca. |
| Buffered terminal drafts while offline | `terminal/use-buffered-terminal-drafts` | Not applicable (no terminal) |
| Send while offline, delivered later | **none** | **Gap and differentiator**: IO-18 (OF-2 to OF-4) |
| Connection log, troubleshooter, reachability probes, **submit a redacted diagnostics report** | `diagnostics/*`, `app/troubleshoot.tsx` | **Have** log and advice (IO-10). **Gap**: active probes and Share diagnostics (IO-21) |

### Chat

| Orca feature | Where in Orca | Nekko iPhone |
| --- | --- | --- |
| Streaming chat, reasoning, tool cards, sub-agent groups | `session/MobileNativeChat*` | **Have**. Sub-agent grouping: verify on a device (IO-22) |
| Permission and question cards | `MobileNativeChatPermission`, `MobileNativeChatQuestion` | **Have** |
| Queued messages: **edit and remove** before they run | `MobileNativeChatQueuedMessageEditor`, `mobile-queued-message-edit-lease` | **Gap**: we show the queue but can't edit it (IO-22) |
| Fork a chat | `mobile-chat-fork-create-feedback`, `mobile-native-chat-cli-fork` | **Gap** (IO-23) |
| `@` file search in the composer | `use-mobile-native-chat-file-search` | **Decision**: needs a file listing, refused to phones today |
| Image attachments, clipboard image paste, full-screen image viewer | `mobile-clipboard-image-*`, `MobileNativeChatImageViewer` | **Have** photos. **Gap**: paste an image and a viewer (IO-22) |
| Quick commands (saved shortcuts, a sheet per session) | `QuickCommands*`, `quick-command-draft` | **Gap**: the computer's saved prompts on the phone (IO-24) |
| Session tabs (several agents per worktree) | `MobileSessionTabStrip` | Skip: our unit is the chat, and the list does this |
| Agent history across worktrees, resume an old session | `agent-history/*`, `MobileHomeResumeCard` | **Partly**: complete / restore. **Gap**: a Continue card and search of completed chats (IO-25) |
| Per-session model and options remembered | `mobile-native-chat-session-option-persistence` | **Have** |
| Dictation: hold or toggle, set up the desktop speech model from the phone | `dictation/*`, `settings/voice-settings-screen` | **Have** toggle dictation. **Gap**: hold-to-talk (IO-28) |
| Real-time two-way voice audio | `packages/expo-two-way-audio` (vendored, not yet a screen) | Watch only |

### Work beyond the chat

| Orca feature | Where in Orca | Nekko iPhone |
| --- | --- | --- |
| Tasks: Jira, Linear and GitHub boards; filters; field edits; comments; start an agent from an issue | `tasks/*` (233 files) | **Gap**, split: our own automations and tasks list with Run now (IO-26) is safe. Third-party boards are a **Decision** (scope). |
| Source control: status, history, branch compare, commit with an AI message, create a PR, hosted review, abort a conflict | `source-control/*` (110 files) | **Decision**. Proposed safe path: PR status on the chat and "ask the agent to commit or open the PR", which runs through approvals (IO-27) |
| Files: explorer, Markdown and media preview, **editable source** | `files/*` | **Decision** (`PHONE_ALWAYS_DENIED`). Read-only Changes shipped (IO-9). |
| Live terminal with an accessory key row, live or buffered input | `terminal/*` (130 files) | **Decision** |
| Browser screencast with touch | `browser/*` | **Decision** |
| Accounts: switch provider account, usage cards | `accounts/*`, `home/MobileHomeAccountUsageCards` | **Gap**: read-only usage and limits (IO-29) |

### App shell

| Orca feature | Where in Orca | Nekko iPhone |
| --- | --- | --- |
| Push: needs-input and finished, per-type delivery settings, **Send a test notification**, **dismissal sync** (a notification handled on the desktop disappears from the phone) | `notifications/*` (62 files) | **Have** push and actions. **Gap**: test, per-type settings, dismissal sync (IO-30) |
| Onboarding with a notification opt-in preview | `onboarding/*`, `app/mobile-onboarding.tsx` | **Partly**: Welcome, and permission asked after pairing. **Gap**: a 3-step first run (IO-31) |
| App update prompt; desktop and phone version check | `app-update/*` | **Gap**: version compatibility banner (IO-32) |
| Screens shipped over the air from the desktop | `mobile-web-shell/*` | **Skip**: native SwiftUI is the point |
| Settings: Chat UI, Terminal, Browser, Voice, Notifications, Troubleshooting, About | `settings/*` | **Have** the ones that apply |
| Live Activities, widgets, Watch, Shortcuts, share extension, Control Center | none | **Have**, and Orca has none of them |

## What this means

1. **The table stakes are done.** What's missing before TestFlight is getting it onto Philip's phone and onto his tailnet (IO-19, IO-5, IO-7), not features.
2. **Offline is where we can beat Orca outright.** Orca keeps a draft in memory and paints the last snapshot. Nobody in the set queues a prompt offline and delivers it exactly once later. IO-18 does.
3. **Orca's breadth (tasks boards, git, files, terminal, browser) is a security posture choice,** not an oversight on our side. The proposals keep the phone as a remote for the agent: actions go through the agent and its approvals rather than raw channels. IO-26 and IO-27 are the safe slices.
4. **Cheap parity wins:** edit the queue, fork a chat, saved prompts, a notification test, dismissal sync and a version banner. IO-22 to IO-32.

## Sources

- github.com/stablyai/orca, `mobile/` at `b6325ef` (2026-10-18): `app/` routes and `src/{transport,session,cache,tasks,source-control,files,terminal,browser,notifications,diagnostics,accounts,dictation,onboarding,app-update,mobile-web-shell}`.
- [ios-native-competitive-2026-10-16.md](ios-native-competitive-2026-10-16.md) for Codex, Claude Remote Control, Happy, Omnara and VibeTunnel.
