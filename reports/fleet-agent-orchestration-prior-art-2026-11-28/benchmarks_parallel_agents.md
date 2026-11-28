# Benchmarks and empirical evidence: does delegating agent work to parallel agents/machines help?

Research date: 2026-11-28. Method note: arxiv.org, research.google, cursor.com and superagent.sh did not resolve from this research session (network allowlist). Figures from those sources therefore come from search-result snippets and secondary coverage, not full-text reads, and are marked [snippet-verified]. Only anthropic.com was read in full. Labels: [VENDOR] = self-reported by the company that built the system; [ACADEMIC] = peer-reviewed or preprint by researchers; [INDEPENDENT] = third-party measurement; [UNVERIFIED] = could not confirm against a primary source.

## 1. Published lab/vendor results (Anthropic, Cursor, OpenAI, Kimi, Cognition, Google)

### Takeaway
The headline vendor numbers hold up. Anthropic reports +90.2% on an internal research eval at about 15x the tokens of a chat. Kimi reports up to 4.5x faster wall-clock and a BrowseComp rise from 60.6% to 78.4%. Google/MIT report +80.9% on parallelizable finance tasks but -39% to -70% on sequential planning. Gains show up on breadth-first, parallelizable search or research and appear to scale mainly with tokens spent. Results on sequential or tightly coupled work such as most coding are neutral or negative. Every lab and vendor speed or quality number found is self-reported.

### Cited Findings
**Anthropic multi-agent Research system (June 2025) [VENDOR]**
- A multi-agent system (Claude Opus 4 lead, Claude Sonnet 4 subagents) outperformed single-agent Claude Opus 4 by **90.2%** on Anthropic's internal research eval. — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Token usage: agents use **about 4x** more tokens than chat interactions, and multi-agent systems use **about 15x** more than chats. Note that 15x is relative to chat, not to a single agent, which by those two figures is roughly 3-4x. — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- On BrowseComp, three factors explained **95%** of performance variance. Token usage alone explained **80%**, with number of tool calls and model choice as the other two. Upgrading to Sonnet 4 beat doubling the token budget on Sonnet 3.7. Implication: much of the "multi-agent gain" is a way of spending more tokens in parallel. — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Parallelism (lead spawns 3-5 subagents in parallel, and each subagent runs 3+ tools in parallel) cut research time by **"up to 90%"** for complex queries. Rewriting tool descriptions cut task completion time by **40%**. — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Effort heuristics: simple fact-finding uses 1 agent with 3-10 tool calls; comparisons use 2-4 subagents with 10-15 calls each; complex research uses 10+ subagents. Early versions spawned **50 subagents for simple queries**, a cost-blowup failure mode. The initial eval set was only about 20 queries. — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
- Anthropic's stated poor fits: tasks where all agents need the same context, tasks with many inter-agent dependencies, **"most coding tasks"** (fewer truly parallelizable subtasks), low-value tasks (token cost not justified), and real-time coordination between agents. — [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)

**Google Research + MIT, "Towards a Science of Scaling Agent Systems" (Kim et al., arXiv 2512.08296, Dec 2025, revised v2/v3) [ACADEMIC, snippet-verified]**
- Controlled study: 5 architectures (single-agent; multi-agent Independent, Centralized, Decentralized, Hybrid) x 3 LLM families, **180 configurations**. A fitted predictive model picks the best coordination strategy for **87%** of unseen task configurations. — [arXiv abs](https://arxiv.org/abs/2512.08296); [Google Research blog](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)
- Centralized coordination improved performance by **+80.9%** (v1; **80.8%** in v2/v3) over a single agent on parallelizable financial reasoning. Decentralized coordination did best on web navigation. — [arXiv abs v2](https://arxiv.org/abs/2512.08296v2); [MIT Media Lab](https://www.media.mit.edu/projects/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/overview/)
- On strictly sequential planning (PlanCraft), **every multi-agent variant degraded performance by 39-70%**. — [arXiv abs v1](https://arxiv.org/abs/2512.08296v1)
- **Capability saturation:** coordination gives diminishing or negative returns once the single-agent baseline exceeds about **45%** success (regression coefficient -0.408 in v1, -0.404 in v2). — [arXiv](https://arxiv.org/abs/2512.08296v1)
- **Error amplification** (rate at which one agent's error reaches the final output): single-agent 1.0, Independent **17.2x**, Decentralized 7.8x, Hybrid 5.1x, Centralized **4.4x**. The orchestrator acts as a "validation bottleneck." — [arXiv html v1](https://arxiv.org/html/2512.08296v1); [MIT Media Lab](https://www.media.mit.edu/projects/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/overview/)
- I could not read the paper's exact token-overhead or "tool-coordination trade-off" figures (arXiv was unreachable). See Gaps.

**Moonshot Kimi K2.5 Agent Swarm (Jan/Feb 2026) [VENDOR]**
- K2.5 self-directs up to **100 sub-agents** across up to **1,500 tool calls**, with no predefined roles. The behavior was trained with "Parallel-Agent RL" (PARL), which trains only the orchestrator while sub-agents stay frozen. — [Kimi blog](https://www.kimi.com/blog/kimi-k2-5); [K2.5 tech report, arXiv 2602.02276](https://arxiv.org/html/2602.02276)
- Execution time is reduced by **"up to 4.5x"** versus single-agent. The tech report ties this to wide-search scenarios. Hugging Face coverage describes 3-4.5x on suitable tasks. — [Kimi blog](https://www.kimi.com/blog/kimi-k2-5); [Hugging Face blog (mlabonne)](https://huggingface.co/blog/mlabonne/kimik25)
- BrowseComp: **60.6% single-agent to 78.4% with Agent Swarm**. — [NYU Shanghai RITS](https://rits.shanghai.nyu.edu/ai/moonshot-ai-releases-kimi-k2-5-with-agent-swarm-and-frontier-vision/); [Hugging Face](https://huggingface.co/blog/mlabonne/kimik25)
- Important caveat: Qwen3.5 reports **78.6** on BrowseComp with the same "discard-all" context strategy and **no swarm**, so the swarm's attributable quality gain is contested. The speedup claim is more robust than the quality claim. — [Hugging Face](https://huggingface.co/blog/mlabonne/kimik25)
- Status: research preview / beta. No independent reproductions found. — [InfoQ](https://www.infoq.com/news/2026/02/kimi-k25-swarm)

**Cursor long-running parallel agents ("Scaling agents", and "Self-driving codebases", 2026) [VENDOR, snippet-verified]**
- Flat peer coordination via locks failed. **20 agents ran at the effective throughput of 2-3**, with most time spent waiting, and agents held locks too long or forgot to release them. — [Cursor blog: scaling agents](https://cursor.com/blog/scaling-agents)
- A planner/worker hierarchy (planners spawn sub-planners; workers don't talk to each other) ran **hundreds of concurrent workers** on one branch "with minimal conflicts" for **close to a week**. They built a web browser from scratch: **>1M lines of code across ~1,000 files**. No independent verification of the output's quality. — [Cursor blog: scaling agents](https://cursor.com/blog/scaling-agents)
- Drift still occurs. Mitigations: rewrite (not append to) the scratchpad, and periodic fresh restarts. GPT-5.2 is said to be much better at long autonomous work. Cursor says the system is "nowhere near optimal." Cursor's cost and token totals and merge-conflict rates could not be retrieved (cursor.com unreachable). — [Cursor blog: self-driving codebases](https://cursor.com/blog/self-driving-codebases)

**Cognition (Devin) counterargument [VENDOR opinion]**
- "Don't Build Multi-Agents" (Walden Yan, June 12, 2025): rule out architectures that don't share full context and full action traces by default, and prefer a single-threaded linear agent. — [Cognition](https://cognition.ai/blog/dont-build-multi-agents)
- Follow-up, "Multi-Agents: What's Actually Working" (April 22, 2026): the original critique still holds for **parallel-writer swarms**. What works is a narrower class where extra agents contribute intelligence (context lookup, review) while **writes stay single-threaded**. Examples: a Deepwiki context subagent, which "mostly resembles tool calls", and a separate Devin Review agent. — [Cognition](https://cognition.ai/blog/multi-agents-working); [ZenML summary](https://www.zenml.io/llmops-database/multi-agent-systems-in-production-code-generation-and-review-at-scale)
- Nov 2026: "Devin Bots" put agents in charge of teams of Devin agents. No published conflict-handling or performance numbers. — [The New Stack](https://thenewstack.io/cognition-devin-bots-management/)

**OpenAI Codex best-of-N / parallel attempts**
- No primary OpenAI figure was found quantifying the quality gain from Codex best-of-N. See Gaps.

### Inferences
- The positive results (Anthropic, Kimi, Google finance) are all breadth-first information gathering with independent sub-queries. That is the clearest win case for a coordinator fanning out to fleet machines.
- Anthropic's own data suggests the gain is mainly "more tokens spent in parallel within separate context windows". The multiplier to budget for is roughly 3-4x versus a single agent (about 15x versus chat).
- Combining Google's 45% saturation finding with Cognition's stance: as base models get stronger, the marginal value of coordination shrinks for tasks the single agent already handles. Delegation pays mainly for wall-clock time and context-window relief, not quality.

### Gaps
- Exact per-benchmark token-efficiency and overhead tables in Kim et al. (arXiv not reachable).
- Cursor's token/cost totals, conflict rates, and any quality evaluation of the browser output.
- OpenAI's published Codex best-of-N gains. None found in the time available.
- No independent replication of Anthropic's 90.2% or Kimi's 4.5x/78.4%.

## 2. Academic benchmarks: multi-agent, parallel function calling, test-time compute

### Takeaway
Parallel function calling (LLMCompiler) gives reliable latency gains: up to 3.7x versus ReAct at ICML 2024, but only about 1.35x versus native parallel tool calls. Best-of-N and parallel sampling raise the coverage ceiling on SWE-bench substantially, but selection loses several points versus the oracle. Taxonomy studies (MAST) show multi-agent frameworks fail often, frequently because of specification and verification problems rather than model capability.

### Cited Findings
- **LLMCompiler** (Kim et al., ICML 2024) [ACADEMIC]. Up to **3.7x latency speedup**, up to **6.7x cost savings**, and up to **~9% accuracy** gain versus ReAct. These are maxima: HotpotQA 1.80x speed / 3.37x cost; Movie Recommendation 3.74x / 6.73x; ParallelQA 2.27x / 4.65x / +9%. Versus OpenAI's native parallel function calling, only **up to 1.35x** latency gain at similar accuracy. On WebShop, up to 101.7x speedup and +25.7% success versus baselines. — [arXiv 2312.04511](https://arxiv.org/abs/2312.04511); [PMLR v235](https://proceedings.mlr.press/v235/kim24y.html)
- **MAST, "Why Do Multi-Agent LLM Systems Fail?"** (Cemri et al., Berkeley, 2025) [ACADEMIC, snippet-verified]. 14 failure modes in 3 categories: specification issues, inter-agent misalignment, task verification. v3 is built on **1,600+ annotated traces across 7 MAS frameworks**; earlier versions used 5 frameworks / 150+ tasks (v1) and 7 / 200+ (v2). The v3 figure text lists shares of 44.2%, 32.3% and 23.5%; these likely correspond to the 3 categories, but the mapping is unconfirmed. — [arXiv 2503.13657v3](https://arxiv.org/html/2503.13657v3); [Berkeley Sky MAST page](https://sky.cs.berkeley.edu/project/mast/)
- MAST: **ChatDev reaches only 33.33% correctness** on the ProgramDev benchmark. Targeted interventions improved ChatDev by +14% (v1) or +15.6% (v2), still far from reliable. — [Berkeley Sky](https://sky.cs.berkeley.edu/project/mast/); [arXiv v2](https://arxiv.org/html/2503.13657v2)
- **CodeMonkeys** (Stanford, Jan 2025) [ACADEMIC]. Scaling parallel samples of (edit, test) pairs reaches **69.8% coverage** (oracle: any sample correct) on SWE-bench Verified, but only **57.4% resolved** after selection with Claude 3.5 Sonnet. That is a roughly 12-point coverage-versus-selection gap. — [arXiv 2501.14723](https://arxiv.org/html/2501.14723v1); [Stanford blog](https://scalingintelligence.stanford.edu/blogs/codemonkeys)
- Best-of-3 with an LLM verifier on SWE-bench Verified: selection loses **about 6.2 points versus the oracle**. [UNVERIFIED; secondary blog] — [baeseokjae blog](https://baeseokjae.github.io/posts/best-of-n-coding-agents-with-llm-as-verifier/)
- Harness effects swamp many deltas. Claude Opus 4.5 is vendor-reported at **80.9%** on SWE-bench Verified, versus **76.4%** on vals.ai's independent run with mini-SWE-agent. — [Fast Company](https://fastcompany.com/91448280/anthropics-new-claude-opus-4-5-coding); [vals.ai](https://www.vals.ai/benchmarks/swebench-2025-08-27)
- Opus 4.5 used "parallel test-time compute" to beat all human candidates on Anthropic's internal 2-hour performance-engineering exam (not SWE-bench). [VENDOR] — [Fast Company](https://fastcompany.com/91448280/anthropics-new-claude-opus-4-5-coding)

### Inferences
- For a fleet, "best-of-N across machines" is the easiest parallelism to get right, because there is no shared state and no merges. The limit is the verifier: expect a 6-12 point gap between "some machine got it right" and "we picked the right one" unless there are strong tests.
- Gains from parallel tool calls inside one agent (LLMCompiler-style DAG) are cheap and well-measured. They should be exhausted before cross-machine delegation, since native parallel tool calling already captures most of the gain (1.35x residual).

### Gaps
- MultiAgentBench (2025) quantitative results were not retrieved.
- Agentless versus agentic comparisons, and Terminal-Bench 2.0, SWE-bench Pro, GAIA and OSWorld results for multi-agent versus single-agent setups specifically, were not found in the time available. Leaderboards rarely separate the two.
- No standard benchmark reports wall-clock time or throughput alongside accuracy for agent systems. Kimi's 4.5x and Anthropic's "up to 90%" are the main published wall-clock numbers, and both are vendor-reported.

## 3. Distributed execution infrastructure: sandbox start latency, RL rollout scale

### Takeaway
Published sandbox cold-start figures (roughly 25-500 ms) are mostly vendor marketing and inconsistent. Independent measurement is scarce, and resume-from-snapshot measured 0.66-2.3 s. Agentic-RL infrastructure runs **10,000-30,000+ concurrent sandboxes**. Recent work shows that execution overhead (the "rollout infrastructure tax") is a first-order cost, with up to 66.9% reduction from substrate tuning.

### Cited Findings
- Sandbox start latency (largely [VENDOR] via comparison blogs, inconsistent):
  - **Daytona**: sub-90 ms, 27 ms "optimized". — [StartupHub](https://www.startuphub.ai/ai-news/artificial-intelligence/2026/daytona-vs-e2b-vs-modal-vs-vercel-sandbox-2026)
  - **E2B**: about 150 ms ([superagent](https://www.superagent.sh/blog/ai-code-sandbox-benchmark-2026)) versus 300-500 ms for a fresh microVM ([Novita, July 2026](https://blogs.novita.ai/best-ai-agent-sandboxes-2026/)).
  - **Modal**: "sub-second" ([superagent](https://www.superagent.sh/blog/ai-code-sandbox-benchmark-2026)), about 400 ms ([Morph](https://www.morphllm.com/comparisons/daytona-alternative)), or under 90 ms with snapshots ([Novita](https://blogs.novita.ai/best-ai-agent-sandboxes-2026/)). These conflict.
  - **Blaxel**: about 25 ms. — [superagent](https://www.superagent.sh/blog/ai-code-sandbox-benchmark-2026)
- Fly.io notes that **none of E2B, Modal, Daytona or Sprites publishes p50/p99 start latency**. Isolation differs: E2B and Sprites use Firecracker microVMs, Modal uses gVisor, Daytona uses containers by default. — [Fly.io](https://fly.io/learn/sprites-vs-e2b-vs-modal-vs-daytona/)
- [INDEPENDENT-ish] LogRocket measured **resume** (not cold start): **E2B 662 ms, Modal snapshot boot 2,347 ms**. — [LogRocket](https://blog.logrocket.com/comparing-ai-agent-sandbox-platforms-e2b-modal-daytona-and-more/)
- RL rollout scale:
  - **Mistral AI runs 30,000+ sandboxes on a single GKE cluster**. Per-task container images (e.g. one per SWE-bench repository) strain the control plane during rollout bursts. — [Google Cloud blog](https://cloud.google.com/blog/products/containers-kubernetes/accelerate-agentic-rl-with-gke-agent-sandbox)
  - A production agentic-RL stack needs "thousands of concurrent, stateful, sandboxed executions per optimizer step". Provisioning cost is dominated by image economics and lifecycle, not isolation technology. — [NeurIPS 2026: RL Environments are an Infrastructure Problem](https://neurips.cc/virtual/2026/166780)
  - **Sandman** (Amazon-operated sandbox service): **3.1M sandboxes created over two weeks across 122 training runs**. [snippet-verified] — [arXiv 2610.39711](https://arxiv.org/pdf/2610.39711)
  - A coding-agent RL paper cites **10,000+ concurrent sandboxes and 25,000+ prebuilt Docker images**. [snippet-verified] — [arXiv 2604.05013](https://arxiv.org/pdf/2604.05013)
  - Alibaba's ROCK/ROME scales to "tens of thousands" of simultaneous environments. [snippet-verified] — [arXiv 2512.24873](https://arxiv.org/pdf/2512.24873)
- "Rollout infrastructure tax" (arXiv 2607.01415, a Daytona-associated study). It defines execution-system latency in four parts: environment creation, readiness before the first action, per-action cost, and orchestration. Fixed startup costs dominate short rollouts and per-action overhead dominates long ones, so substrate rankings flip with trajectory length. — [arXiv 2607.01415](https://arxiv.org/abs/2607.01415); [Daytona blog (VENDOR)](https://www.daytona.io/dotfiles/the-hidden-infrastructure-tax-in-coding-agent-rl)
- Nebius (Terminal-Bench workload): routing, sandbox-execution and batch-assembly changes cut collection time for a 256-trajectory batch by **66.9%**. [snippet-verified, secondary] — via [search summary citing Nebius]; related: [SemiAnalysis](https://newsletter.semianalysis.com/p/rl-systems-mind-the-gap-matching)

### Inferences
- For Nekko's fleet, startup cost is a cold start on the user's own machine: waking it, syncing the repo, warming the model. That is likely seconds to minutes, not tens of milliseconds. Delegation only pays when a subtask's runtime is much larger than that dispatch overhead.
- The RL "short versus long trajectory" finding transfers directly. Short subtasks are dominated by fixed setup cost, so they should stay local.

### Gaps
- No independent, methodology-disclosed p50/p99 cold-start benchmark across sandbox vendors (superagent.sh's benchmark was unreachable, so its methodology is unknown).
- No per-lab concurrent-sandbox figures for DeepSWE, Kimi K2 or MiniMax M2 training.

## 4. When parallelism hurts: coordination overhead, context loss, merge conflicts, error compounding, cost

### Takeaway
The quantified harms are large. Sequential tasks lose 39-70% (Google/MIT). Independent agents amplify errors 17.2x, versus 4.4x with a central verifier. Flat lock-based coordination yields about 10-15% of nominal throughput (Cursor's 20 agents doing the work of 2-3). Cross-agent PR pairs conflict about 42% of the time (unverified). On small tasks, fan-out roughly doubles tokens for no wall-clock gain.

### Cited Findings
- Sequential reasoning tasks: all multi-agent variants were **39-70% worse** than single-agent (PlanCraft). — [arXiv 2512.08296v1](https://arxiv.org/abs/2512.08296v1)
- Error compounding: **17.2x** (independent) versus **4.4x** (centralized). — [arXiv html](https://arxiv.org/html/2512.08296v1)
- Coordination overhead: Cursor's lock-based flat setup gave **20 agents the throughput of 2-3**. [VENDOR] — [Cursor](https://cursor.com/blog/scaling-agents)
- Cost blowup: Anthropic's early system spawned **50 subagents for simple queries**, and multi-agent runs use about 15x chat tokens. [VENDOR] — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- Merge conflicts: an analysis of **33,596 PRs** reports a **41.7%** textual-conflict rate for cross-agent PR pairs versus **19.8%** for same-agent pairs. [UNVERIFIED; blog analysis, wasted-cost figures are estimates] — [D. Vaughan blog](https://codex.danielvaughan.com/2026/07/28/agent-pr-merge-conflicts-concurrent-coding-agents-codex-cli-worktree-isolation-coordination-defence/)
- NP-Bench (arXiv 2610.07261): a scheduling planner raised clean-integration success from **1/9 to 9/9** scenarios and cut merge conflicts from **13 to 0**. These are scripted scenarios with a small n. [snippet-verified] — [arXiv 2610.07261](https://arxiv.org/abs/2610.07261)
- An empirical study of coordination modes in from-scratch multi-agent coding found that topology alone shifts scores by **>30 points** and can **double wall-clock time**. [snippet-verified] — [arXiv 2607.27877](https://arxiv.org/pdf/2607.27877)
- Small-task anecdote: a 2-agent split on tiny edits took 5 s versus 6 s solo, with the token bill nearly doubled. A larger LogRocket task went from about 30 min to about 16 min in parallel, at higher token use. [INDEPENDENT but n=1] — [DevDojo](https://devdojo.academy/en/blog/parallel-coding-agents-what-breaks-at-merge); [LogRocket](https://blog.logrocket.com/splitting-across-ai-agents/)
- A claim that "Agent Teams" halved wall-clock time while cutting tokens about 70% surfaced in search without a clear primary source. [UNVERIFIED, likely unreliable; not recommended for citation]
- Several 2026 parallel-coding papers explicitly do **not** measure real provider-level wall-clock speedup, using logical critical-path estimates instead (e.g. Claim Plane, arXiv 2608.00947). — [arXiv 2608.00947](https://arxiv.org/pdf/2608.00947)
- Context loss: Cognition's core argument is that subagents without the full trace make conflicting implicit decisions. Its 2026 position: parallel *readers* are fine, parallel *writers* are not. [VENDOR opinion] — [Cognition 2025](https://cognition.ai/blog/dont-build-multi-agents); [Cognition 2026](https://cognition.ai/blog/multi-agents-working)
- Resource contention on a single consumer GPU: greedy allocation severely starves lightweight concurrent apps (ConsumerBench). [ACADEMIC] — [arXiv 2506.17538](https://arxiv.org/html/2506.17538v1)

### Inferences
- A rough empirical rule from these sources: parallelize when subtasks are read-mostly or separable, the single-agent success rate is below about 45%, each subtask is long relative to dispatch overhead, and a central coordinator verifies results. Avoid parallel writers to the same files unless there is explicit conflict-aware scheduling.
- Expect cost multipliers of about 2x (small coding fan-outs) to about 3-4x (Anthropic research versus single agent). The cost to a fleet user is mostly electricity and time rather than API spend if inference is local. Cloud-model subagents still incur token cost.

### Gaps
- No large-scale, controlled benchmark measures merge-conflict rates and rework cost for parallel coding agents; the 2026 work is small-n preprints or blog analyses.
- No quantified "context loss" metric (e.g. information-transfer fidelity between coordinator and subagent) was found.

## 5. Heterogeneous local machines (consumer GPUs/Macs) running agent sub-tasks

### Takeaway
No benchmark was found that measures distributing agent subtasks across a heterogeneous fleet of consumer machines. The closest material covers single-node agentic throughput on consumer hardware and single-GPU contention. Nekko would have to build its own harness.

### Cited Findings
- **AA-AgentPerf-Local** (Artificial Analysis, Sept 29, 2026): an open tool for benchmarking agentic performance on a user's own OpenAI-compatible local inference server. A plausible per-node baseline; multi-device support is unconfirmed. — [Artificial Analysis](https://artificialanalysis.ai/es/articles/aa-agentperf-local)
- **ConsumerBench** (arXiv 2506.17538): concurrent GenAI apps on one consumer GPU; greedy GPU allocation starves lightweight apps. — [arXiv](https://arxiv.org/html/2506.17538v1)
- A consumer Blackwell study (RTX 5060 Ti / 5070 Ti / 5090, agentic multi-LoRA workload, Jan 2026) found that budget GPUs give the best throughput per dollar for API-style workloads. — [arXiv 2601.09527](https://arxiv.org/html/2601.09527v1)
- Decode at batch size 1 is memory-bandwidth-bound. Device rankings flip by model (one user saw an AMD GPU beat an M2 Pro by 80% on Llama 3.1 8B, 20.9 vs 11.6 tok/s, but lose on Phi-3 mini). [Anecdotal] — [DEV Community](https://dev.to/newtorob/an-amd-gpu-beat-my-mac-on-llama-8b-the-same-gpu-lost-on-phi-3-233c); [arXiv 2603.23640](https://arxiv.org/html/2603.23640v1)
- "Silicon Showdown" (arXiv 2605.00519) argues tokens/s alone is insufficient for consumer inference and proposes measuring deployment friction too. — [arXiv 2605.00519](https://arxiv.org/html/2605.00519v1)

### Inferences
- In a heterogeneous fleet, the slowest node sets the critical path for a fan-out (straggler effect), and per-model device rankings flip. The coordinator should schedule using measured per-node tokens/s for the specific model, not hardware class.
- Because single-agent decode is bandwidth-bound at batch 1, running N subagents on *different* machines gives near-linear aggregate throughput. Running them on the *same* machine shares bandwidth: batching helps throughput but slows each subagent. That favors cross-machine fan-out for local models more than for cloud APIs.

### Gaps
- No published benchmark of distributed agent execution across consumer machines (scheduling efficiency, straggler impact, network and repo-sync overhead).
- No data on LAN or WAN dispatch overhead for agent subtasks between personal machines.
