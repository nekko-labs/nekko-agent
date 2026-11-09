---
status: accepted
date: 2026-11-09
---

# 0072. Chat pictures live beside the chat, and a running turn's saves are held

## Context

Every chat is one JSON file (`<data>/sessions/<id>.json`), and a running turn
rewrote the whole file on each step and each tool result. On the maintainer's
machine (2026-11-09) 663 chats held 450 MB of JSON: tool output text 48%, tool
screenshots 28%, user and generated images 7%. A long agent chat is several
megabytes, so five to ten busy chats rewrote tens of megabytes a minute, and
the same screenshot was written again on every save after it arrived.

## Decision

- **Pictures beside the chat.** When a chat is written, an image data URL in a
  message's `images` or `toolResult.images` (4 KB or more, of a known image
  type, that decodes and re-encodes byte for byte) is written once to
  `sessions/blobs/<sha256>.<ext>` as its decoded bytes, and the chat file holds
  `nekko-blob:<sha256>.<ext>` in its place. Reading a chat through the store
  puts the data URL back, so the engine, the windows, the phone and sync see
  exactly what they saw before. The hourly sweep removes blob files no chat
  refers to once they are an hour old. Tool output text stays inline: the
  model is sent it again on every step, and moving it would change what the
  store hands to the turn.
- **Held turn saves.** A running turn's `step` and `tool_result` checkpoints
  are held in the store and written at most every two seconds; `done`,
  `error`, a steering message and a phase change are written at once. Any read
  or write of that chat through the store writes the held save first, so no
  reader sees the chat older than the turn has made it. Daemon shutdown writes
  every held save.
- **Compact JSON.** Chat files are written without indentation (3.5% smaller
  here; most bytes are base64 and tool output).

## Consequences

- A daemon crash loses at most the last two seconds of a running turn's steps,
  which the existing interrupted-reply recovery already handles.
- An older Nekko Agent reading a newer data folder shows a `nekko-blob:`
  reference where a picture was. Downgrading is not supported anyway; nothing
  breaks beyond the missing pictures.
- Anything that reads chat files without the store must put the pictures back
  itself (`nekko_store::blobs::restore`). Within the repo only a test helper
  did; the legacy-profile import copies `sessions/` recursively, blobs included.
