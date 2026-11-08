---
status: accepted
date: 2026-11-08
---

# 0069. Phones may run Photo turns on the computer's own picture models

## Context

`chat:generateImage` was refused on the phone channel: the native apps only showed Photo chats. Davide decided on 2026-11-08 that phones should make and edit pictures too (spec: [Photo and Video models](../../spec/models/photo-and-video-models.md), plan step 9). A Photo turn runs a model already on the computer, with a prompt and, optionally, photos the person sends; it is the picture equivalent of `chat:send`, which phones already have. Phones reach the computer through the relay, sealed, after pairing (decisions 0012, 0016). Security decisions so far were accepted by Philip; this record is accepted by Davide, the feature's owner, with Philip's review requested on its PR.

## Options considered

1. **Keep it refused.** Safe, but Photo chats are read-only on a phone, against "iOS and Android stay in step" with the desktop.
2. **A `change` channel** (a signed proof per call, like saving a file). Strong, but a Photo turn changes nothing outside its own chat, and phones send chat turns without a proof today.
3. **An `agent` channel, like `chat:send`,** with its own allowlist: the chat, the prompt, the picture settings the composer saves (model id, size, steps, CFG, seed), photos to edit, and an edit size. Nothing else.

## Decision

Option 3. The turn reaches no file, setting or model outside the chat. What a phone may send is checked by shape in both gates (`phoneImageTurn` in TS, `phone_image_turn` in Rust, from one `phone-access.json`): only those keys; numbers where numbers go; photos as `data:image/png|jpeg|webp;base64` URLs, at most four, inside the relay's 9 MB frame; no paths, presets, encoder files or other model settings. The daemon refuses photos to a model that cannot edit or animate them (`image_turns.rs`), so no client can skip the desktop's own check. Setting up or downloading a picture model stays on the computer.

## Consequences

- A paired phone with Change access can spend the computer's GPU time on pictures and clips, as it already can on chat turns; `chat:abort` stops it.
- The access switches, the audit log and the activity limit apply as for `chat:send`.
- Native apps gain Photo turns (create, attach a photo, **Edit** on a reply). Model choice beyond what the chat already has, and downloads, remain desktop-only until decided otherwise.
