---
title: "Media tools for chat agents: pictures and clips from any chat"
area: agents
---

# Media tools for chat agents: pictures and clips from any chat

`[proposed 2026-11-18; nothing below is implemented unless marked. Tracked in #2973.]`

**User intent.** A chat's agent should be able to make and edit pictures and short video clips with the same models Photo and Video use. Today only a Photo chat can. A coding or planning chat on Claude, GPT, Gemini or a local model should be able to produce an illustration, an icon, a mock-up or a clip as part of its work, show it in the chat, and use the file it made. Later, the same tools should reach cloud media models (OpenRouter images and video, Recraft vector output) on the user's own key, and Fusion should be able to choose the media model the way it chooses text models.

**Related.** [Photo and Video models](../models/photo-and-video-models.md) (#2177; its plan step 8, cloud providers, is folded in here); [Fusion routing and model tiers](../../docs/fusion-routing.md) and the Router column (#610); [decision 0065](../../docs/decisions/0065-outward-calls-that-carry-private-data-ask.md) (outward calls that carry private data ask); [decision 0067](../../docs/decisions/0067-edit-photos-inside-the-photo-agent.md) (editing lives in Photo); [decision 0068](../../docs/decisions/0068-local-video-clips-run-as-sd-server-jobs.md) (clips are sd-server jobs); [decision 0072](../../docs/decisions/0072-chat-pictures-beside-the-chat-and-held-turn-saves.md) (pictures live beside the chat); [Claude policy](../product/claude-policy.md); [Anthropic image dimension rejection](../models/anthropic-image-dimension-rejection-prevention-and-continuation.md).

## What exists today `[shipped; read from the code 2026-11-18]`

- **Photo chats** (`chatType: 'image'`) send each prompt to a local image model through `chat:generateImage` (`crates/nekkod/src/image_turns.rs`). There is no agent loop: the reply is the picture. Local clips run as sd-server jobs (`/sdcpp/v1/vid_gen`, `crates/nekkod/src/model_server.rs`).
- **No agent can call a media model.** No built-in tool and no bridge tool generates a picture or a clip.
- **Fusion chooses text models only.** Its strategies and tiers (#2737) do not cover image or video models.
- **How tools reach each harness:**

  | Harness | How it runs | Where Nekko's tools come from |
  |---|---|---|
  | Claude Code (`ProviderKind::ClaudeCode`) | an external `claude -p` child | the `nekko_bridge` MCP server, passed with `--mcp-config` (`apps/cli/src/bridge.ts`, `crates/nekkod/src/harness.rs`). It offers `approve`, plus `agent_watch` and `set_chat_title` where the Claude policy's `nekko_tools` allows them |
  | Every other provider: Anthropic, OpenAI, ChatGPT (Codex sign-in), OpenRouter, Ollama, LM Studio, vLLM, llama.cpp, Bedrock, Vertex, Foundry | Nekko's own loop (`nekko-turn`) | the built-in catalog (`crates/nekko-turn/src/catalog.json`) and the user's MCP servers |

  The Codex CLI is never launched: Nekko imports its sign-in (`crates/nekkod/src/oauth.rs`) and runs OpenAI models in its own loop. So a media tool needs one daemon implementation, exposed twice, as `agent_watch` and `set_chat_title` already are. MCP is needed for Claude Code only.

## Proposal

### Tools

| Tool | Does | Returns to the model |
|---|---|---|
| `generate_image` | Makes a picture from a prompt. Optional: `model`, `size`, `count` (1-4 on local models, always 1 on paid ones, see Decisions), `style`, `format` (`png`, `webp`, `svg` where the model can) | Each file's path, plus the picture itself when the model reads images and the size is within its limits |
| `edit_image` | Changes one or more existing pictures (a workspace path or a picture from this chat) with a prompt | The same |
| `generate_video` | Starts a clip from a prompt and an optional first frame | A job id at once; the clip's path when the chat wakes |
| `media_models` | Lists the media models this chat may use: where each runs, what it can do (create, edit, video, vector), and its price per call when it has one | The list |

- **Model choice.** With no `model`, the tool uses the chat's media preference (its own `imageParams`), else the Settings default, else the best local model this machine has for the task (the same recommendation Photo uses). An agent never silently gets a cloud model: a cloud model is used only when the user picked it, or Fusion may choose it (see below).
- **Results in the chat.** Pictures and clips land beside the chat (decision 0072) and in the transcript as the tool's result, the same picture block Photo uses. The agent can then use the file (put it in a page, commit it).
- **Video is never in the turn's way.** `generate_video` returns a job id at once; the chat wakes when the clip is ready, the same way `agent_watch` wakes it. Progress and Stop show on the job.

### Who gets the tools

- **Offered only when usable:** with no media model available (no local model installed and no cloud media model set up), the tools are not listed, so no agent tries and fails.
- **Claude Code:** through `nekko_bridge`, only where the Claude policy allows Nekko tools for the chat's sign-in; on a Claude plan only with the user's recorded approval (`nekko_tools: awaiting_approval`). nekkod checks the policy again on every call.
- **Incognito, Local only and Cloud only** keep their meaning: Local only offers local media models only; incognito keeps nothing it makes after the chat closes.

### Cloud media models `[pictures through OpenRouter implemented 2026-11-19, see plan step 5; the rest proposed]`

- **OpenRouter** on the user's key: pictures and clips (an async `/api/v1/videos`). Which picture endpoint to use is checked against OpenRouter's own API reference at that PR, since sources disagree.
- **Recraft** (directly or through OpenRouter) for vector output: real SVG, not a traced bitmap. It is paid per picture (V4.1 vector $0.08, Pro vector $0.30 on 2026-11-18) and has no downloadable weights.
- **A free local fallback** for vectors may trace a local picture (for example with vtracer), labelled as traced.
- **Costs** show before every paid call, one picture per call (see Decisions), priced from the provider's listing, and land in the Budget dock. A per-chat spending cap stops an agent looping on paid generations.

### Fusion `[proposed]`

When the chat is on Fusion, its strategy also chooses the media model: Local first prefers a local model, Quality first may choose a cloud one, Economical the cheapest suitable one. The route reason says which model made the picture and why. This lines up with the Router column in #610 rather than adding a second picker.

## Privacy and security

- **Local models:** the prompt and any attached picture stay on the computer.
- **Cloud models:** a prompt, and above all an attached personal photo, leaves the computer. Every paid call asks first, naming OpenRouter, the price, and whether pictures leave the computer (plan step 5), unless the chat's allowance already covers it. The prompt is scanned with decision 0065's detectors and the approval says what kind of private value it carries (0065 itself asks only for MCP and `fetch_url` calls; this ask is the paid-picture rule, corrected 2026-11-19). The taint gate ([decision 0054](../../docs/decisions/0054-gate-egress-in-chats-that-read-untrusted-content.md)) is unchanged.
- **SVG is code.** An SVG can carry scripts, event handlers and links to outside resources. Every SVG a tool returns is sanitised (no script, no event attributes, no external references) before it is saved, shown or sent to a phone, and it is shown as an image, never inlined into the app's page.
- **Files stay in the workspace or beside the chat.** A tool never writes outside the chat's folders; a path argument outside them is refused.
- **Phones** see agent-made pictures and clips like any other picture in the chat; they never start a cloud generation without the same consent.

## Acceptance criteria

1. In a chat on any provider, asking for a picture makes one with a local image model and shows it in the chat, with no screen visited, when a local image model is installed.
2. With no media model available, the tools are not offered and the agent says it cannot make pictures, never a failed call.
3. A Claude Code chat gets the same tools through `nekko_bridge`, only where the Claude policy allows Nekko tools; a call outside the policy is refused by nekkod.
4. `generate_video` never blocks the turn: the chat is free while the clip renders and wakes when it is ready; Stop cancels the job.
5. No prompt or picture reaches a cloud media model without decision 0065's consent, and a paid call shows its price first.
6. Every SVG shown, saved or sent is sanitised; a test feeds scripts, event handlers and external references and checks they are gone.
7. A local picture model and a chat model on one GPU never both load when they do not fit: the media job waits or says why.

## Plan

Each is one PR, evaluated before it starts; this file is updated in the same PR.

0. **Spec** (this file).
1. **Daemon: one media job** `[implemented 2026-11-18; unit and fake-sd-server tests; not yet run on real hardware]`. Generation already lived in the model server (`generate_image_with`, `generate_video_with`); `Server::media_job` (`crates/nekkod/src/model_server.rs`) is now the one way in, used by Photo and Video chats and `engine:generateImage`, and the tools will use it too.
   - **Memory:** a picture or video model now counts its file, its companion files and sd.cpp's working allowance (2 GiB for pictures, 4 GiB for clips, the recommendations' assumed figures) before it loads, so idle models are unloaded to make room, oldest first, as for chat models (`image_needed_bytes`, `crates/nekko-engine/src/server.rs`). Before, only the resident-model limit applied to picture models.
   - **Swap back (decided by Davide 2026-11-18):** when loading the media model pushed out a model loaded before it (usually the chat's own model, idle during a tool call), the media model is unloaded as soon as the job ends, stopped or not, so the chat's model can load again; the chat pays that reload. A media model that fit beside it stays for its idle timeout.
   - **One local job at a time on this computer (decided 2026-11-18):** a diffusion model fills the GPU, and two would double the memory. A waiting picture or clip shows "Waiting for another picture or clip on this computer to finish"; stopping it leaves the queue, and stopping the running one frees it. Cloud media jobs (later PRs) will not queue. A long clip still makes a picture wait; a priority for pictures is left until that proves a real problem.
   - **Still open:** where tool-made files go (PR 2), and whether sd-server itself runs two requests at once (not checked; the queue makes it moot locally).
2. **Native loop: `generate_image`, `edit_image`, `media_models`,** local models only. Split in two (decided by Davide 2026-11-18):
   - **2a, the tools** `[implemented 2026-11-18; unit tests and a daemon test with a scripted chat model and the fake sd-server; not yet run with a real model]`. In `crates/nekkod/src/media_tools.rs`, offered by `turnTools`'s `media` flag (`crates/nekko-turn/src/plan.rs`), dispatched in `turns.rs`, drawn through `Server::media_job`.
     - **Offered only when usable:** a local, non-sandbox, non-Claude Code chat with tools on, on a computer with a picture model ready (an image model in the library whose companion files are all on disk, or that needs none; video models are not offered). Offline chats keep them: nothing leaves the computer. A chat's `disabledTools` and a workflow step's tool access apply as to any tool. Whether stable-diffusion.cpp is installed is not checked before offering (it would add a GPU probe to every turn); a call without it fails with the install message.
     - **No approval to make a picture** (decided 2026-11-18): local, free, nothing sent. Saving it in the project (`path`, a new `.png`, never over an existing file) asks as `write_file` does in the chat's mode.
     - **The picture is the tool's result** (`images`), so the chat shows it and the model receives it as evidence it can check; `inspect: false` keeps the pixels out of the model's context and then requires `path`. Without `path` the picture stays in the chat only (decision 0072 keeps it beside the chat).
     - **Model choice:** the one asked for (from `media_models`), else the chat's own `imageParams.modelId`, else the Settings default (2b), else the first ready model that can do the task. Steps and CFG: the chat's for that model, else the model family's tuned defaults. Size: `size`, else the chat's, else 1024x1024. `count` 1 to 4, each picture its own queued job.
     - **Editing:** `edit_image` takes up to four workspace pictures (`.png`, `.jpg`, `.jpeg`, `.webp`) or `last`, the last picture these tools made in this chat; only models that edit are used.
     - **Known gaps:** a chat model known not to read pictures gets the existing one-line "image attachment omitted" note in their place (docs/local-models.md, "Pictures and models that cannot see"); a server that does not say what its models take still receives them. Not yet tried with a real text-only model. The agent sees no queue or progress while it waits.
   - **2b, the Settings default** `[implemented 2026-11-18; component tests and a hidden full-App capture with stub models; not yet run against a real library]`. Settings → Agents → **Pictures** has a **Picture model** select: **Automatic** (default) and each ready picture model (the daemon's rule: companion files on disk, or none needed; video models left out), an editing one marked "edits too". It saves `agentPictureModel`. The tools use it after the model the call names and the chat's own Photo model, and pass it over when it is not ready or cannot do the task; a chosen model that is no longer ready shows as "(not ready)" and agents use Automatic until it is. With no picture model ready the section is one line pointing to a Photo chat.
3. **Claude Code: the same tools in `nekko_bridge`** `[implemented 2026-11-18; bridge unit tests and a real-daemon test with the fake Claude Code and fake sd-server; not yet run with a real Claude Code]`.
   - **Policy (decided by Davide 2026-11-18):** the existing `nekko_tools` row, no new one. Listed at launch only when that row is enabled for the chat's Claude sign-in, a picture model is ready, and the chat is not incognito or a training run; every call is checked again (`POST /harness/tool`). So: on an API key or a cloud account they work; **on a Claude plan (and an unread sign-in) they are off** until Anthropic approves `nekko_tools` (Nekko then turns it on with a signed policy) or the user, holding Anthropic's own approval, turns on Settings > Agents > Claude plan features. Plan users can still make pictures from chats that do not run through Claude Code (local models, ChatGPT, Gemini, OpenRouter) or a Photo chat.
   - **No permission prompt:** like `agent_watch`, the bridge's picture tools run without asking in every mode (`harness::decide`): a local model, nothing sent, nothing written into the project.
   - **Where the picture goes:** the answer carries it as MCP image content, so Claude sees it, and names the PNG Nekko kept in its data folder (`agent-pictures/<chat id>/`). Claude Code copies it into the project with its own tools and their approvals; Nekko never writes into the project behind Claude Code. So the bridge's tools have no `path` or `inspect`; `edit_image` reads pictures from the chat's folders or `last` (the newest kept picture).
   - **Known gaps:** kept pictures are not yet removed when the chat is deleted; whether Claude Code's own transcript shows the picture in Nekko's chat is not checked with a real Claude Code; the bridge's call to nekkod uses Node's default fetch timeouts, so a picture slower than about five minutes (a large model on the processor) may fail on the bridge side.
4. **`generate_video`, async with a wake.** Split in two (decided by Davide 2026-11-19):
   - **4a, the tool** `[implemented 2026-11-19; watch unit tests and a daemon test with a scripted chat model and the fake sd-server; not yet run with a real video model]`.
     - **Offered** in a Nekko engine chat with a ready video model (Wan 2.2 TI2V 5B with its files), not in incognito, offline, sandbox or training-run chats: the clip wakes the chat through a watch, which those chats cannot be woken by. In a Claude Code chat it needs `nekko_tools` **and** `unattended_runs`, as `agent_watch` does, so it is off on a Claude plan.
     - **Answers at once** ("Started a 832x480 clip … watch … wakes this chat"); the clip is made in the background through the media queue.
     - **The wake is a `clip` watch** (decided 2026-11-19): armed with the call, it never polls; when the clip ends the watch gets the news ("The clip is ready (…): <paths>" or why it failed) and the scheduler wakes the chat as for any watch, durably, once the chat is free. A clip lost to a restart wakes the chat with "The clip was interrupted".
     - **Stopping:** cancelling the watch (chip or `agent_watch`) and **the chat's Stop** stop the clip and free the queue. Davide had approved "Stop does not stop the clip" on the premise that Stop leaves background work running; it does not (`chat:abort` cancels the chat's watches and kills its `start_process` processes), so Stop stops the clip too, for one rule. Revisit if wanted.
     - **Where it goes:** kept beside the chat in Nekko's data (`agent-pictures/<chat id>/clip-*.webp`), and in a Nekko engine chat also in the project at `path` (a new `.webp`, approved during the call while the turn can ask). A Claude Code chat copies it with its own tools.
     - **Shape:** `size` as WIDTHxHEIGHT gives the shape; the engine scales it to about 832x480 pixels. A first frame (`image`: a workspace picture or `last`) starts the clip.
     - **Known gaps:** the clip is not shown in the transcript yet (the wake message names its path); no measured time per clip is quoted.
   - **4b, the clip chip** `[implemented 2026-11-19; chip tests and a hidden before/after capture with a synthetic bridge]`. The composer's watch chip reads **Making a clip**, then the job's stage (`waiting for another picture or clip`, `loading the video model`, `step 3 of 20`) and `in progress`, or `finished · waiting for the chat`; no countdown. Its button is **Cancel clip**. The watch records the stage (`clipStage`, from the media job's stages) and the chat's "Sleeping · will check in …" line leaves clips out: their deadline is a safety net, not a wake-up time. iPhone and Android drop a watch kind they do not know, so a clip shows no chip there yet (plan step 9).
5. **Cloud pictures through OpenRouter** `[implemented 2026-11-19 (5a); unit tests and a daemon test against a stand-in OpenRouter; not yet run against OpenRouter itself]`. Decided by Davide 2026-11-19:
   - **The user's own OpenRouter provider**, already set up for chat (no new key screen). OpenRouter is a third-party gateway, not a Nekko service: the user's account and credit pay; Nekko pays nothing. `crates/nekkod/src/cloud_media.rs` reaches it through internal channels (`media:cloudModels`, `media:cloudImage`) so the key never leaves the daemon: `GET /images/models`, prices from `GET /images/models/{id}/endpoints` (per picture exact, per megapixel estimated at one megapixel; token-priced models are not listed), `POST /images` with `n: 1`, the nearest common `aspect_ratio`, pictures to edit as `input_references`. Cached an hour.
   - **Named, never automatic:** a cloud model (`openrouter:<provider>:<model>` in `media_models`, with its price) is used only when the call, the chat or Settings names it; the automatic choice stays local. Offered when an OpenRouter provider is enabled, even with no local picture model; never in offline or Local only chats; not on the Claude Code bridge yet. The Settings picture list still shows local models only, so today a user names a cloud model by asking the agent for it.
   - **One picture per call** (decision 3), and **every paid call asks with its price, in every mode, YOLO included**, and is denied in an unattended run. Approving allows paid pictures in that chat up to **$1.00** more (`pictureSpend: { allowedUsd, spentUsd }` on the chat); within it nothing asks, past it it asks again.
   - **Cost:** OpenRouter's own `usage.cost` (else the price shown) is added to the chat's spending and written to `usage.jsonl` as a `kind: "picture"` line with `costUsd`. **5b, still open:** the Budget dock does not read those lines yet.
6. **Cloud clips through OpenRouter** `[implemented 2026-11-19; unit tests and a daemon test against a stand-in OpenRouter; not yet run against OpenRouter itself]`. Decided by Davide 2026-11-19:
   - **How:** `generate_video` naming a cloud video model (`media_models` lists them under "Video models", with the cheapest clip's price). `cloud_media.rs` keeps the key: `GET /videos/models` (durations, resolutions, first-frame support, per-second `pricing_skus`), `POST /videos` (`duration`, `resolution`, `generate_audio`, a first frame as `frame_images`), `GET /videos/{id}` read after 2 s and then every 20 s for up to an hour, `GET /videos/{id}/content` for the MP4.
   - **The user chooses everything, with prices:** the chat's existing question card asks length (up to five of the model's durations), audio and resolution, each answer with its total, the suggestion first: the shortest length, no audio, the lowest resolution, or what the agent proposed (`duration`, `audio`, `resolution`) where the model offers it. A question with one answer is left out.
   - **On the desktop, one card with a live total** (`ClipPicker`, asked for by Davide 2026-11-19) `[implemented; component tests, a daemon test and a hidden before/after capture]`: length, audio and resolution side by side, the suggestion picked, the **Total** updating with each pick from the price of every combination the question carries (`clip.prices`, keyed `length|audio|resolution`), the cannot-be-stopped warning, and **Make clip · $2.40**. That button confirms the total: the answers carry it (`questionId: "total"`), and when it is exactly the price Nekko computes, no second approval follows. iPhone and Android ignore `clip` and show the stepped questions, then the separate approval ([#3038](https://github.com/nekko-labs/nekko-agent/issues/3038)).
   - **Then the total is confirmed, every time** (no per-chat allowance for clips: one can cost more than $3), in every mode, YOLO included; denied in an unattended run. The approval says it cannot be stopped once started and is charged even if the chat is stopped.
   - **It cannot be cancelled** (OpenRouter documents no cancel). The chat's Stop cancels the clip's watch, so the chat is not woken, but the clip is still downloaded and kept, and its cost recorded.
   - **Kept** beside the chat (`agent-pictures/<chat>/clip-*.mp4`) and at an approved `.mp4` project path. **Cost:** OpenRouter's `usage.cost` (else the confirmed total) as a `kind: "video"` usage line with `costUsd`, so it counts in the Budget's Actual spend (not in Paid pictures). A failed clip records a cost only if OpenRouter reports one.
   - **Not in** offline, Local only or incognito chats, nor on the Claude Code bridge.
7. **Vector output (SVG).** Split in two (decided by Davide 2026-11-19): Recraft first, then a local tracer.
   - **7a, Recraft through OpenRouter** `[implemented 2026-11-19; sanitizer and preview unit tests and a daemon test against a stand-in OpenRouter; not yet run against OpenRouter itself]`.
     - `generate_image` takes `format: "svg"` for logos, icons, badges and flat illustrations. A cloud model whose id or name says vector (Recraft's vector models, Quiver) gets the `vector` capability and is asked for `output_format: "svg"`.
     - **Recraft is the default for vectors** (decided 2026-11-19): with `format: "svg"` and no model, the user's first cloud vector model is used, asked with its price like any paid picture (or within the chat's $1 allowance). An exception to "cloud only when named", for vectors only. With no vector model the call says to add OpenRouter or to write the SVG as code.
     - **SVG is made safe before anything else** (`crates/nekkod/src/svg_safe.rs`, `roxmltree`): parsed as XML with no DTD (an entity or `DOCTYPE` refuses it) and written back with only what draws. Dropped: `script`, `foreignObject`, `iframe`, `object`, `embed`, `audio`, `video`, `image` and handler elements, every `on*` attribute, links that are not `#id` in this document, `set`/`animate` that would set a link or a handler, and `style` that loads from outside (`url()` other than `#id`, `@import`, `javascript:`).
     - **What comes back:** the sanitized SVG's code in the result (up to 12,000 characters, the rest with `path`) for the agent to place in a page or change; a PNG preview (`resvg`, without fonts or embedded pictures) as the result's picture, so the chat shows it and models that read pictures see it; a `.svg` `path` saves the sanitized code in the project.
     - **Dependencies:** `roxmltree` and `resvg` (MIT or Apache-2.0), within the license policy (`scripts/third-party.mjs check`).
   - **7b, local tracing** `[implemented 2026-11-19; trace unit test, a daemon test with the fake sd-server (which answers a flat-style prompt with a real PNG), and a hidden before/after Settings capture]`.
     - **Without a cloud vector model**, `format: "svg"` makes one picture with a local picture model (the one named, else the first that creates), its prompt extended with a flat style (a few solid colours, bold shapes, white background, no gradients or detail), and traces it with `vtracer`'s poster preset (`filter_speckle` 8) in `svg_safe::trace_png`, then sanitizes it like any SVG. The PNG is read with `resvg`'s own `tiny-skia`, so no other image library is added. The result begins "Traced a vector picture (SVG) from a picture made with … on this computer (free). A trace, not a native vector …" and points to Recraft through OpenRouter as better; code, preview and `path` as for Recraft. `media_models` says a local model makes traced SVG.
     - **Settings → Agents → Pictures** gains a **Vector graphics (SVG)** line under the picture model: "Recraft through OpenRouter · recommended" with its price when an OpenRouter provider is enabled; otherwise "Traced from this computer's pictures · free", saying it is cruder and that adding OpenRouter gives clean SVG; or "Not available yet" with both ways to get it. The section's help no longer says nothing leaves the computer: it names paid cloud models on OpenRouter, which ask first.
     - **Docs:** "Vector graphics (SVG)" in `docs/local-models.md` gives the three ways (Recraft, traced, the agent writing SVG) and how to use an SVG in a site.
     - `vtracer` 0.6 (MIT or Apache-2.0) is within the license policy. A real local SVG model (OmniSVG, Apache-2.0) needs PyTorch, which Nekko does not ship: a research issue, not this step.
8. **Fusion chooses the media model.** *Evaluate:* fit with the Router column (#610).
9. **Phones:** agent-made pictures and clips on iOS and Android, and a gaps row in [iOS and Android stay in step](../phone/ios-and-android-stay-in-step.md) for anything desktop gets first.
10. **Docs:** a page on making pictures and clips from any chat.

## Decisions `[settled by Davide 2026-11-18]`

1. **Where the media model is chosen:** both. A default in Settings → Agents, plus a per-chat **Media** row in the model picker. Settings arrives with PR 2 (local models only, usually one); the picker row with PR 5, when paid cloud models make the choice matter.
2. **Agent chats keep their own media settings.** A chat's agent stores its model, size and steps in that chat's own `imageParams`, the field Photo chats already use per chat. Nothing an agent does changes a Photo chat's settings or the model new Photo chats start with; the Settings default from decision 1 is the only shared value.
3. **One picture per call on paid models.** `count` is fixed at 1 on any model with a price, so each paid call is one visible price. Local models may still make up to 4. **Why:** a user who sees charges they did not expect stops using the app. The per-chat spending cap stays as a second guard.
