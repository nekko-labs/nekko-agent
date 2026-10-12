# Running models locally

Nekko Agent runs models two ways: with its **own engine**, which needs nothing else
installed, or by driving a server you already run (Ollama, LM Studio, vLLM). Either way
it loads a model with the settings you choose and tells you honestly whether it will fit
before you wait through the load. This is what the Models page shows you and why.

## The Nekko engine

The engine is llama.cpp, managed by Nekko Agent. You press one button, a few hundred
megabytes come down from llama.cpp's own releases, and the app can serve models. Nothing
is downloaded before that press.

**Which build.** Picked from what the GPU probe actually found, not from the platform:
CUDA only where `nvidia-smi` answers, Vulkan for a GPU we cannot identify, Metal on Apple
Silicon, CPU where there is no evidence of anything else. A slow engine that runs beats a
fast one that fails to start. Every other build for your machine stays in the list if you
disagree. If you already have a `llama-server`, point at it instead: Nekko Agent will run
it and never update or remove it.

**Where models come from.** A short curated list answers "what should I run"; search
covers everything else, straight against Hugging Face with no account. Each model expands
into its real builds with their real download sizes. Downloads resume after an
interruption and only land once the file parses as a GGUF, so a half-finished model never
shows up looking complete. A GGUF you already have is adopted without being copied, and
pointing the models folder at an existing library adopts everything in it.

**One address, several models.** The engine serves on `http://127.0.0.1:11500/v1` by
default, with a `llama-server` process per loaded model behind it. Several models stay
resident; a request for one that is not loaded loads it; an idle one is evicted on a
timer; and the address survives every load and unload. It is OpenAI-compatible, so point
Claude Code, Cursor, Continue or anything else at it and name a model from `/v1/models`.

**Two ways to configure a load.** *Simple* asks one question, how much of this machine
the model may use, and solves it into a real context length, GPU offload and KV cache
type, then says what it chose and what it costs. *Advanced* is every llama.cpp flag:
context, GPU layers, KV cache type, parallel slots, flash attention, batch and physical
batch, threads, mmap and mlock, RoPE base and scale, seed, idle TTL. They are the same
state, so moving one moves the other, and either can be saved as that model's default.

**The Server tab** carries port, whether it is reachable from your network or only this
computer, an API key, allowed browser origins, how many models may be resident, the idle
timeout, load-on-demand, start-with-the-app, and the models folder. The defaults are
loopback-only with no key, which is safe; binding to the network is a deliberate act and
the app says what it means next to the setting.

Because the engine holds the file, it reads the GGUF header directly, so the projection
below is **exact** for its own models where it has to report parts of itself as unknown
for somebody else's.

## Servers you already run

### What each one can do

They are not the same shape, and the app does not pretend they are.

| | Nekko engine | Ollama | LM Studio | vLLM |
|---|---|---|---|---|
| Start / stop from here | yes | yes | yes | **no**, connect only |
| Load a model on demand | yes | yes | yes | no, one model per process |
| Set context per load | yes | yes | yes | at launch only |
| Set GPU offload | yes | yes | yes | at launch only |
| Parallel slots | **per load** | restart required | no | at launch only |
| KV cache type | **per load** | restart required | no | at launch only |
| Reports per-model VRAM | **measured** | **yes** | no | no |
| Layer geometry for the planner | **from the file** | **yes** | no | no |
| Batch, threads, flash attention, rope | **yes** | no | no | at launch only |
| Installs the engine for you | **yes** | no | no | no |
| Downloads models for you | **yes** | yes | no | no |

Of the servers you bring yourself, **Ollama** is the most controllable and the only one
that reports its own CPU spill.
`/api/ps` gives both the model's total size and how much of it is in VRAM, and the gap
between those two numbers is exactly what did not fit. `/api/show` publishes the layer
count, KV head count, and embedding length, which is what lets the planner compute an
exact KV cache rather than an estimate.

**LM Studio** keeps most of its control surface in the `lms` CLI, so Nekko Agent drives
that: `lms server start` and `lms server stop` are a real lifecycle, and `lms load`
carries the context length and GPU share. It publishes no layer geometry anywhere, so
its projections are partial (see below). Driving it needs the CLI on the same machine as
the server, so a remote LM Studio can be read but not controlled.

**vLLM** is deliberately connect-existing only. It serves one model per process with
everything fixed by the launch command, and it is Linux plus NVIDIA plus Python in
practice. Nekko Agent detects it, shows its live `/metrics`, and can stop it, but never
starts it: instead the fit drawer renders the exact `vllm serve` command for you to run.
Nothing that could not be verified against real hardware ships as a working button.

## Reading the fit bar

The bar stacks what the model needs against what the device has free:

- **Weights**, the model's actual size. Taken from what the server reports or the file on
  disk, never computed from a parameter count times a quantization width, which is wrong
  for mixed-precision builds like `Q4_K_M`.
- **KV cache**, the conversation's memory: `2 x layers x kvHeads x headDim x context x
  bytesPerElement x parallelSlots`.
- **Runtime overhead**, compute buffers and the server's own reserve.

The marker line is where the device's free memory runs out. Anything drawn past it has to
live in system RAM instead.

## The verdicts

| Verdict | What it means |
|---|---|
| **Fits** | Everything runs on the GPU with room to spare. |
| **Tight** | It fits, but a long conversation may start spilling. |
| **Spills to CPU** | Part of the model runs on the CPU. It works, several times slower. |
| **Will not load** | It does not fit even using system memory, or the context exceeds the model's own maximum. |
| **Unknown** | The server did not report enough to project it. |

**Unknown is a real answer, not a bug.** Nekko Agent will not infer a model's memory use
from its name. If the layer count is missing, it says so and names what is missing. A
confident wrong number costs you a long load and every number after it.

Where the weights are known but the geometry is not, which is the usual LM Studio case,
the answer is partial rather than absent: the real weights figure is shown, and if the
weights alone overflow the machine the will-not-load verdict is still certain.

The planner never blocks a load. A will-not-load verdict warns clearly and still lets you
proceed. The estimate can be wrong, and it is your machine.

## Why a model spills to the CPU

Three things push a model off the GPU, in roughly this order of surprise:

1. **Context length.** The KV cache grows linearly with context. Going from 8k to 64k
   multiplies it eightfold, and past a point the cache is larger than the model.
2. **Parallel slots.** Every concurrent slot gets its own full KV cache. Raising
   `OLLAMA_NUM_PARALLEL` from 1 to 4 quadruples the cache at the same context, which is
   why a model that fit yesterday can stop fitting today with nothing else changed.
3. **Something else already resident.** The planner measures against *free* memory, not
   total, so another loaded model counts against you.

The suggestion chips fix these in that order, and each one is re-planned before being
offered, so clicking a suggestion always improves the verdict.

## Apple Silicon

A Mac shares one memory pool between the CPU and GPU. The budget is therefore system
memory, and Nekko Agent never adds a "VRAM" figure on top of RAM, which would make a
64 GB Mac look like it has 128 GB. The fit drawer says so explicitly when it applies.

## Multiple GPUs

Two 12 GB cards are not one 24 GB card. Without tensor parallelism a model has to fit on
a single device, so the planner measures against the roomiest one and says that it is not
pooling them. Only vLLM can split a model across cards, through `--tensor-parallel-size`.

## Settings that need a restart

Some settings are read only when the server starts. Ollama's parallelism
(`OLLAMA_NUM_PARALLEL`) and KV cache type (`OLLAMA_KV_CACHE_TYPE`) are both like this.
The Advanced section shows them with the exact environment line to set and marks them
restart-required, rather than offering a control that would quietly not apply.

`OLLAMA_KV_CACHE_TYPE=q8_0` roughly halves KV cache memory, which is often the cheapest
way to fit a longer context.

## Stopping a server

A server Nekko Agent started is stopped with its own handle, cleanly, and it will not
outlive the app. A server that was already running when Nekko Agent found it is somebody
else's process: stopping that one asks first and names what it would end, because the
thing holding port 11434 might be a service you depend on.

LM Studio is the exception that needs no such warning, since it has a real shutdown
command rather than a process to kill.

## What is not here yet

Browsing and downloading models from inside the app, and a bundled inference engine so a
fresh install can run a model with nothing else present, are both planned as separate
pieces of work. Today Nekko Agent manages the runtimes you already have.
