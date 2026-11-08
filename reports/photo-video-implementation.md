# Photo / Video agents — implementation and design checkpoint

Issue: [#2099](https://github.com/nekko-labs/nekko-agent/issues/2099). This is **not cross-platform completion**.

[Open the editable, self-contained HTML/SVG design board](photo-video-agents.html). It covers compact/folded phones, unfolded/tablet, tabletop and desktop, with a light appearance study. Native frames are design studies, not screenshots of implemented apps. The source contains no external scripts, fonts, trackers or user data.

## Implemented on this branch

- Shared desktop/web creation menus and empty zones: Agent, Photo, Video, Terminal.
- Photo retains the existing `image` session type and actual local text-to-image flow. Existing image chats are not migrated or deleted.
- Video has its own persisted `video` session type and introduction, using the ordinary chat model and approved tools. It can help write scripts/storyboards and use installed editing tools; it is **not a direct video synthesizer**.
- Separate first-use acknowledgement per origin/device and mode, explicit dismiss/replay controls and accessible shared modal behavior. Intro opens after mount, not during static rendering. No menu/intro action starts inference, downloads or a shell.
- Original SVG art, compact bottom-sheet layout and wider two-column dialog. CSS safe areas, dynamic viewport bounds, and viewport-segment hints are present; hardware hinge behavior is not verified.
- Exact aspect-ratio labels and valid dimensions, including 1:1, 9:16, 3:4, 4:3, 16:9. Nonstandard existing sizes remain valid; 1344×768 is displayed as 7:4.
- Native phone session-option policy accepts `video` metadata but image-generation access remains denied. This does not grant a new tool or generation permission.

## Verification actually performed

- Desktop production bundle built with `npm run build -w @nekko-agent/desktop` after building shared/profile packages.
- Desktop TypeScript check passed.
- All **3,211 tests in 349 desktop test files** passed after fixing stale three-item menu expectations and deferring the portal until mount.
- Shared phone policy and golden contract suites: **40 tests passed**. Unknown modes and phone image generation are still rejected.
- Isolated Windows Electron fixture uses real menu/intro components, a fresh user-data directory, denied network/device permissions and synthetic data. At 320, 390, 744 and 1200 CSS px in light/dark, both modes pass: menu choice count, dialog bounds, Try acknowledgement, separate per-mode storage, suppression on subsequent entry, About replay and Escape. Final report: `.shots/layout-evidence/media-final/report.json`.
- Baseline menu pixels were captured before changing the menu. New intros have no before state. PNG files exist for all tested widths/themes.

## Not verified / release blockers

1. **Pixel inspection:** browser screenshot inspection timed out and native capture returned `UnknownVizError`. Saved images are unreviewed, not visually accepted. Native capture did not enumerate the hidden Electron fixture. Do not infer approval from attaching them to chat or a PR.
2. **Native scope:** iOS/Android menu/routing/first-use UI remains unimplemented. Native Photo needs safe image-model discovery, a guarded generation channel, long-running job events/results, and offline/reconnect behavior. Current access restrictions were deliberately preserved.
3. **Native evidence:** no SwiftUI/Compose implementation captures, instrumented acceptance or physical-foldable evidence. Width checks are not physical device evidence.
4. **Additional changed-surface evidence:** aspect controls and detailed picker need matched before/after capture and inspection. Full-app creation/reopen persistence and actual image inference/tool-based video editing need end-to-end acceptance; the small fixture does not prove them.
5. Native Dynamic Type/font scaling, reduced transparency, physical keyboard and asymmetric hinge layouts remain to be checked.

## Next implementation boundaries

- iOS: `Views/ChatsView.swift`, `Views/NewChatView.swift`, `Views/RootView.swift`, `Views/PanesView.swift`; preserve `NewChatSpec`, drafts/outbox and direct-versus-remote distinctions in `NekkoKit`.
- Android: `ui/screens/ChatsScreen.kt`, `NewChatScreen.kt`, navigation and `data/NewChatDefaults.kt`; preserve saveable/draft/outbox state on posture changes.
- Photo phone protocol changes require Rust/TypeScript policy and golden tests together. Never use `chat:send` to pretend a text reply is an image result or silently widen a read-only phone's rights.
- Foldable targets are capability-based. “iPhone Duo” is a conceptual target, not verified hardware specifications.

## Sources / assumptions

User's supplied screenshots are style/error references, not implementation evidence. Chat attachments are not exposed as files by the available tools and were not republished. Existing implementation sources: `CreateMenu.tsx`, `AgentWindowPicker.tsx`, `ChatPane.tsx`, `ImageModeControls.tsx`, `packages/shared/src/chat.ts`, and `phone-access.ts`. Current requirements are recorded in the inline-agent creation and folding-phone specs.
