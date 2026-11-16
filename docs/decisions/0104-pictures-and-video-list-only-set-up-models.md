---
status: accepted
date: 2026-11-17
---

# 0104. Pictures and Video list only the models Nekko has set up; the rest of Hugging Face waits behind a tap

Issue: [#2894](https://github.com/nekko-labs/nekko-agent/issues/2894). Spec: [photo and video models](../../spec/models/photo-and-video-models.md).

## Context

Models searches Hugging Face for any GGUF repository matching a word, 20 results by downloads. For chat models that works: one file, and it starts. Under Pictures and Video it filled the list with remixes and re-uploads, some with a few hundred downloads, and most of them cannot start, because a picture model also needs a text encoder and a VAE that Nekko fetches only for the models it has set up. Davide asked for a shorter list of models that are both widely downloaded and well regarded.

Searches on 2026-11-17 (flux, wan, z-image, qwen-image, stable-diffusion, ltx, hunyuan, hidream) showed that a download bar alone does not shorten the popular families: every one of the top 20 for flux, wan and qwen-image had over 40,000 downloads, many of them uncensored remixes from one-off publishers. Hugging Face has no rating, only likes.

## Options considered

1. **A download and likes bar on the search.** Cuts the tail of old families only, and still lists models that do not start.
2. **Remove everything Nekko has not set up.** The cleanest list, but closes the search to people who know what they are doing, which the spec promised to keep.
3. **Set-up models listed; known publishers above a download bar behind a tap; the rest dropped.**

## Decision

Option 3 (Davide, 2026-11-17).

- Listed: the recommendation list's picture and video candidates, and any repository with a file already on the computer.
- Behind **Show N more from Hugging Face**, closed by default, with one line of warning: picture and video repositories from leejet, city96, QuantStack, unsloth, second-state, gpustack, calcuis or bullerwins with at least 10,000 downloads.
- Not listed: every other picture or video repository.
- Downloads and reputation decide what enters the set-up list when it is edited, with the license and a tested set of files. They are not a filter applied to live search results.
- Chat repositories are untouched. The rule lives in the desktop renderer (`modelFamilies.ts`); the engine's search and the CLI's `model_search` return what they did.

## Consequences

- A good repository from a publisher not on the list cannot be found in Models. The publisher list and the bar are judgment and need a look whenever the recommendation list changes.
- A repository that names what it makes neither in its name nor in its Hugging Face task is still treated as chat and listed.
- It was wrong if people regularly reach for the CLI or a manual file to get a picture model the list dropped.
