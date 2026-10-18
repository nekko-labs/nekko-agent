# Chat close icon: implementation plan

## Intent and status

Multiple users reported that they did not recognize the checkmark as the way to close their chats. Use the familiar X on the existing chat completion controls to improve discoverability.

**Status: planned, not implemented or visually verified.** This planning change records the decision and creates tracking; it does not change runtime UI. The user-provided screenshots are reference context, not baseline verification evidence, and are not published by this planning change.

## Scope and constraints

- Replace the completion-action checkmark in chat window headers and active chat cards/saved-chat rows that reuse `WorkspaceCard`.
- Preserve completion/archive semantics: the chat goes to Show completed, remains readable/restorable for the existing 60-day retention period, and is not permanently deleted by the X.
- Preserve the configured Delete action and its trash icon/confirmation. Do not change terminal Close, board-only Minimize, context menu commands, shortcuts, completed-state indicators, or generic `CheckIcon` artwork.
- Default to an icon-only refactor: retain accurate Complete tooltip/accessible labels and hotkeys. Do not relabel completion as destructive Close or silently change what the button does. Broader copy or hover-visibility changes are separate scope.
- Reuse `CloseIcon`; introduce no dependency, migration, new API, telemetry, permission or external call. Use synthetic fixtures, not user conversations, for verification.

## Repository findings

- `apps/desktop/src/renderer/components/PaneFrame.tsx`: the lifecycle button selects CheckIcon for `action === 'complete'`, TrashIcon for Delete, and CloseIcon otherwise. The Complete handler calls `archiveChat`; the default is Complete but `chatPaneAction` can select Delete.
- `apps/desktop/src/renderer/components/WorkspaceCard.tsx`: the completion button uses a 3.5-size CheckIcon for chats and a 3-size CloseIcon for other cards. It stops propagation and uses `completeWithExit` around the existing callback, checking saved archive state afterward.
- `apps/desktop/src/renderer/components/PaneFrame.test.tsx`: existing tests cover default archive routing, minimize, deletion and terminal confirmation. Extend these, rather than replacing behavioral coverage with a snapshot.
- `apps/desktop/src/renderer/completionExit.ts` and its tests own row-exit timing and save-failure behavior. Leave implementation unchanged.
- `SPEC.md` currently explicitly describes the completion checkmark. `docs/WALKTHROUGH.md` explains lifecycle actions, shortcuts, Show completed and retention. Update these when the UI lands, not as if it has already shipped.

## Ordered implementation steps

### 1. Confirm the implementation baseline and arrange before evidence

1. Start a fresh isolated worktree from current main; read AGENTS.md and the linked task/issue.
2. Recheck both components, their call sites and lifecycle tests because concurrent changes may have moved the controls. Audit every active-chat completion control; do not perform a global CheckIcon replacement.
3. Inspect existing app instances and identify ownership/revision. Treat user-owned apps as read-only.
4. Use the existing lifecycle/agent-sidebar sandbox harness where suitable, or extend an owned fixture with synthetic active/completed chats and a terminal. Establish separate app data, denied external side effects, hidden/non-focusable rendering, and off-screen native windows before launch.
5. Capture and inspect unchanged-base controls at matching wide/narrow viewports and light/dark themes, in the Agents view, Command Center headers, and vertical/horizontal agent lists where affected. Include hover/focus states so the card control is actually visible. Record the fixture revision, viewport, theme and synthetic data.

**Exit criterion:** inventory and baseline evidence exist before editing UI; no user app/data was changed.

### 2. Make the smallest icon substitution

1. In PaneFrame, use CloseIcon for Complete while keeping TrashIcon for configured Delete. Preserve `h-3 w-3`, button styling, ordering, handlers, title, accessible label and keyboard routing. Remove CheckIcon from this file only if unused.
2. In WorkspaceCard, use CloseIcon for the chat completion action with its existing `h-3.5 w-3.5` size; preserve the non-chat `h-3 w-3` size. Remove the now-unused CheckIcon import.
3. Retain stopPropagation, completion-save checks, exit animation, failure recovery, reduced-motion path and retention guidance. Adjust the nearby explanatory comment only if needed to explain that X completes/archives rather than deletes.
4. Leave completed-chat/status checkmarks, plan-step success indicators, provider checks, icon definitions and mobile-native clients untouched. If the call-site audit discovers another equivalent shared-renderer completion button, include it with explicit tests/evidence rather than assuming two files cover it.

**Exit criterion:** the affected completion buttons show X with unchanged action behavior and layout.

### 3. Add focused regression coverage

1. Extend PaneFrame tests to assert CloseIcon for default completion and TrashIcon for configured deletion, retaining archive versus delete versus close-handler assertions.
2. Add a focused WorkspaceCard component test (a new `WorkspaceCard.test.tsx` if no equivalent exists) verifying CloseIcon at the chat size, accurate accessible naming/retention title, no parent card activation from clicking X, and exactly one completion callback. Cover the non-chat control separately.
3. Reuse existing completionExit/store tests for save failures and reduced motion; add missing regressions only where the audit finds gaps. Confirm a failed save does not leave the chat permanently hidden.
4. Run focused tests from `apps/desktop` using `npx vitest run src/renderer/components/PaneFrame.test.tsx src/renderer/components/WorkspaceCard.test.tsx`; also run the discovered completionExit/store/shortcut test files. Then run `npm run typecheck -w @nekko-agent/desktop`, `npm run test -w @nekko-agent/desktop`, and `npm run build -w @nekko-agent/desktop` after required workspace dependencies are built.

**Exit criterion:** assertions prove icon choice and unchanged lifecycle behavior; typecheck, desktop tests and build pass. Passing tests alone are not visual acceptance.

### 4. Verify visual, interaction and motion behavior

1. Reuse the isolated fixture at the changed revision with the same route, dimensions, theme and data as baseline. Capture and inspect matched after screenshots across the affected matrix.
2. Exercise mouse click and keyboard Enter/Space on X. Verify only the target chat completes, Show completed exposes it, it is readable/restorable, and card clicks do not accidentally open it while completing.
3. Verify existing Ctrl/Cmd+Shift+E routing, minimize versus complete, configured Delete/trash/confirmation and terminal Close remain distinct. Renderer shortcut simulation is not proof of native OS shortcut delivery; report that limitation accurately.
4. Check hover/focus visibility, hit target, icon alignment/contrast, tooltip and accessible naming at wide/narrow widths in both themes, including the narrow agent-list drawer.
5. Record a short isolated completion interaction because the affected card participates in an existing exit animation, even though timing is not being changed. Inspect sampled frames; verify reduced-motion behavior and failed-save recovery without changing timing.
6. For desktop-window claims, use an owned off-screen/non-focusable native-window capture in addition to renderer evidence. Do not run foreground branding/permission tests or interact with user windows.

**Exit criterion:** screenshots and motion evidence are inspected, interactions pass, and any unsupported/unverified platform claims are explicit. User research validation of improved discoverability remains a follow-up, not a claim proven by icon tests.

### 5. Update specification, user docs and tracking

1. Update the existing checkmark description and planned entry in SPEC.md to reflect actual implementation and verified versus pending acceptance.
2. Update docs/WALKTHROUGH.md to explain that X completes the chat, Show completed retains it for 60 days, Minimize only removes the board window, and Delete is separate. Run `npm run docs` and review generated changes.
3. Check off TASKS.md implementation/verification subtasks only when their criteria pass. No performance improvement is claimed or measured by this refactor; if implementation later measures a performance change, record the actual numbers/conditions in docs/perf-history.md.

**Exit criterion:** docs describe the actual X behavior without confusing completion with deletion or implying unfinished verification passed.

### 6. Publish evidence and land through normal gates

1. Commit scoped implementation/tests/docs; keep .shots and recordings untracked.
2. Open a PR linked to the issue. Include matched Before/After tables, recording links, test results and an explicit Unfinished work / release blockers section.
3. Upload agent-captured evidence through `node scripts/pr-media.mjs <pr-number>` to the shared pr-media pre-release series. Read back the description and verify published media links. Do not publish user-supplied reference screenshots without explicit permission.
4. Keep the PR draft/unmerged while required visual evidence, checks or reviews are missing. Diagnose failed checks; do not rerun until green or bypass gates.
5. Merge only after required acceptance/checks/reviews pass. Close the implementation issue through that PR, not through the planning-only PR. Preserve unrelated work during cleanup.

**Exit criterion:** implementation is landed with verified evidence and tracking reflects the result.

## Acceptance checklist

- [ ] Active-chat completion actions display X in every affected shared-renderer header/card surface.
- [ ] X completes/archives exactly one chat; retention, restoration, failure recovery and exit timing are unchanged.
- [ ] Delete retains the trash icon and confirmation; Minimize and terminal Close retain their behavior.
- [ ] Tooltips, accessible names, hotkeys and keyboard activation remain accurate.
- [ ] No unrelated checkmarks, dependencies, APIs, permissions or data formats change.
- [ ] Focused and desktop regression tests, typecheck, build and docs generation pass.
- [ ] Matched wide/narrow light/dark evidence and completion recording are inspected and published in the implementation PR.
- [ ] SPEC.md, walkthrough and TASKS.md reflect implemented versus unverified status.

## Risks and follow-up

X can imply deletion or merely hiding a window; retain explicit completion/retention guidance and keep destructive Delete separate. Hover-only card controls may still affect discoverability; this plan preserves existing visibility and does not claim the icon alone resolves every usability issue. Gather feedback after shipping before broadening copy, visibility or lifecycle behavior. Native clients are not included unless a later audit/request adds them with their own evidence.
