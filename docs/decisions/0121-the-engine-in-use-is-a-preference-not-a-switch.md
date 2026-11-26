---
status: accepted
date: 2026-11-26
---

# 0121. The engine in use is a preference, not a switch

## Context

Philip asked (2026-11-26, #3492) for the engines that run local models to be listed and selectable on the Models page (llama.cpp, MLX, oMLX, Basalt, squid5090), with the ones a machine cannot run still shown, the fastest chosen for people by default, and "Fastest" and "Most stable" marked.

Engines are not interchangeable. Each reads its own files: llama.cpp reads GGUF, MLX and oMLX read MLX folders, Basalt reads `.basalt` packs of five models, squid5090 reads one model's checkpoint folder. A library usually holds files for more than one of them.

## Options considered

1. **A global switch.** One engine runs everything; models it cannot read cannot be loaded until you switch back. Simple to say, but picking squid5090 would leave one loadable model in the library, and a Mac on MLX could no longer load a GGUF.
2. **No choice, engine implied by the file** (how it was). Nothing to pick, and nothing shows that a faster engine exists for the same model.
3. **A preference.** One engine is "in use": it takes every model it can run. A model only another engine can run still loads on that one.

## Decision

Option 3. The choice is saved as `settings.engine.chatEngine` and resolved by the daemon (`nekko-engine`'s `engines`): the saved choice while this machine can run it and has it installed, else the fastest usable installed engine, else none.

Fastest and Most stable come from two fixed orders, compared among the engines the machine can run. Speed: squid5090, Basalt, oMLX, MLX, llama.cpp. Stability: MLX, llama.cpp, oMLX, Basalt, squid5090. The orders are judgments, not measurements: the speed order follows what each project is built for and reports, and MLX leads stability because Philip named it. With one usable engine neither label shows.

An engine that is listed before Nekko can start it says so and is left out of the labels and of the automatic choice. An engine that has not been run on its hardware by us stays out of the automatic choice even once built.

## Consequences

- No load ever fails because of the engine choice.
- "In use" does not mean "the only engine running": two models can be loaded on two engines at once.
- The labels can be wrong for a particular model or card. They become measured once the engines are benchmarked on the same machine; until then the docs call them a guide.
- Per-model choice of engine (the same model in two formats) is not offered; it would need the library to know two files are the same model.
