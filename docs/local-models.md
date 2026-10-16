# Running models locally

Nekko Agent runs models two ways: with its **own engine**, which needs nothing else
installed, or by driving a server you already run (Ollama, LM Studio, vLLM). Either way
it loads a model with the settings you choose and tells you honestly whether it will fit
before you wait through the load. This is what the Models page shows you and why.

## The Nekko engine

The engine is llama.cpp, managed by Nekko Agent. You press one button, a build comes down
from llama.cpp's own releases (about 30 MB for Vulkan or CPU, several hundred MB for
CUDA), and the app can serve models. Nothing
is downloaded before that press.

**Which build.** Picked from what the GPU probe actually found, not from the platform:
CUDA where `nvidia-smi` answers and the card can run it, Vulkan for any other GPU, Metal
on Apple Silicon, CPU where there is no evidence of anything else. A slow engine that runs
beats a fast one that fails to start. llama.cpp's CUDA build is CUDA 13, which needs a
GTX 16 / RTX 20 series card or newer (compute capability 7.5) and driver 580 or newer, so
an older card or driver is recommended Vulkan and told why. The picker says CUDA is
roughly 15-20% faster than Vulkan on NVIDIA (a rough public figure, not yet measured on
our hardware); it is also the bigger download, about 550 MB on Windows with NVIDIA's CUDA
runtime against Vulkan's 30 MB. A supported NVIDIA machine on a Vulkan or CPU build is
offered **Switch to CUDA** on the Model server card. Every other build
for your machine stays in the list if you disagree. If you already have a `llama-server`,
point at it instead: Nekko Agent will run it and never update or remove it.

**No Visual Studio, ever.** The Windows builds of llama.cpp and stable-diffusion.cpp, and
Nekko's own engine daemon, need the Microsoft Visual C++ Runtime (`MSVCP140.dll`,
`VCRUNTIME140.dll`), not Visual Studio. The installer carries those DLLs beside the daemon
(about 1 MB), and on a PC without the Visual C++ Redistributable they are copied in beside
the engine before it starts. If an engine still dies for a missing DLL, the error says so
and links Microsoft's 25 MB redistributable.

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
the app says what it means next to the setting. **A network bind requires a key**: the
engine refuses to listen on your network with the key empty, and picking **This computer
and my network** with no key set fills one in for you (a key you already typed is kept).
Send it as a Bearer token from the apps you point at the engine.

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

## Long tasks on a small context window

A local model is often loaded with an 8k or 32k context, and an agent fills that in a few
steps: one large file read or one noisy build log is most of it. Nekko Agent keeps the work
going rather than stopping when the window fills:

- **It uses the window the model was loaded with**, not the model's advertised maximum.
  LM Studio and the Nekko engine report it in their model list, and Ollama reports it for a
  loaded model. For anything that reports nothing, it falls back to a guess from the name.
- **Older tool output is left out of the request** once the conversation nears 80% of that
  window. The oldest large results (file reads, command output) are replaced, in what is sent,
  by a one-line note saying how much was there; the chat itself keeps everything, and the model
  can simply run the tool again if it needs that output back.
- **If the server still says the prompt is too long**, the request is sent once more with all
  of the older tool output left out.
- **If that is not enough, the chat compacts and carries on by itself.** The older part of the
  conversation is summarized, and the agent is asked to continue from the summary. This happens
  at most twice in a row before the chat waits for you, so a model that cannot make progress
  does not loop.

Giving the model more room is still the best fix. Raise its context when you load it (the
Models page shows what that costs in memory), and `OLLAMA_KV_CACHE_TYPE=q8_0` roughly halves
the memory a longer context needs.

## Pictures and models that cannot see

Only a vision model with its projector file (`mmproj-*.gguf`) beside it can look at a
picture. The Nekko engine tells the app which of its models have one, so for a text-only
model such as Qwen3 4B the composer greys out **Photo / Video** and says why.

A picture can still end up in a text-only chat: you attached it while a vision model was
picked and then switched, or you used a server the app cannot classify. Such a server
rejects every request that carries an image, and the image stays in the conversation, so
before this guard the chat failed on every later message too. Now, when the model is known
not to take images, each picture is sent as a one-line note ("1 image attachment omitted:
this model does not accept image input") and the chat keeps working. The picture stays in
the chat itself, so switching back to a vision model sends it again.

A server that does not say what its models take still receives the pictures. If such a
model refuses them, click **Delete last message** in the failure notice (or **Delete** on
the message itself). That removes the message with the picture and anything after it, and
the chat answers again. You can then ask again without the picture, or switch to a model
with vision input.

## What is not here yet

Browsing and downloading models from inside the app, and a bundled inference engine so a
fresh install can run a model with nothing else present, are both planned as separate
pieces of work. Today Nekko Agent manages the runtimes you already have.
