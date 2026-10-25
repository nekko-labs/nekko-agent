---
title: "New agent window defaults"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# New agent window defaults

Implemented; 67 focused tests, 1,145 desktop tests, desktop typecheck, isolated production build and five docs tests pass: an explicit model choice in a chat (including its expanded picker) or Add window becomes the next agent window's saved provider/model pair. Auto is saved as Auto, not the model it later resolves to. Browsing providers, loading catalogs and switching existing chats do not rewrite defaults or other chats' choices. New chats prefer the saved pair over a transient active catalog; startup restores settings before loading that catalog. A successful permission-mode change saves Ask, Guardrails or YOLO as the default for new chats; failed or missing-session updates do not. Effort remains app-wide and execution mode retains its existing saved default and sandbox setup flow. Incognito and Offline remain explicit session-only privacy choices, never inherited globally. No new network calls beyond existing settings/session APIs, permissions or telemetry. Acceptance: exact provider/model pairs, Auto, saved-default startup ordering, session-choice precedence, failed permission updates, and effort/execution/privacy regressions. Isolated visual interaction and packaged-app verification remain pending with the parent task.

## Agent panel creation and utility groups

Implemented; desktop typecheck, 16 focused tests and isolated hidden-renderer interaction checks pass; matching default-theme screenshots inspected: clicking the Agents panel plus button opens a new agent window. Its hover menu still offers Agent, Photos and Videos, and Terminal. Non-empty Terminals and Photos and videos groups appear above the normal agent groups, independent of the selected agent grouping. Empty utility groups never appear, and utility cards are not duplicated in project/status/date groups. Project creation and drag targets apply only to the agent project groups. The empty agent greeting keeps its heading but omits the redundant instruction about sending the first message. The desktop title bar uses the smooth outline brand mark without a boxed pixel avatar. These changes use existing local session and terminal data, with no new permissions or network calls.
