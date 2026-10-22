---
title: "Grid model selection and chat-mode menus (2026-10-07)"
area: desktop
split-from: SPEC.md (2026-10-22)
---

# Grid model selection and chat-mode menus (2026-10-07)

A model chosen in a Grid chat must immediately become that chat's shared composer's selection when the save completes. Sending from the shared composer uses the chosen provider/model for Claude and built-in Model Server models, including an empty new conversation, without asking the user to pick the same model again. Model changes are scoped to the owning chat and persist across layout changes/reloads. Failed saves show an error.

The Mode control (Ask, Guardrails, YOLO) opens a viewport-contained menu outside the Grid composer's scrolling/clipping containers. Pointer selection persists the owning chat's mode; Escape dismisses it and returns focus. Grid and Focus retain the same policies and privacy controls. No credentials, inference requests or tool executions occur merely from changing a model or opening a mode menu.

Local provider streaming accepts LF and CRLF framing, including line endings split across network chunks. OpenAI-compatible and Ollama stream error payloads surface their reason instead of silently ending. TypeScript and Rust providers share regression expectations. A loaded 3B Model Server model producing no GPU/memory activity is consistent with the Grid request being blocked before inference, but that specific machine's inference remains unverified; no hardware-capacity cause is asserted.
