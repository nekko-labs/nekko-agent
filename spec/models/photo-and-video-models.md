---
title: "Photo and Video models: guided from the chat to a model that works"
area: models
---

# Photo and Video models: guided from the chat to a model that works

`[proposed 2026-11-08; nothing below is implemented unless marked. Plan only, see "Plan" at the end.]`

**What it is for.** Nekko Agent runs chat and coding models today, local and cloud. The next step is models that only make pictures and videos. Someone who presses **Photo** or **Video** should end up making one, without first learning what a diffusion model, a text encoder, a VAE or a workflow graph is. Tools like ComfyUI give an expert full control by wiring those parts together by hand. Nekko does the opposite: a short, curated choice that downloads a complete, working set of files with the right settings already applied.

**Related.** The Photo / Video split and first-use introductions ([#2099](https://github.com/nekko-labs/nekko-agent/issues/2099), PR #2149, [inline agent-window creation](../desktop/inline-agent-window-creation.md)); [your first local model](first-local-model.md), whose guided screen this follows; [hardware-aware recommendations](hardware-aware-model-recommendations.md), which deferred image rows to this feature; [decision 0067](../../docs/decisions/0067-edit-photos-inside-the-photo-agent.md) (editing lives inside Photo).

## What exists today `[shipped]`

- **One engine for images:** stable-diffusion.cpp's `sd-server`, pinned in `crates/nekko-engine/src/builds.rs` (`master-1028-37bc88b`, 2026-10-29), installed and started like llama.cpp.
- **Photo chats** (`chatType: 'image'`) send each prompt to a local image model and reply with a picture. Model, size, steps and CFG are kept per chat.
- **Companion files** (text encoder, VAE) download in one step for four families only: FLUX.2 klein 4B and 9B, SD 3.5 and FLUX.1 (`image_companion_sets` in `crates/nekko-engine/src/acquire.rs`). Choosing a model adopts its family's tuned steps and CFG.
- **With no image model,** Photo shows one line, "No image models yet. Get one in Model Server", which opens the general Model Server page with a Hugging Face search.

**The gap.** Name detection already marks Z-Image, Qwen Image, HiDream, Wan and others as image models, but none of them has a companion set. A user who finds one and downloads it gets a model that is listed and does not start. There is no curated image or video list and no hardware fit for image models.

## What the pinned engine can already do `[checked against the sd.cpp README and docs at 37bc88b, 2026-11-08; not run]`

- **Images:** SD 1.x/2.x/XL, SD 3/3.5, FLUX.1, FLUX.2 dev/klein, Z-Image, Qwen Image and 2.1, HiDream-O1, Chroma and more.
- **Editing an existing image** (reference image, `-r` / `POST /v1/images/edits`): FLUX.2 klein (same files as creation), Qwen Image 2.1, Qwen Image Edit (2509/2511), FLUX.1 Kontext.
- **Video:** Wan 2.1 / 2.2, LTX-2.3 / 2.5, HunyuanVideo 1.5, through `sd-server`'s `/sdcpp/v1/vid_gen`, with built-in Wan presets.

So local video does not need a second engine such as ComfyUI.

## The flow (proposed)

### 1. Pressing Photo or Video with no suitable model

The first-use introduction (#2149) runs first. If no model can do the job, its single action becomes **Choose your first model** instead of **Try Photo** / **Try Video**. Closing the introduction leaves the same choice in the chat's empty state, which replaces today's single line.

### 2. The choice, inside the chat

Two or three cards, picked for this machine, each in plain words:

- A name, what it is good at in one line ("Fast, good for everyday pictures", "Best quality, slower"), the total download size, and a fit line ("Runs well on your RTX 4060", "Fits with little room to spare", "Too large for this computer").
- **Download and set up**, with the size beside it. Nothing downloads before the press.
- One **cloud** card when a provider is configured, or when no local pick fits ("Use a cloud model: needs an API key, your prompt is sent to <provider>").
- **See all image models** / **See all video models**: opens Models > Local model server with the Image or Video filter applied.

No quant codes, steps, CFG, sampler or "VAE" appear on the cards. They stay one press away in the chat's own controls, as today.

### 3. The download goes into Models, not into the chat

The press queues the same job the Models page would: the engine build when missing, the model weights and every companion file, shown as **one download per model** in Models > Downloads. The chat shows that job's progress (bar, size, time left, Cancel) and does not own a second copy. When it finishes, the model becomes the chat's model with its family defaults, and the composer is ready.

**Why not a chat-only download.** Two places that hold models would disagree about what is installed, where it is and what to delete. Models stays the single owner; the chat is a shortcut into it.

### 4. Models page

Image and video models appear in the same models surface with **Image** and **Video** filters, the same curated picks at the top, and the same fit chips. A curated pick is never offered unless its companion set is complete, so everything on the list starts.

### 5. Editing an existing photo, inside Photo

See [decision 0067](../../docs/decisions/0067-edit-photos-inside-the-photo-agent.md). Photo has two ways in, one agent:

- **Create:** a prompt with no image attached.
- **Edit:** a prompt with one or more images attached (drag in, paste, pick a file), or **Edit** on a picture Photo just made, which attaches it to the composer.

Each model declares what it can do: create, edit, or both. When an image is attached and the chat's model cannot edit, the composer says so and offers the best edit-capable model for this machine (the same card and download as step 2). Prefer models that do both with one set of files (FLUX.2 klein 4B), so most users never meet the second download.

### 6. Video

Video keeps the planning and tool-based editing chat from #2149, and gains real generation when a video model is present:

- **Local, experimental:** offered only when the machine fits it, with the expected time per clip stated before download ("about N minutes for 5 seconds", measured, never guessed).
- **Cloud:** the default suggestion when the machine does not fit.

## Candidate models `[licenses read from each Hugging Face model card on 2026-11-08; third-party review per docs/runbooks/third-party.md still required before any ships]`

| Use | Model | Why | License |
| --- | --- | --- | --- |
| Create, small machines | **Z-Image-Turbo** (6B) | Fast; sd.cpp documents running it in 4 GB of VRAM quantized | Apache-2.0 |
| Create + edit, one set of files | **FLUX.2 klein 4B** | Already has a companion set; edits with the same files | Apache-2.0 |
| Edit, higher quality | **Qwen-Image-Edit-2511** | Strong instruction edits; larger | Apache-2.0 |
| Video, local | **Wan 2.2 TI2V 5B** | Text and image to video; the smallest current Wan | Apache-2.0 |
| Already supported, keep | SD 3.5, FLUX.1 | Existing companion sets | Model-specific community licenses |

**Not offered by default:** Qwen-Image 2.1 and its Turbo (Qwen research license), FLUX.2 klein 9B and FLUX.2 dev (FLUX non-commercial license), HunyuanVideo 1.5 (its license excludes the EU, UK and South Korea), LTX-2 (paid license above a revenue threshold). Anyone can still download them from the search; the curated list does not recommend them.

**Cloud candidates (bring your own key):** images: OpenAI GPT Image, Google Gemini image (Nano Banana), Black Forest Labs FLUX API, Ideogram. Video: Google Veo, Kling, Runway, Seedance. OpenAI's Sora API is retired and is not a candidate. Versions and prices are checked when that PR is written, not here.

## Acceptance criteria

1. On a fresh install with no image model, pressing Photo leads to a download that, once finished, produces an image from the next prompt with no other screen visited.
2. Every curated pick starts on first try: its companion set is complete and covered by a test.
3. The chat's download and the Models page's download are the same job; cancelling either cancels it.
4. Fit lines never claim a model "runs well" without a measurement or a documented memory figure behind it.
5. Attaching an image to a Photo chat whose model cannot edit offers an edit-capable model, never a silent failure or a picture that ignores the attachment.
6. Video generation is never shown as available on a machine that cannot run it, and its time per clip is stated before the download.

## Privacy and security

- Local models: prompts and attached photos stay on the computer.
- Cloud models: a prompt, and especially an attached personal photo, is sent to the provider. That follows [decision 0065](../../docs/decisions/0065-outward-calls-that-carry-private-data-ask.md) (outward calls carrying private data ask). The cloud card names the provider before anything is sent.
- Phones: image generation stays closed on the phone channel (`chat:generateImage` is denied today). Opening it is its own decision, not part of this plan.
- Downloads come only from the pinned repositories in the companion sets and the curated list.

## Plan

Each is one PR (a stack where noted). Tracked in the issue linked from this file's PR.

1. **Engine: bump sd.cpp** to the current release, if its changes are needed; otherwise keep the pin.
2. **Engine: model capabilities and companion sets:** `create` / `edit` / `video` per family; add Z-Image-Turbo and Qwen-Image-Edit-2511; tests that every curated pick resolves to a complete set.
3. **Recommendations: image and video rows** in the feed: download sizes from Hugging Face, memory needed, fit per machine, measured seconds per image where available.
4. **Photo: choose a model from the chat:** the cards, the hand-off to the shared download job, inline progress, the introduction's **Choose your first model** step.
5. **Models: Image and Video filters** with the same curated picks and fit chips.
6. **Photo: edit an existing photo:** attachments and **Edit** on a reply, the edit request to `sd-server`, the capability check and the edit-model offer.
7. **Video: local generation (experimental, stack):** the Wan companion set, the video turn on `/sdcpp/v1/vid_gen`, job progress and recovery, the video reply in chat, the hardware gate.
8. **Cloud image and video providers:** bring-your-own-key providers, privacy prompts under decision 0065.
9. **Phones:** the same menu, introductions and model choice on iOS and Android, driving the computer; a gaps row in [iOS and Android stay in step](../phone/ios-and-android-stay-in-step.md) for anything that lands on desktop first.
10. **Docs:** a "Make pictures and videos" page on the docs site.
