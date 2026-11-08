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

**The gap.** Name detection already marks Z-Image, Qwen Image, HiDream, Wan and others as image models, but none of them had a companion set. A user who found one and downloaded it got a model that is listed and does not start. There is no curated image or video list and no hardware fit for image models.

## Capabilities and new companion sets `[implemented 2026-11-08 (#2177); unit-tested against real file names; not yet run against a real sd-server]`

- **Each set says what it can do:** `capabilities` is `create`, `edit` or both, returned with the companion status (`engine:imageCompanions`). FLUX.2 klein 4B and 9B: create and edit. SD 3.5, FLUX.1, Z-Image, Qwen Image: create. Qwen Image Edit: edit.
- **Z-Image** (Turbo and base): FLUX.1's VAE from Comfy-Org's ungated copy (Black Forest Labs' own repository is gated) and the Qwen3 4B Instruct 2507 encoder, 2.8 GB together. Turbo uses 8 steps at CFG 1; the base model 20 steps at CFG 5.
- **Qwen Image Edit** (original, 2509, 2511): the Qwen Image VAE, the Qwen2.5-VL 7B encoder and its vision half, a new `llm_vision` role passed as `--llm_vision`. 2511 adds the `qwen_image_zero_cond_t` model switch it needs. 20 steps at CFG 2.5.
- **Qwen Image**: the same VAE and encoder as Qwen Image Edit, so a user who has one needs only the vision file for the other.
- **Launch arguments per family:** Qwen Image models start with flow shift 3 and the euler sampler, as sd.cpp documents; sd-server takes them as its default generation settings.
- **No set on purpose:** Qwen Image 2.1 (a different encoder and VAE, research license) and FLUX.2 dev (a 24B encoder).
- **Guarded by tests:** every set's files name a source and a size, a gated file always has an ungated stand-in, and a file name on disk is never reused for a different source.

## Picture recommendations per machine `[implemented 2026-11-08 (#2177); unit-tested on the reference machines; memory is an estimate, no speed measured]`

`machine:recommendations` answers `imageTasks` beside the chat tasks, from the same bundled feed (`crates/nekko-machine/feed/source.json`, built by `node scripts/model-feed.mjs`):

- **Two tasks:** **Create pictures** (Qwen Image, Z-Image Turbo, FLUX.2 klein 4B, best first) and **Edit photos** (Qwen Image Edit 2511, FLUX.2 klein 4B). Every candidate can do the task's capability; the script refuses a source that says otherwise.
- **Sizes come from the files:** each quant's size from the repository tree and each companion file's size from Hugging Face, never typed by hand. A nekkod test checks that every recommended file, once downloaded, resolves to the companion set the feed names, with the same files and sizes, none of them gated. So a pick cannot download and then fail to start (acceptance criterion 2).
- **Memory, an estimate:** every file resident plus a 2 GiB allowance for sd.cpp's working buffers at 1024x1024. The allowance is an assumption, recorded in the feed source, until peak memory is measured per family. Fit uses the same budget and thresholds as chat models.
- **Offload when it is the only way:** on a discrete GPU that cannot hold every file, a quant still fits with sd.cpp's `--offload-to-cpu` when the largest file plus the allowance fits in VRAM and system RAM holds all the files. The pick then says `offloadToCpu: true`, and the install in step 4 must turn on the model's **Offload weights to CPU** preset, which is off by default. A quant that fits without offload is preferred, even a smaller one. Unified memory (Apple Silicon) never offloads.
- **From system RAM**, on a CPU-only machine or a GPU too small even to offload, the smallest model that fits is picked, since every step runs on the CPU.
- **No speed:** there is no seconds-per-image figure until one is measured, so none is shown. Upgrade nudges stay chat-only.
- **Reference picks:**

  | Machine | Create pictures | Edit photos |
  |---|---|---|
  | RTX 5090 32 GB | Qwen Image Q4_K_M, all on the GPU | Qwen Image Edit 2511 Q4_K_M |
  | RTX 4060 8 GB | Z-Image Turbo Q4_K, offloaded | FLUX.2 klein 4B Q4_0, offloaded |
  | M5 Max 64 GB | Qwen Image Q8_0 | Qwen Image Edit 2511 Q8_0 |
  | M2 16 GB | Z-Image Turbo Q4_K (tight) | FLUX.2 klein 4B Q4_0 |
  | CPU only, 16 GB | Z-Image Turbo Q4_K | FLUX.2 klein 4B Q8_0 |

## Choosing a picture model in the Photo chat `[implemented 2026-11-08 (#2177); unit-tested and captured in an isolated renderer fixture with a stub engine; not yet run against a real download]`

An empty Photo chat with no picture model on this computer shows **Choose a picture model** under its heading (`PhotoModelSetup` in the chat's welcome), in place of the old "No image models yet" line:

- **Up to three cards** from the Create pictures recommendations: the pick first (selected), then the other candidates. Each gives the name, one line on what it is good at, the total download, and the fit in words: "Fits your RTX 4060", "with little room to spare", "by keeping part of it in system memory, so pictures take longer", "Runs on the processor here...", or "Too large for this computer" (that card disabled). No quant, GGUF, VAE, CFG or speed figure appears, and nothing says "runs well" (acceptance criterion 4).
- **Download and set up · size**: installs the picture engine (sd.cpp) when missing, then queues the model through `engineDownloadModel`, the Models page's own job. When the weights land it fetches the supporting files (`engineDownloadImageCompanions`) without asking again. When everything is on disk it turns on the model's **Offload weights to CPU** preset if the pick needs it, then makes it the chat's model with the family's steps and CFG. The chat's image controls then read the library again.
- **Progress** shows as three steps (engine, model, supporting files) with a bar, the size and time left, and **Cancel**. Every state is read from the engine's jobs and library, so leaving the chat and coming back resumes where the download is, and the same job shows in Models > Downloads (acceptance criterion 3).
- **A stopped download** says why and offers the button again. When no card fits, the setup says so and points to **See all picture models** (Model Server for now; the Image filter is step 5).
- **Someone with picture models of their own** does not see it; they pick in the chat's controls as before.
- **Not here yet:** the cloud card (step 8), and the first-use introduction's **Choose your first model** step, which waits for the introduction itself (PR #2149).

## Picture models in Models `[implemented 2026-11-08 (#2177); unit- and daemon-tested, captured in an isolated renderer fixture with a stub engine]`

- **Kind filter:** above the model list, **All · Chat · Pictures · Video**. A family is video when its name or tags say Wan, LTX, HunyuanVideo, CogVideo or Mochi (checked first: a Wan file on disk is a picture model to the engine, but it makes video), pictures when a downloaded file is classified `image`, a catalog entry is tagged `image`, or a name matches the engine's picture-model names, and chat otherwise. **Video** says Nekko can't make videos with these yet. **Pictures** with nothing on disk and no search points to the picks above and to Hugging Face search. The curated starter list is unchanged: it holds chat models only.
- **Best for this machine** lists **Create pictures** and **Edit photos** after the chat tasks: name, quant, a fit chip ("fits", "tight fit", "fits with offload", "tight, with offload"), "~memory of budget" marked as an estimate, the download including supporting files, the license, and **Download**. No speed.
- **Supporting files follow every picture download:** when any image model with a companion set finishes downloading, whether from Models, a recommendation or the Photo setup, the daemon queues its text encoders and VAE itself. Files already on disk are skipped.
- **Offload follows the recommendation, wherever the model came from:** when a Photo chat chooses a picture model (including the first one it picks on its own), Nekko turns on its **Offload weights to CPU** preset if this machine's recommendations say it only fits that way. The rest of the preset is kept.

## Editing a photo in Photo `[implemented 2026-11-08 (#2177); unit-, turn- and engine-tested, captured in an isolated renderer fixture with a stub engine; not yet run against a real sd-server]`

Decision 0067, as built:

- **A photo in the composer means edit.** A Photo chat takes photos to edit from the photo button beside the composer, a paste or a drop: PNG, JPEG and WebP only, at most four, each scaled to 1536 px on its longest side before it is attached (sd.cpp decodes references at their own size). **Edit** under any picture the chat made attaches it the same way.
- **The engine gets them as reference images.** The turn keeps the photos on the user message, so the transcript shows what was changed, and sends them as `refImages`; the request carries them to sd-server as `ref_images` inside `sd_cpp_extra_args` on the same `/v1/images/generations` call (sd.cpp's native schema takes data URLs there). The engine refuses more than four, anything that is not a `data:image/...;base64,` URL, or over 20 MB in all, under the router's 25 MB request limit.
- **The edit keeps the photo's shape:** made at about the chat's pixel count, in the photo's proportions, in multiples of 64 (256-2048). That size is the turn's only; the chat's own size is unchanged.
- **A model that cannot edit is never sent a photo.** Before sending, the chat reads the model's capabilities. Without `edit` (or with no known set) the photo and prompt stay in the composer and an offer opens above it: a picture model already on this computer that edits (**Use FLUX.2 klein 4B**, its supporting files fetched first when missing), else the **Edit photos** picks for this machine (Qwen Image Edit 2511, FLUX.2 klein 4B) with the same one-press download as the first picture model. Once the chat has an edit model, sending again is all that is left. **Not now** closes it.
- **The other way round:** a prompt with no photo to a model that only edits says so instead of making a picture it is not built for.

## Simple photo controls and complete-package readiness `[implemented; isolated UI verification, pixel review pending]`

Follow-up to [#2170](https://github.com/nekko-labs/nekko-agent/issues/2170), reconciled with the landed #2177 stack rather than replacing it with a second setup or editing system:

- The composer leads with model and **Shape** (Square, Landscape, Portrait, Wide, Tall). Existing dimensions not in that list remain selected as Custom. New presets are multiples of 64, and Wide/Tall use exact 16:9/9:16 dimensions.
- **Advanced** contains Steps, **Prompt guidance (CFG)** and Seed with plain-language explanations. **Restore model defaults** restores family Steps/CFG and random seed without changing model or shape. Technical values remain available and saved per chat. Failed preference saves are visible rather than ignored; integer-only settings do not accept decimals.
- A downloaded model's detail uses one **Finish photo setup** action for its missing engine and supporting files, a three-part checklist, retryable errors and optional package details. It reuses the existing engine/download APIs and jobs, including cancellation under Downloads. No new runtime, model source, encoder set, cloud service or upload path is introduced.
- The first-download flow also refuses to finish while the image engine is absent or the recommended model's companion set could not be verified. Unrelated chat-engine downloads no longer appear as photo-engine progress.
- **Ready** requires both an installed image engine and a known, ready companion set. Edit-only models say ready to edit, not create. Unknown sets stay explicitly unverified and keep the existing advanced custom paths. Supporting-file sizes are explicitly not the engine's download size.
- **Open Photo** opens the existing photo chat; the landed capability check, attachment processing, edit-model offer, model recommendations and CPU-offload behavior are preserved.

Acceptance: focused component tests and desktop typecheck/build pass; actual isolated Electron tests cover default/Advanced views, failure and retry, missing-runtime readiness, opening Photo and 1100/744/390/320 widths in dark/light. Captured pixels still require inspection: the browser screenshot tool timed out and native screenshot inspection returned `UnknownVizError`. No claim of real downloads, inference quality, native-phone parity or physical-foldable verification is made by these fixture checks. The earlier live sd-server verification gap in #2177 remains separate.

## Local video clips (experimental) `[implemented 2026-11-08 (#2177); engine-, turn- and daemon-tested against a stand-in sd-server; not yet run against a real one]`

Built overnight on 2026-11-08 with decisions taken without review (Davide asked for it); each is marked **Decision** so it can be revisited, and recorded in [decision 0068](../../docs/decisions/0068-local-video-clips-run-as-sd-server-jobs.md) (proposed).

- **One video model for now: Wan 2.2 TI2V 5B** (Apache-2.0), text or a first frame to a short clip. Its set is its own VAE (Wan 2.2, 1.4 GB) and the umt5-xxl Q8_0 text encoder (6.0 GB); it starts with flow shift 3 and the euler sampler, 20 steps, CFG 6, as sd.cpp's docs/wan.md does. The other Wan models (2.1, 2.2 A14B) need the 2.1 VAE and some a CLIP vision encoder: no set, so they are listed but never recommended.
- **Recommendations:** a third picture task, **Create video clips** (`videoCreate`, `gpuOnly`): a 4 GiB working allowance (an assumption: sd.cpp warns the Wan VAE needs a lot of memory), and never picked from system RAM, where a clip would take hours. An RTX 5090 or an M5 Max gets Q8_0; an 8 GB card or a CPU-only machine gets no pick, with the model listed as too large.
- **Decision: clips are made in a Photo chat for now.** The Video chat type is #2149, still a draft; until it lands, choosing a video model in a Photo chat makes clips, and the Video chat will use the same turn when it does. Models > Video says so.
- **Decision: the daemon talks to the model's own sd-server for clips,** not through the router: a clip is an async job (`POST /sdcpp/v1/vid_gen`, then `GET /sdcpp/v1/jobs/{id}` every second), and a status read names no model to route by. The model is loaded the usual way and kept busy for the whole job, so the idle timer does not unload it; a stopped turn cancels the job on the server (`/cancel`).
- **Decision: a clip comes back as an animated WebP,** which the transcript's picture element plays with no new player: WebM needs an sd-server built with it and fails the request otherwise. It is kept on the reply like a picture, with `generated.video` (frames and fps) and the transcript line says "33 frames at 16 fps (2.1 s clip)". Clips have no **Edit** button.
- **Decision: size and length.** The chat's shape (or, with a photo, the photo's) at about 832x480 (sd.cpp's example area), in multiples of 32 from 256 to 1280, for that turn only; 33 frames at 16 fps (about 2 s) unless the request names `videoFrames` (1-121, in steps of 4 as Wan's video VAE needs) and `fps` (1-60). There is no control for length in the UI yet.
- **A photo attached to a video model is the clip's first frame** (`init_image`): "animate this photo". Only the first photo is used, and the chat says so when there are more. A video model is never offered as an edit model and never sent the edit offer.
- **A clip that cannot finish says so:** the turn ends with an error, never a hang or a broken picture, when the model's process goes away mid-job, sd-server stops answering or loses the job for about 30 seconds, or a job completes with no clip.
- **Progress** reads the job's preview: "Making a 832×480 clip · step 7 of 20".

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
| Edit, higher quality | **Qwen-Image-Edit-2511** | Strong instruction edits; larger (12.8 GB at Q4_K_M, plus 5.8 GB of encoders and VAE) | Apache-2.0 |
| Create, text inside pictures | **Qwen-Image** | Shares its encoder and VAE with Qwen-Image-Edit | Apache-2.0 |
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
- Phones: `chat:generateImage` is open to a paired phone with Change access ([decision 0069](../../docs/decisions/0069-phones-run-photo-turns-on-the-computer.md)), as an agent-class channel with its own allowlist: the chat, the prompt, the composer's picture settings, at most four photos as PNG, JPEG or WebP data URLs, and an edit size; no paths, presets or other model settings. The daemon refuses photos to a model that cannot edit or animate them, whichever client sent them. Choosing a new picture model and downloading stay on the computer.
- Downloads come only from the pinned repositories in the companion sets and the curated list.

## Plan

Each is one PR (a stack where noted). Tracked in the issue linked from this file's PR.

1. **Engine: bump sd.cpp** to the current release, if its changes are needed; otherwise keep the pin.
2. **Engine: model capabilities and companion sets** `[implemented, see above]`: `create` / `edit` per family; Z-Image, Qwen Image and Qwen Image Edit sets; `video` arrives with the Wan set in step 7.
3. **Recommendations: image rows** `[implemented, see above]`: download sizes from Hugging Face, memory needed, fit per machine, offload when needed. Still open: a measured peak memory per family to replace the 2 GiB allowance, and measured seconds per image. Video rows come with step 7.
4. **Photo: choose a model from the chat** `[implemented, see above]`: the cards, the hand-off to the shared download job, inline progress. The introduction's **Choose your first model** step follows when #2149 lands.
5. **Models: Image and Video filters** `[implemented, see above]`: kind filters, picture picks in Best for this machine, supporting files fetched after any picture download, offload set from the recommendation.
6. **Photo: edit an existing photo** `[implemented, see above]`: attachments and **Edit** on a reply, reference images to sd-server, the capability check and the edit-model offer.
7. **Video: local generation (experimental)** `[implemented, see above]`: the Wan 2.2 TI2V 5B set, `videoCreate` recommendations, the clip job on `/sdcpp/v1/vid_gen` with progress and cancel, the clip in chat. Still open: the Video chat (#2149), a length control, measured memory and time per clip.
8. **Cloud image and video providers:** bring-your-own-key providers, privacy prompts under decision 0065.
9. **Phones:** the same menu, introductions and model choice on iOS and Android, driving the computer; a gaps row in [iOS and Android stay in step](../phone/ios-and-android-stay-in-step.md) for anything that lands on desktop first.
10. **Docs:** a "Make pictures and videos" page on the docs site.
