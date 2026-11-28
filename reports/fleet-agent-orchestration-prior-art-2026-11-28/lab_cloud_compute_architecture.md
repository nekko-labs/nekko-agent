# How Anthropic and OpenAI cloud agents actually allocate compute (testing the "distributed across VMs by capacity" assumption)

Research date: 2026-11-28. Notes separate (a) official documentation, (b) credible third-party reverse engineering, (c) first-hand observation of the cloud session these notes were written in (itself a Claude Code cloud session), and (d) inference. Several hosts (developers.openai.com, simonwillison.net, cw00h.github.io) were blocked from direct fetch in this session, so claims from those pages rest on search-result summaries and are flagged.

## 1. Anthropic agent harness and sandboxes: where does the agent loop run, and on what isolation tech?

### Takeaway
Anthropic's own engineering writing describes a deliberate split: a stateless "brain" (harness loop that calls Claude) running outside the sandbox, a disposable "hands" sandbox (container/VM) provisioned only when a tool needs it, and a durable session event log stored separately. Sandboxes are small CPU-only Linux VMs/containers; the model is never in the sandbox; it is called over the network API.

### Cited Findings
**Claude Managed Agents (official, "Scaling Managed Agents: Decoupling the brain from the hands", Anthropic Engineering, 2026-04-08)**
- The system has three virtualized components: the session (append-only event log), the harness ("brain", the loop that calls Claude and routes tool calls), and the sandbox ("hands", where code runs and files are edited); each can be swapped independently — [Anthropic Engineering](https://www.anthropic.com/engineering/managed-agents)
- The first version put everything in one container; if the container failed the session was lost. In the redesign "the harness leaves the container" and reaches the sandbox only via a generic `execute(name, input) → string` tool interface — [Anthropic Engineering](https://www.anthropic.com/engineering/managed-agents)
- Containers are provisioned on demand via `provision({resources})`, only when a session needs one; a failed container is disposable and Claude can retry on a fresh one ("The container became cattle") — [Anthropic Engineering](https://www.anthropic.com/engineering/managed-agents)
- The harness is stateless: crash recovery uses `wake(sessionId)` / `getSession(id)` and resumes from the last event; "Scaling to many brains just meant starting many stateless harnesses, and connecting them to hands only if needed." — [Anthropic Engineering](https://www.anthropic.com/engineering/managed-agents)
- "Many hands": every hand is a tool with the same interface, so the harness does not care if it is a container, a phone, or an emulator; "Brains can pass hands to one another." — [Anthropic Engineering](https://www.anthropic.com/engineering/managed-agents)
- Decoupling cut latency: "Our p50 TTFT dropped roughly 60% and p95 dropped over 90%" because inference no longer waits for container setup — [Anthropic Engineering](https://www.anthropic.com/engineering/managed-agents)
- Credentials stay out of sandboxes: git tokens are wired into the remote at init; MCP OAuth tokens live in a vault and a proxy calls external services; "The harness is never made aware of any credentials." — [Anthropic Engineering](https://www.anthropic.com/engineering/managed-agents)
- By default Managed Agents run tools in Anthropic-managed cloud sandboxes; a self-hosted sandbox option exists, and third-party sandbox providers (Cloudflare, Daytona, Modal, Vercel) can supply the "hands" — [Claude blog: self-hosted sandboxes and MCP tunnels](https://claude.com/resources/articles/claude-managed-agents-updates); [Claude Platform docs](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes); [Cloudflare docs](https://developers.cloudflare.com/sandbox/coding-agents/claude-managed-agents/)
- Cloudflare's integration gives each session its own sandbox, applies egress policy, saves sandbox state while the session sleeps and shuts it down at session end — [Cloudflare docs](https://developers.cloudflare.com/sandbox/coding-agents/claude-managed-agents/)

**Claude Code on the web / cloud sessions (official)**
- Each Claude Code on the web session runs in an isolated cloud sandbox on Anthropic-managed infrastructure; every cloud session runs in a "cloud environment" config that controls network access, env vars and setup scripts — [code.claude.com cloud environments](https://code.claude.com/docs/en/cloud-environments.md); [code.claude.com Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web)
- Credentials (git, signing keys) are kept outside the sandbox; a custom git proxy validates a scoped credential and operation (e.g. push only to the configured branch) before attaching the real token — [Anthropic Engineering, "Claude Code sandboxing", 2025-10-20](https://www.anthropic.com/engineering/claude-code-sandboxing)

**Open-source sandbox-runtime (official, 2025-10-20)**
- A research-preview runtime that restricts filesystem and network without a container, built on Linux bubblewrap and macOS seatbelt; network goes through a Unix-socket proxy outside the sandbox that enforces a domain allowlist; internally it "safely reduces permission prompts by 84%" — [Anthropic Engineering](https://www.anthropic.com/engineering/claude-code-sandboxing)

**Isolation technology (third-party and first-hand)**
- An October 2025 reverse-engineering write-up of Claude Code on the web reported gVisor messages in `dmesg`, a VM underneath, and a PID 1 binary called `process_api` (observational, not documented by Anthropic; page not directly fetchable here, summary via search) — [cw00h blog](https://cw00h.github.io/posts/2025/10/claude-code-web-sandbox)
- A third-party overview claims gVisor + seccomp, ~7 GB image, 4 GB memory limit (UNVERIFIED) — [quochuydev overview](https://quochuydev.github.io/tech-research/researching/claude-code-web-overview.html)
- Simon Willison (Jan 2026) notes Claude.ai's code execution uses gVisor and was built around Bash rather than only Python (via search summary) — [Simon Willison](https://simonwillison.net/2026/Jan/26/chatgpt-containers)
- FIRST-HAND OBSERVATION (2026-11-28, inside the Claude Code cloud session that produced these notes; one sample, not a documented spec): kernel `6.18.44-fc-v880` built by `builder@sandboxing`; kernel cmdline `rdinit=/process_api -- --firecracker-init --control-vsock-port 5001 ...`; PID 1 is `/process_api --firecracker-init`; hostname `vm`; 4 vCPU (Intel Xeon 2.30 GHz), ~15 GB RAM, 252 GB virtio disk; no GPU (`nvidia-smi` absent); all outbound HTTPS via a local proxy at 127.0.0.1 with a custom CA, while `api.anthropic.com` and package registries are listed in `NO_PROXY`. This indicates the session ran as a Firecracker microVM controlled over vsock, and that inference is a remote API call, not local. (Source: `uname -a`, `dmesg`, `/proc/1/cmdline`, `env` in this session.)

### Inferences
- Isolation tech appears to have moved (or varies by product): gVisor reported in late 2025 / early 2026 write-ups; Firecracker microVM observed in this Nov 2026 session. Both are "cheap CPU sandbox" tech. Treat the exact runtime as product- and date-dependent.
- The harness for Claude Code on the web observably runs inside the sandbox VM (the CLI runs there and calls `api.anthropic.com`), whereas Managed Agents explicitly moved the harness out of the container. So Anthropic runs both patterns.

### Gaps
- No official Anthropic statement on which orchestrator (Kubernetes, custom) schedules sandboxes onto hosts, bin-packing policy, or per-session resource quotas.
- No official doc found naming gVisor or Firecracker; both are from observation.
- Did not retrieve official docs for the API code execution tool and computer use environment specs in this pass.

## 2. Anthropic inference: hardware, routing, tiers, regions, compute deals

### Takeaway
Inference is a separate, centralized, multi-accelerator fleet (Google TPU, AWS Trainium, NVIDIA GPU) behind load balancers that route by request properties (e.g. context-window size) with sticky routing. Capacity is managed via product tiers (Priority Tier, Batch), geography controls (`inference_geo`), and huge long-term compute contracts, not by spinning up agent VMs.

### Cited Findings
- Claude is served via the first-party API, Amazon Bedrock and Google Vertex AI across AWS Trainium, NVIDIA GPUs and Google TPUs; "Our aim is that users should get the same quality responses regardless of which platform serves their request." and "We never reduce model quality due to demand, time of day, or server load." — [Anthropic postmortem, Sep 2025](https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues)
- Bug 1 (context-window routing): from 2025-08-05 some Sonnet 4 requests were misrouted to servers configured for the upcoming 1M-token context window (0.8% initially); a 2025-08-29 load-balancing change raised this to 16% of Sonnet 4 requests at the worst hour (Aug 31); ~30% of Claude Code users had at least one misrouted message — [Anthropic postmortem](https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues)
- Routing is "sticky": once a request hit the wrong server pool, follow-ups were likely to go to the same server — [Anthropic postmortem](https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues)
- Bedrock misrouting peaked at 0.18% of Sonnet 4 requests; Vertex AI <0.0004%; fix deployed Sep 4, fully rolled out by Sep 16 (1P, Vertex) and Sep 18 (Bedrock) — [Anthropic postmortem](https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues)
- Bug 2: a 2025-08-25 misconfiguration on Claude API TPU servers corrupted token generation (e.g. Thai/Chinese characters in English answers); third-party platforms unaffected — [Anthropic postmortem](https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues)
- Bug 3: an approximate top-k sampling change exposed a latent XLA:TPU compiler miscompilation (Haiku 3.5 confirmed); fixed by switching to exact top-k with higher precision at a minor efficiency cost — [Anthropic postmortem](https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues); [InfoQ](https://www.infoq.com/news/2025/10/anthropic-infrastructure-bugs)
- Google TPU expansion announced 2025-10-23: "tens of billions of dollars", "well over a gigawatt of capacity" expected online in 2026; Anthropic describes a diversified approach across TPUs, Trainium and NVIDIA GPUs — [Anthropic news](https://anthropic.com/news/expanding-our-use-of-google-cloud-tpus-and-services); [Tom's Hardware](https://www.tomshardware.com/tech-industry/artificial-intelligence/anthropic-signs-deal-with-google-cloud-to-expand-tpu-chip-capacity-ai-company-expects-to-have-over-1gw-of-processing-power-in-2026); [The Register](https://www.theregister.com/2025/10/23/google_anthropic_deal/)
- Project Rainier (AWS): ~500,000 Trainium2 chips across seven buildings at New Carlisle, Indiana as of Oct 2025 (first phase complete), with a projection of >1M Trainium2 chips for Anthropic training and inference; built from UltraServers (4 servers × 16 Trainium2 chips) and spans sites in Indiana, Mississippi and Pennsylvania — [About Amazon](https://aboutamazon.com/news/aws/aws-project-rainier-ai-trainium-chips-compute-cluster/); [SiliconANGLE](https://siliconangle.com/2025/10/29/aws-opens-11b-project-rainier-data-center-campus-built-anthropic/); [The Register](https://www.theregister.com/2025/07/04/project_rainier_deep_dive/)
- `inference_geo`: `"global"` (default, inference may run in any geography "for optimal performance and availability") or `"us"` (US-only infrastructure); supported per request including in the Batch API; US-only inference carries a 1.1x multiplier (and per translated docs, deducts 1.1 tokens per token from committed Priority Tier TPM); partner platforms (Bedrock, Google Cloud) price regions themselves — [Claude Platform docs: data residency](https://platform.claude.com/docs/en/manage-claude/data-residency); [Italian version](https://platform.claude.com/docs/it/manage-claude/data-residency)

### Inferences
- The context-window bug proves Anthropic runs separate server pools specialised by configuration (e.g. 1M-context vs standard), with a load balancer that classifies requests and pins sessions. Sticky routing is consistent with prompt-cache / KV-cache affinity, though the postmortem does not state the reason for stickiness.
- Platform-specific bugs (TPU-only) show the same model runs on different compiled stacks per accelerator; routing chooses among heterogeneous hardware.

### Gaps
- An Anthropic–Microsoft–NVIDIA compute deal (reported Nov 2025: Azure compute commitment, NVIDIA and Microsoft investment) was NOT confirmed by searches in this pass; treat as UNVERIFIED here. No 2026-dated Anthropic compute announcements were retrieved.
- Anthropic does not publicly describe its serving stack (batching, disaggregation, KV-routing). English Priority Tier page not retrieved.

## 3. OpenAI: Codex cloud, ChatGPT containers, Kubernetes, service tiers, prompt-cache routing

### Takeaway
OpenAI's pattern matches Anthropic's: one isolated container per task for tools, network off by default behind an egress proxy, cached container snapshots to amortize setup; inference is a separate fleet with explicit service tiers (Standard, Flex, Priority/"Fast", Batch) and prefix-hash routing for prompt caching.

### Cited Findings
- Codex launched 2025-05-16 as "a cloud-based software engineering agent that can work on many tasks in parallel"; "each task runs in its own cloud sandbox environment, preloaded with your repository", "processed independently in a separate, isolated environment" — [OpenAI, Introducing Codex](https://openai.com/index/introducing-codex/)
- Codex cloud environments: setup script runs with network access, then control passes to the agent; agent internet access is off by default and can be enabled fully or per domain/HTTP-method allowlist; all outbound traffic goes via an HTTP/HTTPS proxy — [OpenAI Codex docs: cloud environments](https://developers.openai.com/codex/cloud/environments); [Agent internet access](https://developers.openai.com/codex/cloud/agent-internet) (via search summary; direct fetch blocked)
- Container caching: Codex keeps the post-setup container state; resumed caches check out the task branch and may run a maintenance script; changing setup/maintenance scripts, env vars or secrets invalidates the cache; for Business/Enterprise caches are shared across users with access to the environment — [OpenAI Codex docs](https://developers.openai.com/codex/cloud/environments) (via search summary). A 12-hour cache lifetime appears only on a third-party page (UNVERIFIED) — [wikidocs](https://wikidocs.net/365639)
- No source found stating whether Codex sandboxes are containers, gVisor or microVMs; OpenAI says only "isolated environment" — [OpenAI, Introducing Codex](https://openai.com/index/introducing-codex/)
- ChatGPT containers (descendant of Code Interpreter) can run bash, pip/npm install and download files; general outbound internet from user code is blocked while pip/npm hit curated internal registry proxies and a privileged `container.download` fetcher handles public URLs (Simon Willison, 2026-01-26, via search summary) — [Simon Willison](https://simonwillison.net/2026/Jan/26/chatgpt-containers)
- A third-party write-up saw "Starting gVisor" in `dmesg` inside the ChatGPT container (observational) — [pncnmnp blog](https://pncnmnp.github.io/blogs/chatgpt-containers.html)
- OpenAI "Scaling Kubernetes to 7,500 nodes" (2021-01-25): research/training clusters for GPT-3, CLIP, DALL·E; many workloads take an entire node per pod for GPU-to-GPU bandwidth; low-priority "balloon" pods keep the autoscaler from removing idle nodes; up to 70 GB heap per API server — [OpenAI](https://openai.com/index/scaling-kubernetes-to-7500-nodes/). Note: this is about training/research clusters, not ChatGPT/Codex sandbox scheduling.
- Service tiers: `service_tier: "flex"` trades slower responses and more timeouts for lower cost (beta, limited models); Priority processing was renamed "Fast mode" on 2026-07-30 (`service_tier: "priority"` or `"fast"`) at a per-token premium — [OpenAI Flex docs](https://developers.openai.com/api/docs/guides/flex-processing); [OpenAI Priority/Fast docs](https://developers.openai.com/api/docs/guides/priority-processing); [OpenAI Fast mode page](https://openai.com/api-priority-processing/)
- Prompt caching routing (official): requests are routed to a machine based on `prompt_cache_key`, with a hash of the initial prompt prefix as secondary key; a cache hit needs a shared prefix AND the same machine; on by default for prompts ≥1,024 tokens — [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching); [OpenAI Cookbook, Prompt Caching 201](https://developers.openai.com/cookbook/examples/prompt_caching_201)
- Azure: beyond ~15 requests/minute for the same prefix+key combination, some requests overflow to other machines and miss the cache — [Microsoft Learn](https://learn.microsoft.com/azure/foundry/openai/how-to/prompt-caching)

### Inferences
- The ~15 RPM overflow rule reveals prefix-affinity routing with a per-machine load cap: route to the cache-holding replica until it is "hot", then spill to others. This is exactly KV-cache-aware routing, confirmed indirectly by docs.
- Service tiers are a queue-priority mechanism on a shared GPU fleet (Flex = preemptible/low priority, Fast = high priority), the inference-side analogue of capacity management.

### Gaps
- Not retrieved this pass: ChatGPT agent / Operator virtual-computer architecture, Responses API background mode, Batch API details, Scale Tier (search returned nothing current), Stargate/Azure capacity numbers.
- No OpenAI engineering post found describing how Codex/ChatGPT sandboxes are scheduled onto hosts.

## 4. Industry-standard serving patterns: what is confirmed vs assumed

### Takeaway
The labs confirm only a few serving mechanics publicly: prefix-affinity (sticky) routing for prompt caching, specialised server pools per configuration, heterogeneous accelerators, and priority/flex/batch tiers. Continuous batching and prefill/decode disaggregation are near-universal in open serving stacks but are not confirmed in lab docs found here.

### Cited Findings
- OpenAI confirms machine-level routing by prefix hash / `prompt_cache_key` — [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
- Anthropic confirms sticky routing and pools keyed by context-window configuration — [Anthropic postmortem](https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues)
- Anthropic's global `inference_geo` default lets requests run in "any available geography for optimal performance and availability" (i.e. cross-region load balancing) — [Claude Platform docs](https://platform.claude.com/docs/en/manage-claude/data-residency)

### Inferences
- Continuous batching, prefill/decode disaggregation and autoscaling are UNCONFIRMED for these labs from primary sources in this pass; they are reasonable assumptions but should be labelled as such.

### Gaps
- No primary lab source retrieved on batching or disaggregation.

## 5. Verdict on the founder's assumption, and fan-out of sub-agents

### Takeaway
Partly right on the tool side, wrong on the model side. The "agent" is not one thing distributed across VMs by capacity. What is distributed is many small, isolated, CPU-only sandboxes (one per session/task), scheduled like disposable cattle; what is centralized is a shared accelerator inference fleet that every sandbox or harness calls over HTTPS, where capacity is managed by routing, priority tiers, batch, regions and long-term chip contracts. Fan-out is primarily "many parallel inference calls"; parallel sandboxes happen at the task level (Codex tasks, separate cloud sessions), not usually per sub-agent.

### Cited Findings
- Harness and sandbox are separable; harnesses scale as stateless processes and attach sandboxes only if needed — [Anthropic Engineering](https://www.anthropic.com/engineering/managed-agents)
- Codex parallelism = separate isolated environment per task — [OpenAI, Introducing Codex](https://openai.com/index/introducing-codex/)
- Brains can share and pass hands (sandboxes) among each other — [Anthropic Engineering](https://www.anthropic.com/engineering/managed-agents)
- First-hand: the cloud sandbox has no GPU and reaches inference at `api.anthropic.com` (this session's environment).

### Inferences
- Sub-agents in Claude Code (Task tool) run inside the same session/sandbox, each with its own context window, making parallel API calls; this is from general product knowledge, NOT verified against docs in this pass. Managed Agents' "brains pass hands" design implies sub-agents can share one sandbox or get separate ones as needed.
- Translation to a home fleet (where inference and tools share machines): (1) separate the durable session log from the harness so any machine can resume a task (Anthropic's `wake(sessionId)` pattern); (2) treat tool sandboxes as disposable and provision lazily; (3) keep credentials in a proxy/vault outside sandboxes; (4) route inference by cache affinity (send follow-ups of a conversation to the machine already holding its KV cache/prefix) with spillover when hot; (5) route by capability (models/context sizes loaded on each machine, like Anthropic's context-window pools) rather than raw free capacity; (6) offer priority vs background (flex/batch) queues. The key difference: labs put inference on dedicated accelerators far from cheap sandboxes; on a home fleet the GPU box is both, so placement must co-optimize model-loaded/cache-warm machines with where files and tools live.

### Gaps
- No lab source on how sessions are placed onto physical hosts (bin-packing, overcommit, warm pools), beyond Codex container caching and Anthropic lazy provisioning.
