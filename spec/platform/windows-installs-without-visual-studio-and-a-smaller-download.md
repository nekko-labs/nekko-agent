---
title: "Windows installs without Visual Studio, and a smaller download (2026-10-12)"
area: platform
split-from: SPEC.md (2026-10-22)
---

# Windows installs without Visual Studio, and a smaller download (2026-10-12)

User intent: people hesitate when a Windows install seems to need Visual Studio. Nekko Agent never needs Visual Studio or any developer tool, and the install should be as small and as quiet as it can be.

- **Visual C++ runtime ships app-local.** `nekkod` links pyke's prebuilt ONNX Runtime, which is compiled against the DLL C runtime (`/MD`), so it imports `MSVCP140.dll` and `VCRUNTIME140.dll` and cannot link the runtime statically. The installer (and the `@nekko-agent/nekkod-win32-x64` npm package) carries the redistributable's DLLs beside `nekkod` (about 1 MB, copied from the build machine's Visual Studio redist folder by `scripts/vc-runtime.mjs`; packaging fails without them). Microsoft permits this app-local deployment.
- **Downloaded engines get it too.** llama.cpp's and stable-diffusion.cpp's Windows builds import the same runtime. When Windows lacks it (any of `msvcp140`, `vcruntime140`, `vcruntime140_1` missing from System32), the host copies the app's set beside the engine after an install and before every start, which also repairs earlier installs. When Windows has it, nothing is copied, so a newer system runtime is never shadowed.
- **A missing DLL is named, not mysterious.** An engine that exits with STATUS_DLL_NOT_FOUND reports that the Microsoft Visual C++ Runtime is missing, says Visual Studio is not needed, and links Microsoft's redistributable. A `nekkod` that Windows cannot load stops its restart loop and the desktop app falls back to the TS backend.
- **DirectML is fetched only on demand.** The 18 MB `DirectML.dll` is no longer packed. `nekkod` delay-loads it; a decision model's DirectML provider uses Windows' own copy when it is 1.15 or newer (Windows 11), else Microsoft's 1.15.4 fetched once from its NuGet package by HTTP range (about 9 MB, pinned SHA-256). Without either, decision models run on the CPU and the load message says why.
- **CUDA is preferred on NVIDIA cards that can run it.** llama.cpp's CUDA build is CUDA 13: it needs compute capability 7.5 (GTX 16 / RTX 20 series on) and driver 580 or newer, read once per run from `nvidia-smi --query-gpu=compute_cap,driver_version`. A supported card is recommended CUDA; an older card or driver is recommended Vulkan and the CUDA option says why; no reading keeps the earlier behavior (CUDA). The build picker tells people CUDA is roughly 15-20% faster than Vulkan on NVIDIA (a rough public figure; the benchmark on our hardware is open in TASKS.md). A supported NVIDIA machine already on a managed Vulkan or CPU build is offered **Switch to CUDA** on the Model server card.

Status: implemented. Verified locally: unit tests (host, desktop, server, scripts), workspace typecheck, the Rust crates' tests and clippy, a release `nekkod` staged by `stage-daemon.mjs` that lists `DirectML.dll` as a delay-load import and starts from a folder holding only it and the runtime DLLs, the DirectML range download against the live NuGet package (pinned hash matched, under a second), a `nekkod` with a deliberately broken import exiting 3221225781 and the desktop engine falling back to the TS backend, and headless before/after captures of the Model server card. Measured: the installer loses about 8.8 MB compressed (DirectML) and gains about 0.3 MB (runtime DLLs). `opt-level = "s"` would cut `nekkod` from 49 MB to 41 MB but only about 1.7 MB compressed, at a runtime cost to the daemon, so it is not applied. Not verified: a real install on a Windows PC without the Visual C++ Redistributable, DirectML fetched on an actual Windows 10 machine, the CUDA upgrade card clicked through on a live NVIDIA machine running Vulkan, a card older than compute capability 7.5, and the "roughly 15-20% faster" figure (T190).

## Agent plan visibility, context capacity and GPU identity

Implemented: plan-panel visibility is remembered locally per chat, so toggling one agent never changes another agent. The legacy saved preference remains the default for chats without their own choice. Narrow panes still fold their rails without changing the saved choice.

The context-window gauge has a subtle full background: green below 60%, yellow from 60% to below 85%, and red at 85% or higher. Its fill and sidebar context counts use the same thresholds. Unknown window limits remain neutral and token estimates retain their existing labels.

Hardware reports each detected GPU by its probe-reported device name, paired with that device's utilization instead of an unnamed peak. Missing utilization stays Unavailable, disabled monitoring stays Monitor off, and aggregate VRAM remains explicitly separate. No additional probes, permissions, provider requests or external data are introduced.

Verification: focused tests and isolated Windows Electron renderer checks pass, including two independent plan toggles, threshold boundaries and synthetic multi-GPU readings. Matched wide/narrow light/dark evidence captured; live multi-GPU hardware and macOS/Linux native app behavior are unverified.

## Agent panel group drag feedback

Implemented and verified in an isolated Windows Electron renderer at desktop/mobile widths, both orientations and light/dark themes, with synthetic drag events and inspected captures. Physical OS dragging and macOS/Linux runtime verification remain untested. Dragging a project group opens a quick 140 ms insertion gap before the hovered group, moving its contents down (right in the horizontal panel), without an orange overlay. Moving outside closes the gap; crossing children does not reset hover. Reduced-motion preferences disable transitions. Dropping over a group header or its agent cards saves the project order; dropping on itself leaves order unchanged. Agent-card reordering and moving agents between projects remain separate operations. This changes local layout/settings only and does not start agents or contact providers.
