---
status: accepted
date: 2026-11-20
---

# 0111. Overload protection stops a load, on by default

## Context

A model that needs more graphics memory than is free does not fail cleanly. On Windows the NVIDIA driver spills the rest into shared system memory, and a large enough load then pushes system memory to the edge too, and the whole computer stops responding until the load finishes or the person pulls the plug. The request (#3119) was for loads to pause and unload before memory reaches 100%, keeping something like 500 MB free, as an option in the model server settings.

## Options considered

1. **Pause the load.** llama.cpp, stable-diffusion.cpp and MLX have no paused state: a load either runs to the end or its process ends.
2. **Refuse up front from the planner's estimate.** The estimate is good but not exact (drivers, compute buffers, other apps moving), so it would turn away loads that fit and pass ones that do not.
3. **Watch the load and stop it at the reserve.** Read free graphics memory and system memory while it runs; when the load has pushed either under the reserve, end its process so the memory comes back, and say why.

## Decision

Option 3, on by default with a 500 MB reserve (`overloadGuard`, `overloadReserveMB` in the engine settings; off only when set to false). The engine reads both every 0.8 seconds during a load (on Windows, system memory is the tighter of free memory and the commit limit). Memory already short when the load began is not blamed on it: the load must have taken at least 128 MB. Making room before a load counts the reserve too, so idle models are unloaded to keep it free instead of the new load being stopped.

## Consequences

- A load that used to squeeze into the last few hundred MB now stops. The message names the fix (a shorter context, fewer GPU layers) and the switch.
- Protection covers loads only. A model already loaded that later meets a memory shortage is the desktop's low-memory card's job.
- The phones switch it from the agent details' Model Server section, like the other settings there (only while the computer lets devices choose, each change behind Face ID or the screen lock). How much it keeps free is set on the computer only.
