---
title: "New agent window defaults"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# New agent window defaults

Implemented; 67 focused tests, 1,145 desktop tests, desktop typecheck, isolated production build and five docs tests pass: an explicit model choice in a chat (including its expanded picker) or Add window becomes the next agent window's saved provider/model pair. Auto is saved as Auto, not the model it later resolves to. Browsing providers, loading catalogs and switching existing chats do not rewrite defaults or other chats' choices. New chats prefer the saved pair over a transient active catalog; startup restores settings before loading that catalog. A successful permission-mode change saves Ask, Guardrails or YOLO as the default for new chats; failed or missing-session updates do not. Effort remains app-wide and execution mode retains its existing saved default and sandbox setup flow. Incognito and Offline remain explicit session-only privacy choices, never inherited globally. No new network calls beyond existing settings/session APIs, permissions or telemetry. Acceptance: exact provider/model pairs, Auto, saved-default startup ordering, session-choice precedence, failed permission updates, and effort/execution/privacy regressions. Isolated visual interaction and packaged-app verification remain pending with the parent task.
