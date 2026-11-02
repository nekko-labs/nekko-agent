# Connected computers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One desktop runs and watches every agent on every computer its owner has, with the model on any of them, driven from a desktop or a phone.

**Architecture:** A desktop becomes another paired device. `nekkod` holds one relay link per computer and merges what it sees behind qualified ids. Hosts gain a computer access class, and the model tunnel carries a connected Model Server over the same link.

**Tech Stack:** Rust (`nekkod`, `nekko-remote`), TypeScript and React (desktop, `packages/shared`), Swift (iOS), Kotlin (Android).

**Spec:** [docs/superpowers/specs/2026-11-02-connected-computers-design.md](../specs/2026-11-02-connected-computers-design.md)

Each phase is a stack of its own and lands before the next is planned in detail, because each one fixes names the next depends on. Phase 0's tasks are below. Later phases get their task list appended here when they start.

## Global Constraints

- Every change has a GitHub issue, lands as a PR queued with `gh pr merge --auto`, and has an **Unfinished work / release blockers** section. Auto-fix on.
- No em dashes. No AI attribution. No emoji or system glyphs as new UI icons.
- `packages/shared/src/phone-access.ts` is the gate's source of truth; `phone-access.golden.test.ts` writes `crates/nekko-remote/src/phone-access.json` and `tests/golden/phone.json` (`UPDATE_GOLDEN=1`). Never edit those by hand.
- Wire names stay: `chat:steer`, `chat:interruptQueued`, the `steered` event. Only words a person reads change.
- UI verification runs hidden, off-screen, on an isolated profile. Before/after captures go through `scripts/pr-media.mjs`.
- With nothing paired, no new work on any path and no pixel changes.

## Review Focus

1. Queue moved under the phone: the turn ended between tapping Next step and the call. The edit check refuses, the phone shows why, and nothing runs twice.
2. Next step on a queued prompt with photos or a skill: not offered, on any client, since `chat:steer` takes text only.
3. Interrupt from a phone: the call stays open until the new reply ends, so a request timeout must not read as a failure.
4. An older computer refuses `chat:steer`: the phone shows the readable refusal, and the prompt stays queued.
5. A blank or missing argument to `chat:steer` or `chat:interruptQueued` from a phone: refused by the gate as `value-invalid`, never reaching the engine.

---

## Phase 0: Messages during a run

### Task 1: The gate lets phones send at the next step and interrupt

**Files:**
- Modify: `packages/shared/src/phone-access.ts` (`PHONE_CHANNELS`, `PHONE_AGENT_CHANNELS`, `screenPhoneArgs`, `redactPhoneResult`)
- Modify: `crates/nekko-remote/src/phone.rs` (`check_args`, `redact`)
- Test: `packages/shared/src/phone-access.test.ts`, generated goldens

**Interfaces:**
- Produces: `chat:steer(sessionId: string, text: string)` answers the phone's session view. `chat:interruptQueued(sessionId: string, index: number, brain?: { providerId, modelId })`.

- [ ] Write failing tests: both channels are in the agent class; `chat:steer` refuses a blank text and a non-string with `value-invalid`; `chat:interruptQueued` refuses a negative or fractional index and unknown `brain` keys; `chat:steer`'s reply is redacted like `session:get`.
- [ ] Run `npx vitest run packages/shared/src/phone-access`. Expected: FAIL.
- [ ] Implement in TS and Rust, then `UPDATE_GOLDEN=1 npx vitest run packages/shared/src/phone-access.golden`.
- [ ] Run the same tests and `cargo test -p nekko-remote`. Expected: PASS.
- [ ] Commit.

### Task 2: iOS and Android offer Next step and Interrupt

**Files:**
- Modify: `apps/ios/Protocol/Sources/NekkoProtocol/Wire.swift`, `apps/ios/Protocol/Sources/NekkoKit/ChatModel.swift`, `apps/ios/App/Views/ChatExtras.swift`
- Modify: `apps/android/protocol/src/main/kotlin/com/nekko/protocol/Wire.kt`, `apps/android/app/src/main/java/com/nekko/android/chat/ChatController.kt`, `ChatViewModel.kt`, `ui/chat/Composer.kt`, `ui/screens/ChatScreen.kt`
- Test: `apps/ios/Protocol/Tests/NekkoKitTests/`, `apps/android/app/src/test/`

**Interfaces:**
- Consumes: Task 1's channels.
- Produces: `sendQueuedAtNextStep(index, expect)` removes through `chat:editQueued` (so the check holds), then calls `chat:steer`. `interruptQueued(index)` calls `chat:interruptQueued` and treats a timeout as still running.

- [ ] Write failing tests: next step removes then steers; a refused edit never steers; a refused steer puts the text back with `chat:queue`; interrupt sends the index and the chat's model; both refused offline with the existing reconnect message.
- [ ] Run them. Expected: FAIL.
- [ ] Implement, showing both actions under a queued row only while the chat runs, Next step only when the prompt has no photos or skill.
- [ ] Run them, then build both apps. Expected: PASS.
- [ ] Commit.

### Task 3: Plain words on the desktop and in the docs

**Files:**
- Modify: `apps/desktop/src/renderer/components/ChatPane.tsx`, `RunBoard.tsx`, `views/TrainingView.tsx`, `apps/android/.../ComputersScreen.kt`
- Modify: `SPEC.md`, `spec/chat/chat-cowork-unified-surface.md`, `spec/chat/plan-sheet-on-the-composer.md`, `spec/product/why-it-exists.md`, `spec/automation/handing-the-agent-a-long-running-goal.md`, `docs/REMOTE.md`

- [ ] Rename per the design's table: **Steer** to **Next step**, **Send now** to **Interrupt**, and the composer placeholder to `Queue a follow-up… (Ctrl/⌘+Enter sends it at the next step)`.
- [ ] Write a test in `ChatPane` tests that the queue row shows Next step and Interrupt and no "Steer".
- [ ] Run `git grep -in steer -- SPEC.md spec docs/REMOTE.md apps/desktop/src/renderer`. Expected: only code identifiers, the wire channel, and `.kiro/steering`.
- [ ] Commit, capture before and after, open the PR.
