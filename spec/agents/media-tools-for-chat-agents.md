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

### Cloud media models `[proposed; prices and endpoints checked when that PR is written]`

- **OpenRouter** on the user's key: pictures and clips (an async `/api/v1/videos`). Which picture endpoint to use is checked against OpenRouter's own API reference at that PR, since sources disagree.
- **Recraft** (directly or through OpenRouter) for vector output: real SVG, not a traced bitmap. It is paid per picture (V4.1 vector $0.08, Pro vector $0.30 on 2026-11-18) and has no downloadable weights.
- **A free local fallback** for vectors may trace a local picture (for example with vtracer), labelled as traced.
- **Costs** show before every paid call, one picture per call (see Decisions), priced from the provider's listing, and land in the Budget dock. A per-chat spending cap stops an agent looping on paid generations.

### Fusion `[proposed]`

When the chat is on Fusion, its strategy also chooses the media model: Local first prefers a local model, Quality first may choose a cloud one, Economical the cheapest suitable one. The route reason says which model made the picture and why. This lines up with the Router column in #610 rather than adding a second picker.

## Privacy and security

- **Local models:** the prompt and any attached picture stay on the computer.
- **Cloud models:** a prompt, and above all an attached personal photo, leaves the computer. Decision 0065 applies: the first call to each provider asks, naming the provider, and a call carrying private data (a workspace file, a photo) asks even after that. The data-loss checks (decision 0065's outbound DLP) and the taint gate ([decision 0054](../../docs/decisions/0054-gate-egress-in-chats-that-read-untrusted-content.md)) cover the prompt as they cover any outbound call.
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
2. **Native loop: `generate_image`, `edit_image`, `media_models`,** local models only. *Evaluate:* offering only when a model exists, what goes back to the model (path, picture, both), the picture block in the transcript.
3. **Claude Code: the same tools in `nekko_bridge`.** *Evaluate:* Claude policy gating, the picture sizes Claude accepts.
4. **`generate_video`,** async with a wake. *Evaluate:* measured time per clip, never guessed; one clip at a time.
5. **Cloud pictures through OpenRouter.** *Evaluate:* endpoint, consent, DLP, cost shown first, Budget dock.
6. **Cloud clips through OpenRouter.** *Evaluate:* spending cap per chat.
7. **Vector output:** Recraft SVG, optional local tracing, SVG sanitising. *Evaluate:* direct API or OpenRouter, license review per docs/runbooks/third-party.md for any tracer.
8. **Fusion chooses the media model.** *Evaluate:* fit with the Router column (#610).
9. **Phones:** agent-made pictures and clips on iOS and Android, and a gaps row in [iOS and Android stay in step](../phone/ios-and-android-stay-in-step.md) for anything desktop gets first.
10. **Docs:** a page on making pictures and clips from any chat.

## Decisions `[settled by Davide 2026-11-18]`

1. **Where the media model is chosen:** both. A default in Settings → Agents, plus a per-chat **Media** row in the model picker. Settings arrives with PR 2 (local models only, usually one); the picker row with PR 5, when paid cloud models make the choice matter.
2. **Agent chats keep their own media settings.** A chat's agent stores its model, size and steps in that chat's own `imageParams`, the field Photo chats already use per chat. Nothing an agent does changes a Photo chat's settings or the model new Photo chats start with; the Settings default from decision 1 is the only shared value.
3. **One picture per call on paid models.** `count` is fixed at 1 on any model with a price, so each paid call is one visible price. Local models may still make up to 4. **Why:** a user who sees charges they did not expect stops using the app. The per-chat spending cap stays as a second guard.
