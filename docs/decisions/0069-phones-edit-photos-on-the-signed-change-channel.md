---
status: proposed
date: 2026-11-08
---

# 0069. Phones edit photos on the signed Change channel

## Context

Phones make pictures through `chat:generateImage` as a **Change call with a signed Change v1 proof** (`spec/phone/image-chats.md` in #2211, by Philip). That boundary accepts a prompt and the six picture settings, and refuses input photos. On the computer, an attached photo turns a Photo turn into an edit ([decision 0067](0067-edit-photos-inside-the-photo-agent.md)). So a phone can make a picture but cannot edit one.

An earlier draft of this record (#2221) made `chat:generateImage` an unsigned agent-class call instead. It was withdrawn: the signed Change boundary stays.

## Options considered

1. **Leave editing off on phones.** Simplest, but the Edit button and attached photos, which work on the computer, stay missing on iOS and Android.
2. **A separate edit channel.** Duplicates the boundary, the proof and the tests for a turn that differs only by its photos.
3. **Extend the signed payload** with the photos to edit and an edit size, inside the same proof.

## Decision

Option 3. The phone's `chat:generateImage` request may also carry:

- `images`: at most four photos, each a `data:image/png|jpeg|webp;base64,` URL, inside the relay's frame limit. No paths, URLs, SVG or file references.
- `size`: `{ width, height }` only, under the same bounds as `params` (integers 256-2048, multiples of 64).

Both keys are optional and are bound by the signed proof with the rest of the request. Everything else in the image chats boundary is unchanged.

The daemon also refuses photos sent to a model that cannot edit or animate them, whichever client sent them. The chat gets the reason as its reply and nothing is generated.

## Consequences

- iOS and Android gain **Edit** under a made picture (not under clips) and photos attached in Photo chats. Edit fetches the full size with `session:photo` and falls back to the thumbnail.
- Larger requests: up to four photos per signed call. Phones scale them to 1536 px on the long side before sending.
- Needs Philip's acceptance, as the owner of the phone security boundary. It is built only after #2211 and #2212 land.
