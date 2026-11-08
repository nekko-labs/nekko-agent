---
status: proposed
date: 2026-11-08
---

# 0067. Edit existing photos inside the Photo agent, chosen by an attached image

## Context

Photo makes pictures from text with a local model. The next request is editing a photo the user already has. The pinned stable-diffusion.cpp supports editing through a reference image for several families (FLUX.2 klein with the same files it creates with, Qwen Image 2.1, Qwen Image Edit, FLUX.1 Kontext). The creation menu already offers four entries (Agent, Photo, Video, Terminal; #2149). Spec: [Photo and Video models](../../spec/models/photo-and-video-models.md).

## Options considered

1. **A separate "Edit photo" agent** in the menu. Clear label. Adds a fifth entry, makes the user choose before they know what they want, and splits the natural loop "make a picture, then change it" across two chats.
2. **Inside Photo, decided by the input:** no image attached means create; an attached image (or **Edit** on a reply) means edit. Each model declares create, edit or both; when the chat's model cannot edit, Photo offers one that can. One place for pictures, iteration stays in one chat, and models that do both need no second download. Costs a capability flag per model family and a clear message when the model cannot edit.
3. **Editing as a tool in an ordinary Agent chat.** Lets an agent edit images as part of larger work. Hides the feature from people who just want to fix a photo, and depends on a chat model calling the tool well.

## Decision

Option 2. People think "I want to change this photo", not "I need an edit model". Keeping editing in Photo, triggered by the attachment, matches that and keeps the menu at four entries. Option 3 can come later on top of the same edit request, as a tool that Photo's engine serves.

## Consequences

- Image model families gain capability flags (`create`, `edit`), and the curated list prefers models that do both.
- The composer must handle an attachment the model cannot use with an offer, never by ignoring the image.
- Editing a personal photo with a cloud model sends it out; that path asks under [decision 0065](0065-outward-calls-that-carry-private-data-ask.md).
- If users look for "edit" in the menu and do not find it, revisit with a menu alias that opens Photo with a file picker, not a separate agent.
