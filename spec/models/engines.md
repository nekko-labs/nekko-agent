---
title: "Engines: see and pick what runs local models"
area: models
---

# Engines: see and pick what runs local models

**Intent.** Philip (2026-11-26, [#3492](https://github.com/nekko-labs/nekko-agent/issues/3492)): "put engines as an expandable area above the system models. For each engine section, let's have the engine options be selectable. We need to support effectively all the different ones available today (llama.cpp, mlx, omlx, basalt, squid5090). We should show the ones unsupported on the machine as disabled (a message like 'macos only' or 'nvidia 5090 only'), but still show it. We should default to the fastest for people, and in the list show 'most stable' vs 'fastest', so for example squid5090 should be fastest, but mlx is most stable. In addition to different engines, we should support different options for the model like DFlash 2."

An engine is the program that runs a model. Until this, which engine ran a model was implied by the model's file and never shown, and the MLX and image runtimes were install cards under Model server > Configure. Faster engines now exist for particular hardware; a person should see every one, which their machine can use, which is fastest, and be able to switch.

[Design canvas](../../nekko-designs/engines-design.html). Why "in use" is a preference: [decision 0121](../../docs/decisions/0121-the-engine-in-use-is-a-preference-not-a-switch.md).

## What a person sees

**The Engines block** `[implemented 2026-11-26, #3493; unit and daemon end-to-end tested; verified in a hidden, network-blocked renderer fixture at 1280 and 390 px, dark and light, for a Mac, Linux and Windows with an RTX 5090, and a PC without one; not yet pressed in a packaged app; no Blackwell machine checked]`

- **Models > Local model server > Engines** is a block above System models, folded until clicked or chosen in the side menu (**Engines**, above **System models**). Folded, its one line names the engine in use ("llama.cpp in use").
- Open, it has a group per kind of model. **Chat models** lists llama.cpp, MLX, oMLX, Basalt and squid5090. **Photo and video models** lists stable-diffusion.cpp, where this machine has a build for it. Speech engines stay in System models, right below.
- **One engine in a group is in use**: its name is in the accent colour with a green dot and "In use". An installed engine that is not in use offers **Use**. An engine this machine can run and does not have offers **Install**, with its download size beside it; the fastest such engine above the one in use carries the one primary button. An engine Nekko installed can be **Uninstalled** (the action appears on hover or focus; models are kept; the model server has to be stopped). An engine found on your PATH or pointed at by you says "your own install" and is never removed here.
- **An engine this machine cannot run stays in the list**, below the usable ones, its name faint, the reason in place of its description, and no button:

  | Engine | Says, when it cannot run here |
  | --- | --- |
  | MLX, oMLX | "macOS only"; on an Intel Mac, "Apple Silicon only" |
  | Basalt | "NVIDIA RTX 50 series only" |
  | squid5090 | "NVIDIA RTX 5090 only"; with that card on Windows, "Linux only" |

- **Fastest** and **Most stable** mark one engine each, worked out among the engines this machine can run. Speed order: squid5090, Basalt, llama.cpp, oMLX, MLX. Stability order: MLX, llama.cpp, oMLX, Basalt, squid5090. One engine can hold both. With only one usable engine neither is shown: there is nothing to compare.
- llama.cpp ahead of MLX is measured: as Nekko runs it, with speculative decoding on, it returned a code edit 4.6x sooner than mlx-lm and decoded chat 1.6x to 6.7x faster ([benchmarks](../../docs/benchmarks.md), Apple M5 Max, Qwen3-8B). The other positions are not measured by us: squid5090 and Basalt go by what each project reports for its GPU family and by Philip's call, and oMLX sits beside MLX until it is benchmarked the same way.
- The image engine's build picker shows while it is not installed and this machine has more than one build to choose from.

**Which engine is in use**

- With no choice made: the fastest usable engine that is installed. With nothing installed, none is in use and the fastest one Nekko can install carries the primary Install.
- **Use** saves the choice (`settings.engine.chatEngine`), on this computer only: a phone or another computer cannot change it. A choice this machine cannot run, or one that is not installed, is ignored until it can be honoured; it never blocks a load.
- **In use is a preference, not a switch.** Nekko loads a model on the engine in use whenever that engine can run it. A model only another engine can run still loads on that one: a GGUF file runs on llama.cpp while MLX is in use.
- What follows the engine in use today: **Find new models** opens on MLX checkpoints when it is MLX (or oMLX), on GGUF otherwise. On a Mac that never chose, llama.cpp is in use, so nothing changes for anyone until they press Use on MLX.

**Engines Nekko cannot start yet** `[planned]`

- oMLX ([#3494](https://github.com/nekko-labs/nekko-agent/issues/3494)), Basalt and squid5090 ([#3495](https://github.com/nekko-labs/nekko-agent/issues/3495)) are listed, and on a machine with the right hardware say "Not in this version of Nekko yet". They are never in use, never marked Fastest or Most stable, and have no button.
- squid5090 publishes no downloads (a Zig and CUDA source build), so it starts as an engine you build and point Nekko at. Basalt and squid5090 stay out of the automatic choice until they have been run on a Blackwell machine.

**Model options: DFlash and DFlash 2 drafters** `[first part implemented 2026-11-26, #3496: launch arguments and the drafter pairing unit-tested, and the installed llama-server (b12503) checked to accept the flags; not run with a real drafter]`

- A DFlash drafter is a small model made for one target model. It drafts several words at once and the target checks them, so replies come faster with the same answers. It is a separate GGUF file (about 1.1 GB for Qwen3.8-27B) and only runs on llama.cpp.
- A drafter in the library is recognised (its file says `dflash`), listed as a draft model, and never offered a Load button of its own.
- When a model's load settings are open (**Guessing ahead > Draft model**), a drafter whose name matches the model ("Qwen3.8-27B-DFlash2" for "Qwen3.8-27B") is offered first, marked "(DFlash)", ahead of small models of the same family. A drafter made for another model is not offered: it would not load.
- Loading with one starts llama.cpp with `--spec-type draft-dflash` and `--spec-draft-n-max 7` (the step the drafter's authors run it at); any other draft model keeps `draft-simple` and llama.cpp's own step. DFlash and DFlash 2 use the same flag: the server tells them apart from the file.
- `[planned]` Offering to download the drafter for a model that has one published, and a single DFlash switch in place of the picker ([design canvas](../../nekko-designs/engines-design.html), frame 08). Until then a drafter is downloaded like any other model, from Find new models.
- An llama.cpp older than DFlash support (before mid 2026) refuses the flag and the load fails with llama.cpp's message; the managed engine is newer.

**First run and recommendations** `[planned, #3497]`

- The first-local-model screen, Recommended models and Find offer models for the engine in use. Today first run always installs llama.cpp and a GGUF.

## Boundaries

- Nothing is downloaded until Install is pressed. Every engine download goes through the same tracked, cancellable download jobs as before, and respects the Connections switch.
- The engine list is decided by the daemon from the OS, the processor and the graphics cards' names as the GPU probe reports them. No engine is run to find out.
- Third-party engines keep their own licenses: llama.cpp MIT, mlx-lm MIT, stable-diffusion.cpp MIT, oMLX Apache-2.0, Basalt MIT, squid5090 Apache-2.0. Each is added to the credits when Nekko first downloads or starts it.

## Acceptance

- On an Apple Silicon Mac with MLX and llama.cpp installed: llama.cpp is in use and marked Fastest; MLX is marked Most stable and offers Use; Basalt says "NVIDIA RTX 50 series only" and squid5090 "NVIDIA RTX 5090 only", both without a button.
- Pressing Use on MLX moves "In use" to it, saves the choice, survives a restart of the daemon, and Find new models then opens on MLX checkpoints.
- On Linux or Windows the Mac engines say "macOS only"; on Windows with an RTX 5090, squid5090 says "Linux only".
- Model server > Configure no longer has a Runtimes group; installing and removing MLX and the image engine happen in the Engines block.
