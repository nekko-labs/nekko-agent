# Distributing a single agent across machines ("token packet distribution")

Research date: 2026-11-28. Extends `/home/user/nekko-agent/reports/pooled-fleet-compute-options-2026-11-14.md`, which already covers llama.cpp RPC layer split, exo, MLX/JACCL, DGX Spark, distributed-llama, prima.cpp, Petals, vLLM+Ray, LocalAI, GPUStack and the network latency math. Those are not repeated here.

Fleet assumed: M1 Max 64 GB MacBook (Thunderbolt 4, ~400 GB/s memory bandwidth) and a Windows RTX 5090 32 GB PC (~1.8 TB/s), on LAN or Tailscale, running llama.cpp.

Method notes, for the report writer:
- In this session, WebFetch could not reach arxiv.org or blog.exolabs.net (DNS blocked by the session's network policy). The GitHub API was also unavailable for ggml-org/llama.cpp and exo-explore/exo.
- So most arXiv findings below come from search-engine abstracts and snippets, not full-paper reads. Treat the specific numbers as "reported in abstract or snippet." Each one carries an inline link to check against.
- Where I give an estimate of my own, it is labeled **Estimate**.

## 1. The autoregressive constraint, and the techniques that partly get around it

### Takeaway
One model's tokens cannot be generated as independent "packets" on different machines. Token N+1 depends on token N through the KV cache and the sampled output, so the decode of one sequence is a strictly serial chain of forward passes. Every technique that "parallelizes tokens" really does one of two things:
- **Guess-and-verify:** speculative decoding, Medusa/EAGLE/MTP, lookahead/Jacobi. A cheap guess is checked in one batched forward pass, and the serial chain gets shorter.
- **A model family with no left-to-right chain:** diffusion LLMs.

Only guess-and-verify splits across machines, with the draft on one and the verifier on another. The published 2025-2026 evidence says it pays only when the round trip is small compared with drafting and verification time. A home LAN (sub-millisecond RTT) is well inside that window. The expected gain over simply running the draft on the same machine as the target is modest.

### Cited Findings
**Distributed and edge-cloud speculative decoding (2025-2026)**
- **DSD** (arXiv 2511.21669, Nov 2025):
  - Extends speculative decoding to multi-device edge-cloud serving, with a discrete-event simulator (DSD-Sim) and an "Adaptive Window Control" policy that tunes the speculation window.
  - Reported gains are small: up to 1.1x speedup and 9.7% higher throughput over existing baselines.
  - Source: [DSD, arXiv 2511.21669](https://arxiv.org/abs/2511.21669)
- **"Speculation at a Distance: Where Edge-Cloud Speculative Decoding Actually Pays Off"** (Lyu, Irukulapati, Champati; arXiv 2606.25091, Jun 2026). Source for all points: [arXiv 2606.25091](https://arxiv.org/abs/2606.25091); [HTML](https://arxiv.org/html/2606.25091).
  - Distributed speculative decoding beats plain autoregressive decoding only inside a bounded RTT window. The window is set by target speed, acceptance rate, drafting time and communication overhead.
  - Pipelined distributed SD matches co-located SD only when RTT is shorter than the edge drafting window. Once RTT is at or above one round of drafting time, the latency-hiding benefit is gone.
  - If one server can host both models, co-located SD has lower latency and lower communication cost than synchronous distributed SD.
  - The paper's strongest case for distributed SD is throughput: offloading draft compute lets a saturated server serve more concurrent clients.
- **SpecRelay** (arXiv 2611.18963, Nov 2026):
  - Throughput falls as RTT grows, because each synchronous verification round waits a full round trip.
  - The gap between edge drafting and cloud drafting narrows at about 300-500 ms of added latency.
  - Source: [SpecRelay](https://arxiv.org/pdf/2611.18963)
- **Delay-Adaptive Speculation Control** (arXiv 2606.20591):
  - Frames draft-length choice as optimal stopping under stochastic network delay.
  - Longer drafts amortize the delay but are accepted less often.
  - Source: [arXiv 2606.20591](https://arxiv.org/html/2606.20591)
- **Other designs**:
  - SPADE (arXiv 2608.13076): edge draft, cloud verifier. Only rejected tokens trigger verifier correction. [SPADE](https://arxiv.org/html/2608.13076)
  - AsymSpec (arXiv 2608.04974): targets asymmetric uplink and downlink. [AsymSpec](https://arxiv.org/pdf/2608.04974)
  - DiP-SD (arXiv 2604.20919): several edge devices draft while one edge server batch-verifies. [DiP-SD](https://arxiv.org/pdf/2604.20919)
  - A pipelined collaborative SD paper (arXiv 2603.19133) models each round as max(drafting, RTT + verification), so throughput stops depending on RTT once drafting dominates. [arXiv 2603.19133](https://arxiv.org/pdf/2603.19133)
- A curated list of edge-cloud LLM decoding work is at [Awesome-Edge-Cloud-LLM](https://github.com/zz1358m/Awesome-Edge-Cloud-LLM).

**Multi-token prediction and self-speculation (single machine)**
- **EAGLE-3:**
  - The original paper reports up to 4.79x speedup on LLaMA-3.3-70B. This figure is as cited by the SpecForge paper. [SpecForge, arXiv 2603.18567](https://arxiv.org/html/2603.18567)
  - AMD ATOM docs (May 2026) report EAGLE 3.1 on MI355X at about 59.6% acceptance on gsm8k and about 2.79 tokens per forward pass with 3 speculative tokens. [AMD ATOM EAGLE-3 docs](https://rocm.docs.amd.com/projects/atom/en/main/eagle3_speculative_decoding.html)
- **llama.cpp `draft-mtp`:** PR #23269, merged 2026-05-19, adds `--spec-type draft-mtp`, which uses the MTP heads built into a checkpoint. The PR says parallel decoding with MTP is still "highly suboptimal" and that its goal is correctness for now. It can chain MTP with n-gram speculation. [llama.cpp PR #23269](https://github.com/ggml-org/llama.cpp/pull/23269)
- **MTP vs EAGLE:** MTP uses prediction heads inside the base checkpoint; EAGLE uses a separately trained draft head. [NVIDIA TensorRT-Edge-LLM docs](https://nvidia.github.io/TensorRT-Edge-LLM/user_guide/examples/speculative-decoding.html)

**Jacobi and lookahead decoding**
- Vanilla Jacobi decoding gives only about 1.05x on average. When an earlier token in the block is wrong, later guesses are rarely right. [CLLMs, arXiv 2403.00835](https://arxiv.org/html/2403.00835)
- CLLMs (consistency-fine-tuned models) report 2.4x to 3.4x faster generation. [CLLMs](https://arxiv.org/abs/2403.00835)
- Jacobi Forcing (Dec 2025) reports 3.8x wall-clock on coding benchmarks, and about 4x with multi-block decoding and rejection recycling. [Jacobi Forcing, arXiv 2512.14681](https://arxiv.org/html/2512.14681)

**Diffusion LLMs (tokens produced in parallel inside one model)**
- **Mercury 2** (Inception, launched 2026-02-24): 1,009 tok/s on NVIDIA Blackwell, with 1.7 s end-to-end latency. Vendor-reported. [NYU Shanghai RITS summary](https://rits.shanghai.nyu.edu/ai/inception-launches-mercury-2-diffusion-powered-reasoning-at-1000-tokens-per-second/)
- **LLaDA 2.X:** reported above 800 output tok/s. This is a secondary source, and the hardware is not stated in the snippet. [Red Hat Developer, 2026-04-28](https://developers.redhat.com/articles/2026/04/28/beyond-next-token-why-diffusion-llms-are-changing-game)
- **DiffusionGemma** (Google, reported June 2026):
  - Reported figures: about 1,000 tok/s on an H100 (attributed to NVIDIA), more than 700 tok/s on an RTX 5090 (Google), and 150 tok/s on DGX Spark (NVIDIA).
  - These are vendor claims passed on by a blog. No independent check was found.
  - [DEV Community write-up](https://dev.to/xoomar/1000-tokens-a-second-diffusiongemma-breaks-llm-math-22l7)
- Efficiency comparisons of diffusion LLMs depend heavily on setup, and one paper calls for a critical re-examination of the evaluation practices. [How Efficient Are Diffusion Language Models?, arXiv 2510.18480](https://arxiv.org/html/2510.18480v3)
- **Gemini Diffusion:** no tok/s figure found.

### Inferences
- **Why "token packets" fail.** Decode for one sequence is a chain: token t+1 needs the logits from t, and those need the KV of tokens 0..t.
  - Splitting that chain across machines (layer or tensor split) leaves only one machine busy at a time and adds a hop for every token. The 11-14 report already showed this: decode was slower when pooled.
  - Real parallelism exists only across sequences (batching or separate requests), inside a token (tensor math), or by guessing future tokens (speculation, Jacobi). Diffusion LLMs remove the left-to-right chain within a block, but they parallelize inside one model's forward pass. They do not give you a natural way to spread work over machines.
- **Cross-machine draft and verify on this fleet. Estimate.**
  - Take the target as a 70B Q4 model on the Mac, where decode is bandwidth-bound at about 8-11 tok/s (from the 11-14 report's 72B figure on an M2 Ultra; the M1 Max is likely slower). One verify step costs about 90-125 ms.
  - LAN RTT is 0.2-1 ms, which is negligible against that. The setup sits deep inside the "pays off" window of arXiv 2606.25091.
  - But the benefit over co-located speculation is roughly only the draft model's share of Mac bandwidth: about 1-2% for a 1B draft, about 10% for an 8B draft.
  - The real upside is letting the 5090 run a larger, higher-acceptance draft at no cost to the Mac. A plausible extra gain over co-located SD is about 10-30%. This is unmeasured.
  - When the target fits on the 5090, run everything on the 5090. Its bandwidth advantage of about 4.5x beats any split.
- **MTP and EAGLE need no second machine.** They are the highest-leverage single-agent latency win, and llama.cpp now has MTP drafting (still immature).
- **Diffusion LLMs are a single-machine speed story, not a distribution story.** A 5090 claim of more than 700 tok/s (DiffusionGemma) would make "local, fast" possible without any fleet split. Agent-grade quality and tool-calling ability of diffusion models were not assessed here.

### Gaps
- Full-text numbers (testbeds, acceptance rates, RTT sweeps) for DSD, Speculation at a Distance, SpecRelay and AsymSpec. I could not fetch arXiv, so only abstracts or snippets were seen.
- No public implementation was found of llama.cpp speculative decoding with the draft and target in different processes on different hosts. The 11-14 report notes llama.cpp's speculative path is in-process. The RPC backend can host a draft model's layers remotely, but that is not the same thing. Unverified.
- No llama.cpp EAGLE-3 benchmark numbers were found.
- Whether llama.cpp's diffusion support (LLaDA or Dream examples) is production-usable. I recall from memory that it exists as an example CLI; this is unverified.

## 2. Prefill/decode disaggregation and KV-cache transfer

### Takeaway
In data centres, PD disaggregation is mature: DistServe, Splitwise, Mooncake, SGLang PD, vLLM/llm-d, Dynamo. Its benefit is SLO goodput under many concurrent users, and KV transfer is its main cost.

The only consumer-grade demo is exo's DGX Spark (prefill) plus M3 Ultra (decode) over 10GbE: 2.8x end-to-end for an 8k-token prompt with 32 output tokens. It works because one box is compute-strong and the other is bandwidth-strong, and because KV is streamed layer by layer, overlapped with prefill.

In Nekko's fleet, the 5090 is stronger at both phases for any model it can hold. So a "5090 prefills, Mac decodes" design helps only when the model is too big for the 5090 (then the 5090 cannot prefill it alone either) or when the Mac must decode for another reason. Disaggregating one agent between these two machines is mostly research-only. A layer-split pooled prefill (llama.cpp RPC) already captures the "use the bigger GPU for prompt processing" effect.

### Cited Findings
- **exo, DGX Spark + M3 Ultra Mac Studio.** Sources: [Tom's Hardware](https://www.tomshardware.com/software/two-nvidia-dgx-spark-systems-combined-with-m3-ultra-mac-studio-to-create-blistering-llm-system-exo-labs-demonstrates-disaggregated-ai-inference-and-achieves-a-2-8-benchmark-boost); [allthings.how](https://allthings.how/dgx-spark-mac-studio-disaggregated-llm-inference-with-exo/); original post [exo blog](https://blog.exolabs.net/nvidia-dgx-spark/), not fetchable from this session; [Simon Willison, 2025-10-16](https://simonwillison.net/2025/Oct/16/nvidia-dgx-spark-apple-mac-studio/).
  - Setup: Llama-3.1 8B FP16, 8,192-token prompt, 32 generated tokens.
  - Total time: Spark alone 4.34 s, M3 Ultra alone 6.42 s, combined 2.32 s, so 2.8x versus the Mac.
  - The link is 10GbE. KV is streamed layer by layer, overlapping transfer with prefill.
  - The "4x" headline refers to the prefill phase only.
  - Tom's Hardware says two Sparks; exo's table reportedly lists one. This conflict is unresolved.
  - An NVIDIA forum thread notes that a Spark-prefill / RTX-decode configuration has not been reproduced or released publicly. [NVIDIA dev forum](https://forums.developer.nvidia.com/t/dgx-spark-rtx-6000-pro-blackwell-disaggregated-inference/368860)
- **Data-centre PD results.** Secondary sources, original papers not fetched. Sources: [Topology-Aware Data Movement, arXiv 2607.28633](https://arxiv.org/html/2607.28633v1); [Jarvislabs blog](https://jarvislabs.ai/blog/llm-optimization-disaggregated-prefill-decode); [Mooncake](https://www.researchgate.net/publication/397645965_Mooncake_A_KVCache-centric_Disaggregated_Architecture_for_LLM_Serving).
  - DistServe: reported as up to 4.48x more requests at equal SLO, elsewhere as 7.4x more requests or 12.6x tighter SLO. Different workloads and metrics.
  - Splitwise: 2.35x throughput on the same resources, or 1.4x throughput at 20% lower cost.
  - Mooncake: a KV-centric store over CPU DRAM, SSD and RDMA. Its "525%" figure is unverified.
- **When PD loses:**
  - All of these systems treat KV transfer as the main overhead of disaggregation.
  - For some workloads, transfer overhead exceeds the benefit. [arXiv 2607.28633](https://arxiv.org/html/2607.28633v1)
  - Follow-up work through 2026 targets transfer cost and placement: SpectrumKV, which transfers KV at mixed precision per token ([arXiv 2606.08635](https://arxiv.org/pdf/2606.08635)), and NetKV, which picks decode instances by network conditions ([arXiv 2606.03910](https://arxiv.org/pdf/2606.03910)).
- **Large-scale PD in production:**
  - SGLang on 96 H100s with PD plus DeepEP: 52.3k input and 22.3k output tok/s per node for 2,000-token inputs, up to 5x the output throughput of vanilla TP. [LMSYS, 2025-05-05](https://lmsys.org/blog/2025-05-05-large-scale-ep/)
  - vLLM/llm-d wide-EP: a sustained 2.2k tok/s per H200 on an InfiniBand/CX-7 cluster. [vLLM blog, 2025-12-17](https://vllm.ai/blog/2025-12-17-large-scale-serving)
- **KV transfer over ordinary networks, CacheGen** (SIGCOMM 2024):
  - Fetching a reused KV cache over a network can add from hundreds of ms to more than 10 s.
  - CacheGen compresses KV into bitstreams 3.5-4.3x smaller, cuts total fetch-and-process delay 3.2-3.7x with negligible quality loss, and can recompute instead when bandwidth drops.
  - Source: [CacheGen, arXiv 2310.07240](https://arxiv.org/abs/2310.07240v6); [code](https://github.com/UChi-JCL/CacheGen)

### Inferences
- **KV size math. Estimate, FP16 KV, standard GQA configs.**
  - Llama-3.1-8B (32 layers × 8 KV heads × 128 dims × K and V × 2 bytes) is about 128 KB per token. An 8k prompt is about 1 GB; a 32k prompt is about 4 GB.
  - Llama-70B (80 layers) is about 320 KB per token, so an 8k prompt is about 2.6 GB.
  - Transfer time for 1 GB: about 9 s on 1GbE, 3.5 s on 2.5GbE, about 0.9 s on 10GbE, and roughly 0.4-0.8 s on Thunderbolt 4 networking (unverified Mac-to-Windows).
  - Q8 KV halves these figures. CacheGen-style compression cuts them by about 3.5-4x more.
- **When a 5090 → Mac handoff could pay. Estimate.**
  - Condition: the Mac must decode, the model fits on both machines, and the prompt is long.
  - The 5090 prefills an 8k prompt for an 8B model in well under a second. The M1 Max likely needs several seconds.
  - On 10GbE or Thunderbolt the handoff is roughly break-even to about 2x on time-to-first-token. On 1GbE or Wi-Fi it is a loss.
  - Since the 5090 would also decode that model about 4x faster, this pattern is rarely the best plan. It makes sense only when the 5090 is busy with something else, such as a game or another agent.
- **The more practical cousin is a KV and prefix cache handoff for agent continuity.**
  - Example: a conversation moves between machines, or a long fixed system-prompt and tool-schema prefix is reused.
  - In that case a one-time KV transfer, or simple re-prefill on the faster machine, avoids repeated work.
  - llama.cpp has slot save and restore. Whether its KV files are portable between the Metal and CUDA builds is **unverified**.

### Gaps
- Primary DistServe, Splitwise and Mooncake numbers, and NIXL or Mooncake Transfer Engine bandwidth figures, were not fetched.
- LMCache's current status and integration (it is the CacheGen team's productization) was not confirmed in this pass.
- No measurement of KV transfer between Apple-silicon llama.cpp and CUDA llama.cpp exists in what I found.
- llm-d and NVIDIA Dynamo 2026 consumer or edge support: nothing found, and both target Kubernetes and the data centre, per the 11-14 report.

## 3. Expert parallelism (MoE) across nodes

### Takeaway
Wide expert parallelism is a data-centre technique: DeepEP all-to-all over InfiniBand or RDMA, tens to hundreds of GPUs. Its per-token all-to-all exchanges are latency-bound, just like tensor parallelism. I found no consumer-grade cross-machine EP over Ethernet.

What consumers actually do with big MoE models is pipeline/layer split (exo, Parallax, llama.cpp RPC) or keep the experts in system RAM on one box.

### Cited Findings
- DeepEP has a high-throughput mode for prefill and a low-latency mode for decode. SGLang's 96-H100 deployment combined DeepEP-based EP with PD disaggregation for up to 5x the output throughput of TP. [LMSYS](https://lmsys.org/blog/2025-05-05-large-scale-ep/)
- vLLM wide-EP reached 2.2k tok/s per H200, up from about 1.5k, on InfiniBand/CX-7. llm-d's "Wide EP well-lit path" is the recommended way to reproduce it. [vLLM blog](https://vllm.ai/blog/2025-12-17-large-scale-serving); [Red Hat on vLLM + llm-d wide-EP](https://developers.redhat.com/articles/2025/09/08/scaling-deepseek-style-moes-vllm-and-llm-d-using-wide-ep)
- SGLang's June 2026 load-balancing work for DeepEP (Waterfill, LPLB) gives +0.84% to +7.34% total throughput on two Hopper nodes. These are incremental, data-centre gains. [LMSYS, 2026-06-26](https://lmsys.org/blog/2026-06-26-waterfill-lplb)
- On the consumer side, exo added tensor sharding for MiniMax M2.1 (v1.0.67, about 2026-01-28) and support for Kimi K2.5 and K2.6. [exo v1.0.67](https://newreleases.io/project/github/exo-explore/exo/release/v1.0.67); [exo v1.0.71](https://newreleases.io/project/github/exo-explore/exo/release/v1.0.71)
- Gradient's Parallax ran a 235B model on an RTX 5090 plus three Mac M4 Pro 64 GB machines, at 150.0 s end-to-end. The test conditions were not fully visible in the snippet, and the split is pipeline-style, not EP. [Gradient Parallax PDF](https://gradient.network/parallax.pdf)

### Inferences
- **The EP latency floor. Estimate.**
  - A DeepSeek-style MoE does a dispatch and a combine all-to-all at every MoE layer, so about 2 × 60 or more exchanges per decode token.
  - That is the same order as the TP sync count in the 11-14 report (about 48 ms per token at 0.3 ms per exchange on wired LAN). EP over home Ethernet hits the same ceiling.
- For a two-to-four-machine fleet, MoE is best served by putting whole layers (experts included) on each machine, or by expert offload to system RAM on the 5090 box. Nekko already has the "experts in system RAM" option.

### Gaps
- No consumer or Thunderbolt EP attempt was found. Absence from search results is not proof that none exists.
- Whether llama.cpp's mainline "split mode tensor" can distribute experts across RPC devices is not confirmed (see section 6).

## 4. Decentralized and over-internet inference and training (status, 2026)

### Takeaway
Over the WAN, the techniques that work are pipeline-style serving with heterogeneity-aware scheduling (Gradient Parallax, Petals lineage) and data-parallel, low-communication RL or training (Prime Intellect, Nous Psyche, Pluralis). In both, a single sequence's tokens still run serially across hops, so per-token latency is worse than one good machine. The wins are capacity and aggregate throughput, not single-agent latency.

The most relevant reusable pieces for Nekko are Parallax's scheduler, which has been demonstrated on an RTX 5090 + Mac M4 Pro mix, and TOPLOC-style inference verification. Verification matters only for untrusted peers, and a user's own fleet is trusted.

### Cited Findings
- **Gradient Parallax.**
  - Peer-reviewed-style paper (arXiv 2509.26182). Source: [arXiv 2509.26182](https://arxiv.org/abs/2509.26182); [HTML](https://arxiv.org/html/2509.26182).
    - Uses a two-phase scheduler over heterogeneous, decentralized GPUs, with HexGen as the baseline.
    - Testbed: 5× RTX 5090 and 2× RTX 4090 in geographically separated data centres with about 10 ms average inter-machine latency.
    - Reported average latency is 37.6 ms with p99 of 111.4 ms (ShareGPT, request rate 4, FP16). The metric's definition was not visible in the snippet.
  - Gradient's own technical report, vendor-reported. Source: [gradient.network/parallax.pdf](https://gradient.network/parallax.pdf); [Pure Neo news](https://pure-neo.io/ai-news/gradient-network-launches-parallax-a-decentralized-inference-engine-for-ai-models).
    - Claims up to 5.3x lower inter-token latency and 3.1x throughput versus Petals, on Qwen2.5-72B GPTQ-Int4.
    - Includes an RTX 5090 + Mac M4 Pro 64 GB configuration, with a table row "1×4K | 242.4 | 64.9 | 173.6 | 4.2". The column headers were cut off in the snippet, so these values are uninterpretable without the PDF.
    - Uses continuous batching and paged KV across NVIDIA and Apple silicon.
- **Prime Intellect.**
  - INTELLECT-3 (106B) was trained on a centralized 512-GPU H200 InfiniBand cluster, not in a decentralized way. [implicator.ai](https://www.implicator.ai/prime-intellects-intellect-3-open-source-ambition-meets-centralized-reality/)
  - TOPLOC is a locality-sensitive-hashing scheme for verifiable inference. It detects model swaps and precision changes and is robust to GPU non-determinism. In INTELLECT-2, rollout workers generated traces and TOPLOC validators checked them. [INTELLECT-2, arXiv 2505.07291](https://arxiv.org/pdf/2505.07291)
  - About 1% overhead, reported second-hand. [hoge.gg](https://hoge.gg/decentralized-inference-2026-verification-trust/)
- **Nous Psyche:** epoch-based join and leave, witness verification by random node subsets, Solana for coordination and rewards. Secondary source. [Spheron 2026 guide](https://www.spheron.network/blog/decentralized-llm-training-pluralis-prime-intellect-nous-psyche/)
- **Pluralis:** uses model parallelism over low-bandwidth links. Prime Intellect and Nous mainly use data parallelism. Secondary source. [Spheron 2026 guide](https://www.spheron.network/blog/decentralized-llm-training-pluralis-prime-intellect-nous-psyche/)
- A 2026 overview says decentralized GPU networks suit work that splits into independent pieces (inference requests, rendering, fine-tuning) and fit poorly where GPUs must exchange data many times a second. [prompt20](https://blog.prompt20.com/posts/decentralized-ai/)

### Inferences
- These systems confirm the 11-14 report's thesis. Across WAN or LAN, distribute requests or sequences (data parallel) and pipeline stages, never per-token tensor syncs.
- Parallax is the closest prior art to a "heterogeneous Mac + 5090 pooled model" in a Nekko-like setting. It is worth a direct evaluation if Phase 2 (pooled model) goes ahead. Open-source status and license were not confirmed in this pass.

### Gaps
- Gensyn: no current information retrieved.
- Petals successors other than Parallax: none found.
- Primary Prime Intellect, Nous and Pluralis documents were not fetched. Secondary sources disagree on some dates and details.
- Measured WAN throughput for a single long sequence on Parallax was not visible.

## 5. Agent-level (not token-level) splitting of a single agent

### Takeaway
The best measured end-to-end gains for one agent come from overlapping and parallelizing the agent loop, not from splitting the model:
- Parallel or DAG-planned tool calls: LLMCompiler, 1.35x over OpenAI parallel calling and up to 3.7x over ReAct.
- Speculative tool execution, where a cheap predictor runs likely tool calls while the main model is still thinking: about 20-48% latency cuts, 1.31-1.35x on SWE-bench and Terminal-Bench.

These map naturally onto a fleet. The speculator model and the speculative tool sandbox can live on the idle machine, and the main model stays on the fastest one. That costs only one message per step, which is latency-insensitive.

### Cited Findings
- **LLMCompiler** (ICML 2024):
  - A planner, task-fetching unit and executor run function calls in parallel.
  - Up to 3.7x latency speedup and 6.7x cost saving versus ReAct, with about 9% accuracy gains. Specific results: HotpotQA 1.80x, Movie Recommendation 3.74x.
  - Up to 1.35x over OpenAI's parallel function calling.
  - Paper versions differ: v3 cites up to 2.27x on ParallelQA.
  - Source: [arXiv 2312.04511](https://arxiv.org/abs/2312.04511); [PMLR](https://proceedings.mlr.press/v235/kim24y.html)
- **Speculative Actions:** a lossless framework that speculates over LLM calls, tool APIs, MCP servers and human replies. Up to 55% prediction accuracy gives about 20% end-to-end latency reduction. Misses are discarded at no correctness cost. [Speculative Actions summary](https://hungchun0201.github.io/agentic-ai-survey/papers/speculative-actions/index.html)
- **PASTE / "Act While Thinking"** (arXiv 2603.18897, Mar 2026): pattern-aware speculative tool execution. 48% lower tool execution latency at moderate settings, and speculative jobs are preempted under contention. [arXiv 2603.18897](https://arxiv.org/html/2603.18897v1)
- **Speculative Macro Commit** (arXiv 2609.03236, Sep 2026): commits pre-executed multi-action macros. On τ²-Bench Telecom, 10.23% lower latency than Speculative Actions and 18.59% lower than sequential. [arXiv 2609.03236](https://arxiv.org/html/2609.03236)
- **TomasuLLM** (arXiv 2609.38201, Sep 2026): out-of-order tool execution with in-order commit. 1.31x on 100 SWE-bench Verified tasks and 1.35x on 28 Terminal-Bench 2.0 tasks, with zero false accepts in audited commits. [arXiv 2609.38201](https://arxiv.org/abs/2609.38201)
- **Speculate with Memory** (arXiv 2607.12236): the speculator uses structured memory of past trajectories, and misses are discarded. [arXiv 2607.12236](https://arxiv.org/pdf/2607.12236)
- **Search agents:** speculation-based algorithm and system co-design to cut search-agent latency (arXiv 2511.20048). Numbers were not seen. [arXiv 2511.20048](https://arxiv.org/pdf/2511.20048)
- **BunshinRL** (arXiv 2611.10453, Nov 2026): whole-workspace forking with a small classifier that predicts tool calls, for RL rollouts. [arXiv 2611.10453](https://arxiv.org/pdf/2611.10453)
- **Context reuse:** CacheGen-style KV streaming cuts context-load delay 3.2-3.7x compared with recomputing or fetching uncompressed KV. This is relevant when an agent's long context moves between machines. [CacheGen](https://arxiv.org/abs/2310.07240v6)

### Inferences
- **Concrete fleet mapping for one agent. Design inference, not measured.**
  - (a) The main model runs on the fastest machine for that model: the 5090 if it fits, otherwise the Mac.
  - (b) A small speculator model, plus speculative tool execution in a sandbox or copy-on-write workspace, runs on the other machine. It predicts the next tool calls and pre-runs read-only ones such as search, file reads, `git status` and test discovery.
  - (c) Independent tool calls in one turn fan out across machines.
  - (d) Long-context prefill always goes to the 5090 when the model fits there.
  - Per-step network cost is one small message, so even Tailscale works. The reported 1.2-1.5x end-to-end range is a reasonable expectation for coding agents.
  - Side-effecting tools (writes, network posts) must not be speculated without a commit gate. TomasuLLM's in-order commit and the Speculative Macro Commit design are the prior art.
- This is the only category where a second machine improves a single agent's latency without a fast link.

### Gaps
- No paper was found that measures speculative tool execution with the speculator on a separate physical machine. All results are single-host or data-centre.
- Speculative Actions' arXiv ID and full benchmark details were not retrieved. Only the survey-hosted summary was seen.

## 6. Updates after 2026-11-14 (llama.cpp RPC, exo, MLX, Apple/NVIDIA home products)

### Takeaway
I found no material change after 2026-11-14 in the sources I could reach.

Context that is relevant and may be newer than what the 11-14 report covered:
- llama.cpp mainline gained a backend-agnostic tensor-parallel mode ("split mode tensor", PR 19378, around Feb 2026). RPC devices reportedly could not use it for graph parallel at that time.
- llama.cpp added MTP speculative drafting (May 2026).
- exo's latest release seen is still v1.0.71, matching the 11-14 report.
- NVIDIA's RTX Spark Windows-on-Arm PCs (up to 128 GB unified memory) shipped in fall 2026, with no clustering feature announced.

### Cited Findings
- **llama.cpp tensor parallelism:**
  - A Feb 2026 ik_llama.cpp discussion says Johannes Gaessler's PR 19378 landed in mainline as a back-end-agnostic TP ("split mode tensor"), and that RPC-connected devices could not then be used for graph parallel. [ik_llama.cpp discussion #1247](https://github.com/ikawrakow/ik_llama.cpp/discussions/1247)
  - A third-party guide says cross-machine tensor split is not supported and mentions an unreleased RPC protocol v8 with TP support. [alisworks Substack](https://alisworks.substack.com/p/llamacpp-rpc-multi-machine-distributed)
  - Spice AI has a PR that serves a GGUF model tensor-parallel across nodes over llama.cpp RPC. Undated in the snippet. [spiceai PR #15584](https://github.com/spiceai/spiceai/pull/15584)
  - Sources conflict on whether mainline cross-host TP over RPC works today.
- **llama.cpp MTP drafting:** PR #23269, merged 2026-05-19. [PR #23269](https://github.com/ggml-org/llama.cpp/pull/23269)
- **exo releases.** No release dated after 2026-11-14 was found.
  - v1.0.71: sampling defaults, M5 and RDMA fixes, Kimi K2.6.
  - v1.0.66: an RDMA/TP loading regression fix.
  - v1.0.64: IP-less RDMA discovery and OpenAI-compatible tool calling.
  - No Windows or CUDA support was found in the release notes seen.
  - Sources: [v1.0.71](https://newreleases.io/project/github/exo-explore/exo/release/v1.0.71); [v1.0.66](https://newreleases.io/project/github/exo-explore/exo/release/v1.0.66); [v1.0.64](https://newreleases.io/project/github/exo-explore/exo/release/v1.0.64)
- **NVIDIA RTX Spark (Computex 2026):**
  - Arm CPU (up to 20 cores) plus a Blackwell GPU (up to 6,144 cores), up to 128 GB LPDDR5X unified memory. Bandwidth is quoted as 300 GB/s by one source and 600 GB/s by another.
  - Surface Laptop Ultra starts at $2,599.99, with 24 GB in the base configuration.
  - Clustering is not announced. One outlet speculates that an RTX Spark desktop could serve models to other home devices.
  - Sources: [NVIDIA newsroom](https://nvidianews.nvidia.com/news/nvidia-rtx-spark-pcs-available-today-a-new-beginning-for-windows-pcs); [Tom's Hardware](https://www.tomshardware.com/laptops/nvidia-unveils-rtx-spark-superchip-at-computex-2026-new-platform-promises-to-turn-windows-into-an-agentic-ai-os-with-arm-cpu-blackwell-gpu-and-128gb-unified-memory); [Digit](https://digit.in/features/laptops/nvidia-rtx-spark-brings-128-gb-memory-and-local-ai-to-windows-laptops-starting-at-usd-2599.html)
- **CUDA 13.4** adds Windows on Arm, tied to RTX Spark. Reports conflict on whether it is a developer preview or GA (13.4.1, about Sep 2026). [NVIDIA forum](https://forums.developer.nvidia.com/t/cuda-toolkit-13-4-adds-windows-on-arm-support-and-greater-control-over-shared-gpus/382829.md); [tech-insider](https://tech-insider.org/nvidia-cuda-13-4-windows-on-arm-2026/)

### Inferences
- If cross-host "split mode tensor" over RPC lands, it still hits the TP sync-latency ceiling from the 11-14 report (about 20 tok/s on wired LAN for an 80-layer model). It does not change the recommendation for TB4/LAN hardware.
- RTX Spark is a third device class (CUDA plus large unified memory) that a Nekko fleet may contain. Treat it as "a big-memory node to route to," not as a clustering product.

### Gaps
- The llama.cpp release notes and PR list for 2026-11-14 to 2026-11-28 could not be read, because the GitHub API and fetch were blocked. Recent RPC or RDMA changes are therefore unverified.
- No MLX distributed or Apple home-cluster news after 2026-11-14 was found. I did not run a dedicated search for it, so this is a coverage gap, not evidence of no news.
- exo Windows/CUDA status remains unverified, as it was in the 11-14 report.

## 7. Bottom line for a 2-4 heterogeneous consumer machine fleet

### Takeaway
A single agent cannot be sped up by scattering its tokens across machines. Every token-level split (layer, tensor, expert) makes decode slower on consumer links, and it is useful only to fit a model that does not fit anywhere else.

The practical wins, in order:
1. Put the agent's model on the single best machine. For decode bandwidth, that is the 5090 when the model fits.
2. Single-machine speculation (MTP, EAGLE, n-gram): about 1.5-3x decode, measured in other stacks.
3. Agent-loop parallelism (parallel tool calls, speculative tool execution) with the speculator and sandbox on a second machine: about 1.2-1.5x end-to-end, measured on single hosts.
4. Cross-machine draft/verify speculative decoding, only when the target lives on the Mac: estimated 10-30% over co-located, unmeasured.

Prefill/decode disaggregation between home machines is research or demo grade: exo, 2.8x, 10GbE, special hardware pairing. Wide EP and decentralized-WAN tensor schemes are data-centre or research-only for this purpose.

### Cited Findings (summary with sources)
| Technique | Splits across machines? | Best evidence | Measured gain | Practical for M1 Max + 5090? |
| --- | --- | --- | --- | --- |
| Layer/pipeline split (RPC) | Yes | 11-14 report; [Parallax](https://gradient.network/parallax.pdf) | Decode slower; fits bigger models | Only for models that fit nowhere alone |
| Tensor/expert parallel | Yes | [vLLM wide-EP](https://vllm.ai/blog/2025-12-17-large-scale-serving), [LMSYS](https://lmsys.org/blog/2025-05-05-large-scale-ep/) | Data-centre only (IB/RDMA) | No |
| Distributed speculative decoding | Yes (draft ↔ verifier) | [DSD](https://arxiv.org/abs/2511.21669), [Speculation at a Distance](https://arxiv.org/abs/2606.25091) | Up to 1.1x vs baselines (DSD); wins only in a bounded RTT window | Possible on LAN; modest; custom engine work |
| MTP / EAGLE-3 / n-gram (one box) | No | [EAGLE-3 via SpecForge](https://arxiv.org/html/2603.18567), [llama.cpp MTP PR](https://github.com/ggml-org/llama.cpp/pull/23269) | Up to 4.79x (EAGLE-3, 70B, data centre); about 2.79 tok/step (ATOM) | Yes, highest-leverage latency lever |
| Jacobi / lookahead / CLLM | No | [CLLMs](https://arxiv.org/abs/2403.00835), [Jacobi Forcing](https://arxiv.org/html/2512.14681) | 2.4-4x (needs fine-tuned model) | Model-dependent; research |
| Diffusion LLMs | No | [Mercury 2](https://rits.shanghai.nyu.edu/ai/inception-launches-mercury-2-diffusion-powered-reasoning-at-1000-tokens-per-second/), [DiffusionGemma claims](https://dev.to/xoomar/1000-tokens-a-second-diffusiongemma-breaks-llm-math-22l7) | About 1,000 tok/s (vendor); more than 700 tok/s on a 5090 (vendor) | Single-machine speed; agent quality unassessed |
| PD disaggregation | Yes (KV handoff) | [exo Spark+M3 Ultra](https://www.tomshardware.com/software/two-nvidia-dgx-spark-systems-combined-with-m3-ultra-mac-studio-to-create-blistering-llm-system-exo-labs-demonstrates-disaggregated-ai-inference-and-achieves-a-2-8-benchmark-boost) | 2.8x end-to-end (8B, 8k prompt, 10GbE) | Rarely: the 5090 wins both phases when the model fits |
| KV/prefix cache shipping | Yes (one-time) | [CacheGen](https://arxiv.org/abs/2310.07240v6) | 3.2-3.7x lower context-load delay | Useful for moving a conversation between machines |
| Parallel / speculative tool execution | Yes (agent level) | [LLMCompiler](https://arxiv.org/abs/2312.04511), [TomasuLLM](https://arxiv.org/abs/2609.38201), [PASTE](https://arxiv.org/html/2603.18897v1), [Speculative Actions](https://hungchun0201.github.io/agentic-ai-survey/papers/speculative-actions/index.html) | 1.2-1.35x end-to-end; up to 3.7x vs ReAct | Yes; latency-tolerant, works over Tailscale |

### Inferences
- **The "token packet distribution" framing should be redirected.** What can be distributed are:
  - (a) whole requests and sub-agents (covered by another researcher);
  - (b) guesses: drafts and speculative tool calls, which tolerate latency because they are verified later;
  - (c) one-time bulk state: KV and prefix caches, and prefill of long contexts.
- What cannot usefully be distributed on consumer links is the per-token forward pass of one sequence.
- **Suggested engineering order for Nekko. Estimate of value, not measured.**
  1. Fleet routing that sends each agent to the machine with the best decode bandwidth for its model.
  2. Enable and benchmark llama.cpp MTP or draft speculation per model on each machine.
  3. Agent-runtime parallel tool calls, then read-only speculative tool execution, with the speculator on the idle machine.
  4. Conversation migration via KV or slot transfer or re-prefill on the faster machine.
  5. Only then a cross-host draft/verify experiment for Mac-resident large models.
  6. Do not attempt PD disaggregation or EP on TB4/LAN.

### Gaps
- None of these gains has been measured on an M1 Max + RTX 5090 pair. All fleet-specific numbers above are estimates.
- Quality and tool-calling fitness of diffusion LLMs and CLLM-style models for agent workloads was not researched.
