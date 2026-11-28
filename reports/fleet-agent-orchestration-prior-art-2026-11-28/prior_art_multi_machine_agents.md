# Prior art: one agent's work delegated to many machines (fleet orchestration)

Research date: 2026-11-28. Method: web search (search-result snippets) plus direct fetch where the network allowed. **Caveat on sourcing:** cursor.com, snowan.gitbook.io and everydev.ai could not be fetched from this session (blocked by DNS/network policy), so Cursor claims come from search snippets of the cursor.com posts and secondary write-ups, not from reading the posts in full. Anthropic's C-compiler post was fetched and read directly. Most other items rest on search snippets of primary pages; secondary-only claims are flagged.

---

## 1. Commercial products that fan out one job to many cloud machines: what is parallelized and how results merge

### Takeaway
Multi-machine fan-out is now routine in commercial coding and research agents (Cursor, Anthropic, OpenAI Codex, GitHub, Manus, Moonshot Kimi, Cognition), but they split into three architectures: (a) **one isolated VM/container per task, merged by a human via branch/PR** (Codex cloud, Copilot coding agent / Agent HQ, Cursor cloud agents); (b) **a coordinator fanning out read-only/research subagents and synthesizing their text** (Anthropic Research, Manus Wide Research, Kimi Agent Swarm, Claude Managed Agents multiagent); (c) **many writer agents on one shared git repo** (Cursor's planner/worker experiments, Anthropic's 16-agent C compiler). Type (c) works, but only with strong test oracles and task partitioning. Cognition still warns against parallel writers in 2026. None of the big vendors publishes a product that places subtasks on a *user's own heterogeneous machines*. Their fleets are homogeneous vendor-cloud sandboxes.

### Cited Findings

**Cursor: "Scaling long-running autonomous coding" (Jan 2026, Wilson Lin) and "Towards self-driving codebases"**
- Cursor first tried a flat structure of peer agents, and it failed. Agents avoided hard problems and made small, safe edits, no agent took responsibility for end-to-end work, and work "churn[ed] for long periods of time without progress." — [Cursor blog (via search snippet)](https://cursor.com/blog/scaling-agents)
- Dynamic coordination and locking mechanisms were tried first and failed because of bottlenecks and brittleness. — [Cursor blog (snippet)](https://cursor.com/blog/scaling-agents); [ZenML LLMOps summary](https://www.zenml.io/llmops-database/scaling-multi-agent-autonomous-coding-systems)
- The final design had three roles. **Planners** continuously explore the codebase and create tasks, and they can spawn sub-planners, so planning is "parallel and recursive." **Workers** pick up tasks and drive them to completion; they "don't communicate with any other planners or workers" and are unaware of the larger system. A **judge** agent decides at the end of each cycle whether to continue, and the next iteration "starts fresh" to fight drift and tunnel vision. — [Cursor blog (snippet)](https://cursor.com/blog/scaling-agents)
- Scale and result: hundreds of workers ran concurrently, pushing to the **same Git branch** with "minimal merge conflicts." A from-scratch browser project produced about 1,000 files and over 1M lines of code in roughly a week. Cursor also found that different models excel at different roles (planner vs. worker). — [Cursor blog (snippet)](https://cursor.com/blog/scaling-agents); [Gigazine coverage, 2026-01-20](https://gigazine.net/gsc_news/en/20260120-cursor-scaling-agents)
- Follow-up post "Towards self-driving codebases": an executor "could spawn tasks for workers, which provided linear scaling and throughput." In February 2026, Cursor framed long-running agents as an early milestone toward self-driving codebases. — [Cursor blog (snippet)](https://cursor.com/blog/self-driving-codebases); [Cursor long-running agents (snippet)](https://cursor.com/blog/long-running-agents)
- *Unverified:* the snippets do not say whether the hundreds of workers ran on one large machine or on many VMs. I could not fetch the post to check.

**Cursor cloud agents (product, 2025-2026)**
- Each cloud agent gets an **isolated VM**, so users can run many in parallel ("10 or 20 of these things running, rather than one to three," per Cursor's Alexi Robbins). — [Cursor talk at Code with Claude, "Giving coding agents their own computers"](https://claude.com/code-with-claude/session/sf-giving-coding-agents-their-own-computers-how-cursor-built-cloud-agents); [DEV summary](https://dev.to/ytosko/cursor-introduces-cloud-agents-with-isolated-vms-to-control-their-own-computersin-parallel-576a)
- The cloud harness has a dedicated computer-use **subagent type** with its own model routing and prompting. VNC and Chrome run in an environment shared between parent and subagent. — [Cursor blog: agent computer use (snippet)](https://cursor.com/blog/agent-computer-use)
- In Cursor 3.7, `/in-cloud` from the local desktop app spins up a cloud subagent "on its own VM and branch, so your local workspace stays clean." This is a hybrid local-coordinator / cloud-worker pattern and the closest commercial analog to Nekko's local-first plus fleet design. — [Cursor changelog 3.7 (snippet)](https://cursor.com/changelog/cloud-in-agents-window)
- The VM "can be fully onboarded with your repo, dependencies, tooling, and setup scripts." The launch is dated Feb 24, 2026, with a "Third Era" follow-up on Mar 6, 2026. — [Cursor docs (snippet)](https://cursor.com/docs/cloud-agents); [Latent Space write-up](https://latent.space/reading/cursor-third-era-cloud-agents/)

**Anthropic: "Building a C compiler with a team of parallel Claudes" (2026-02-05, Nicholas Carlini), read in full**
- 16 Claude Opus 4.6 agents, each in its **own Docker container** with no prior context. A bare git repo was mounted at `/upstream`. Each agent cloned it to `/workspace` and pushed back when done. — [Anthropic engineering](https://www.anthropic.com/engineering/building-c-compiler)
- **Task claiming:** an agent wrote a lock file such as `current_tasks/parse_if_statement.txt`. Git's push synchronization meant that the second of two agents claiming the same task had to pick another. Agents pulled and merged upstream before pushing, then removed their lock. Merge conflicts were "frequent" and Claude resolved them itself. — [Anthropic engineering](https://www.anthropic.com/engineering/building-c-compiler)
- **No orchestrator**, no goal manager, and no inter-agent channel beyond git. Each agent picked the "next most obvious" problem. — [Anthropic engineering](https://www.anthropic.com/engineering/building-c-compiler)
- Scale and cost: about 2,000 Claude Code sessions over about 2 weeks, just under $20,000 in API cost, and about 2B input and 140M output tokens. The output was a roughly 100k-line Rust C compiler that builds Linux 6.9 on x86, ARM and RISC-V, plus QEMU, FFmpeg, SQLite, Postgres and Redis, and passes about 99% of most test suites including the GCC torture tests. — [Anthropic engineering](https://www.anthropic.com/engineering/building-c-compiler)
- Limits: no 16-bit real-mode codegen (it calls GCC for that), no native assembler or linker, generated code worse than GCC -O0, and new features often broke old ones. Some users reported hello-world failures. — [Anthropic engineering](https://www.anthropic.com/engineering/building-c-compiler); [Digg thread](https://digg.com/programmingworld/WhNTUxv/anthropic-built-a-c-compiler-using)
- Parallelism lessons:
  - Parallel work is easy when there are many independent failing tests.
  - The Linux kernel build was one monolithic task, so "all agents hit the same bug and overwrote each other's fixes." The fix was to use GCC as a known-good oracle: GCC compiled most files and Claude's compiler compiled a random subset, so agents worked on different files, with delta debugging to isolate file pairs that failed together.
  - Verifiers "must be nearly perfect," and CI was added to block regressions.
  - Each agent gets a `--fast` deterministic 1%/10% test sample.
  - Keep output terse with grep-able ERROR lines to avoid context pollution.
  - Keep READMEs and progress files so fresh agents can orient.
  - Specialized roles helped (dedup, performance, codegen quality, Rust code reviewer, docs).
  
  — [Anthropic engineering](https://www.anthropic.com/engineering/building-c-compiler)

**Anthropic: multi-agent Research system (June 2025)**
- Orchestrator-worker pattern: a lead agent coordinates and delegates to specialized subagents that run in parallel. An Opus 4 lead with Sonnet 4 subagents outperformed single-agent Opus 4 by **90.2%** on Anthropic's internal research eval. Multi-agent systems use about **15x more tokens** than chats. — [Anthropic engineering](https://www.anthropic.com/engineering/multi-agent-research-system); [Simon Willison commentary](https://simonwillison.net/2025/Jun/14/multi-agent-research-system/)

**Anthropic Claude Code: sub-agents, agent teams, Remote Control**
- **Agent teams** (experimental, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`): one lead session coordinates, assigns tasks and synthesizes results. Teammates are independent Claude Code sessions, each with its own context window, that **message each other directly** and coordinate through a **shared task list**. Teammates need an interactive session (not available in `-p` or Agent SDK mode). Token cost is higher than with subagents because each teammate is a full instance. Since v2.1.178, spawning needs no setup step and cleanup is automatic. — [Claude Code docs: agent teams](https://code.claude.com/docs/en/agent-teams); [Addy Osmani on agent teams](https://addyosmani.com/blog/claude-code-agent-teams/)
- *Note:* agent teams appear to run on one machine (the lead's host). The docs snippets say nothing about cross-machine placement.
- **Remote Control** (launched about 2026-02-24, requires v2.1.51+, signed-in account): a local `claude` session can be driven from phone or web. The session keeps running on the user's machine and filesystem, and the web UI is "a window into that local session." It reconnects after sleep or network drops, though one listing reports a ~10-minute timeout. — [Claude Code docs: remote control](https://code.claude.com/docs/en/remote-control.md); [DevOps.com](https://devops.com/?p=182792); [Product Hunt](https://www.producthunt.com/products/claude-code-remote-access)
- This is architecturally close to Nekko's relay model: account-signed bridge, local execution, remote UI. It is used for *steering a session*, not for a coordinator delegating subtasks across machines.

**Anthropic Claude Managed Agents (public beta 2026-04-08; multiagent orchestration public beta 2026-05-06)**
- An agent is defined as model + prompt + tools + MCP + skills. Its environment is either an Anthropic-managed cloud sandbox or a **self-hosted sandbox on your own infrastructure**. Sessions are long-running and resumable, with history, sandbox state and outputs stored server-side. — [Managed Agents docs](https://platform.claude.com/docs/en/managed-agents/overview); [Claude blog](https://claude.com/blog/claude-managed-agents)
- Multiagent orchestration: a lead agent breaks the job into pieces and delegates each to a specialist with its own model, prompt and tools. — [Claude blog: building with Managed Agents](https://claude.com/blog/building-with-claude-managed-agents); [Help Net Security](https://www.helpnetsecurity.com/2026/04/09/claude-managed-agents-bring-execution-and-control-to-ai-agent-workflows/)
- Even with self-hosted sandboxes, "the brain" (Claude and its harness) still runs on Anthropic infrastructure. This is the split-brain/hands model: a cloud coordinator with tool execution on customer machines. — [Trilogy AI commentary](https://trilogyai.substack.com/p/the-plumbing-wars-are-claude-managed)
- *Unverified:* a third-party timeline says memory with self-hosted sandboxes shipped in August 2026. — [Anima blog](https://animaapp.com/blog/agentic/claude-managed-agents/)

**OpenAI Codex cloud (research preview May 2025)**
- A "cloud-based software engineering agent that can work on many tasks in parallel." Each task runs "in its own cloud sandbox environment, preloaded with your repository." — [OpenAI: Introducing Codex](https://openai.com/index/introducing-codex/)
- Environments configure dependencies, tools and env vars. Agent internet access is off by default and can be set to limited or unrestricted. — [Codex docs: cloud environments](https://developers.openai.com/codex/cloud/environments)
- **Best-of-N:** Codex "can now generate multiple responses simultaneously for a single task" so the user picks the best. The CLI form `codex cloud exec --env ENV_ID --attempts N` (1-4) comes from third-party guides and is unverified. — [OpenAI community announcement](https://community.openai.com/t/codex-generates-multiple-responses-simultaneously/1287639); [Daniel Vaughan guide (secondary)](https://codex.danielvaughan.com/2026/04/01/codex-cloud-exec-best-of-n-attempts/)
- Merge-back is by human review of a diff or PR. Parallelism is across independent user tasks or attempts, not a coordinator decomposing one task. — [OpenAI: Introducing Codex](https://openai.com/index/introducing-codex/)

**GitHub Agent HQ / mission control (Universe, 2025-10-28) and Copilot coding agent**
- Mission control is a "single command center to assign, steer, and track the work of multiple agents," where you "choose from a fleet of agents, assign them work in parallel." Third-party agents come from OpenAI, Anthropic, Google and xAI. It is available on web, VS Code, mobile and CLI. — [GitHub blog: Agent HQ](https://github.blog/news-insights/company-news/welcome-home-agents/); [TechTarget](https://www.techtarget.com/searchsoftwarequality/news/366633584/GitHub-Agent-HQ-opens-platform-to-third-party-coding-agents)
- GitHub's own guidance: "Agents working in parallel can create merge conflicts if they touch the same files. Be thoughtful about partitioning work." Agents can only commit to designated branches. Users can give the same task to several agents and compare. — [GitHub blog: mission control](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/); [SiliconANGLE](https://siliconangle.com/2025/10/28/github-tackles-vibe-coding-chaos-control-center-ai-coding-agents/)

**Cognition / Devin**
- "Don't Build Multi-Agents" (Walden Yan, June 2025) argued that subagents lose shared context and make conflicting implicit decisions (the Flappy Bird example). — [Cognition blog](https://cognition.ai/blog/dont-build-multi-agents)
- Follow-up "Multi-Agents: What's Actually Working" (about April 2026): "a narrower class works, where agents contribute intelligence while writes stay single-threaded." The original concerns "still hold today for parallel-writer swarms." A DeepWiki context subagent "mostly resemble[s] tool calls." Devin writes code and a separate Devin Review agent reviews it, averaging about 2 bugs per PR with 58% severe (ZenML summary). — [Cognition blog](https://cognition.ai/blog/multi-agents-working); [ZenML summary](https://www.zenml.io/llmops-database/multi-agent-systems-in-production-code-generation-and-review-at-scale)
- "Devin Bots" (reported Nov 2026): an agent coordinates teams of Devin agents over weeks, and Cognition "hasn't explained how Devin Bots handle those conflicts." — [The New Stack](https://thenewstack.io/cognition-devin-bots-management/)

**Manus Wide Research (launched 2025-07-31; follow-up 2025-10-29)**
- "Behind every Manus session runs a dedicated cloud-based virtual machine." In Wide Research each subagent is "a fully capable, general-purpose Manus instance" with a complete VM, typically about 100 parallel (a demo used 100 subagents on sneaker research). — [Manus blog: Introducing Wide Research](https://manus.im/blog/introducing-wide-research); [VentureBeat](https://venturebeat.com/ai/youve-heard-of-ai-deep-research-tools-now-manus-is-launching-wide-research-that-spins-up-100-agents-to-scour-the-web-for-you)
- Sub-agents "do not communicate with each other; all coordination flows through the main controller." This contrasts with the launch's "agent-to-agent collaboration protocol" language. Manus published no benchmarks for it. — [Manus blog, Oct 2025](https://manus.im/blog/manus-wide-research-solve-context-problem); [VentureBeat](https://venturebeat.com/ai/youve-heard-of-ai-deep-research-tools-now-manus-is-launching-wide-research-that-spins-up-100-agents-to-scour-the-web-for-you)

**Moonshot Kimi K2.5 Agent Swarm (tech report, Feb 2026)**
- The model is trained with "PARL" (parallel-agent RL). It gets tools to create subagents and delegate tasks. Subagents are frozen during training and only the orchestrator is RL-updated, to avoid credit-assignment ambiguity. In wide-search scenarios it reports up to **4.5x lower latency** and item-level F1 rising from 72.8% to 79.0% vs. a single agent. — [Kimi K2.5 tech report, arXiv 2602.02276](https://arxiv.org/html/2602.02276v1)
- Secondary only: up to 100 subagents and 1,500 tool calls. A reviewer observed "serial collapse," where the orchestrator falls back to sequential work. — [DataCamp tutorial](https://datacamp.com/tutorial/kimi-k2-agent-swarm-guide)

### Inferences
- The industry has converged on **orchestrator-worker with isolated per-worker sandboxes**. Workers are kept ignorant of each other (Cursor workers, Manus subagents) or coordinate only through git (Anthropic C compiler). Rich peer-to-peer messaging is the exception (Claude Code agent teams, single host).
- Merge-back strategies, by product:
  - **Human-reviewed PR per task** (Codex, Copilot, Cursor cloud) is the safe default.
  - **Shared branch plus agent-resolved conflicts plus CI gate** (Cursor experiments, Anthropic compiler) scales throughput but needs a near-perfect test oracle.
  - **Text synthesis by the lead** (research-style fan-out) avoids write conflicts entirely.
- Read-heavy fan-out (research, review, context gathering) is the uncontroversial win (Cognition 2026, Anthropic Research). Parallel *writers* need task partitioning by file or test, which is a placement problem Nekko's coordinator would have to solve.
- Cursor's `/in-cloud` (local app delegating a branch to a cloud VM) and Claude Code Remote Control (account-relayed control of a local session) are the two closest commercial precedents to Nekko's design. Nobody found combines them, meaning a local coordinator delegating to the *user's other machines* chosen by capability (GPU, OS).

### Gaps
- Cursor's posts could not be fetched. Exact agent counts, VM layout, model assignments and token/cost figures for the browser experiment are unverified beyond snippets.
- No sources gathered this session for **Google Jules** (async VM per task, from memory, unverified), **Factory** (Droids), **Amp** (Sourcegraph; subagents / "Oracle"), or **Claude Code on the web** cloud sessions. They were left uncovered to stay within the tool budget.
- No public numbers on how often Codex best-of-N or Agent HQ multi-agent comparisons are used, or on their win rates.

---

## 2. Open-source frameworks and infra for distributing agent tasks across machines: which support heterogeneous user-owned machines?

### Takeaway
The sandbox/infra layer has standardized around fast-provisioned, snapshot-able isolated VMs or containers: Morph Infinibranch, Kubernetes `agent-sandbox`, GKE Agent Sandbox (also E2B, Daytona, Modal and Fly, which were not verified this session). Durable-execution engines such as Temporal now wrap agent loops. Almost all of this assumes a homogeneous cloud or cluster the operator controls. Temporal-style worker/task-queue models and A2A agent cards are the pieces that *could* address a heterogeneous user-owned fleet, because workers pull work and advertise capabilities. Nobody packages them that way.

### Cited Findings
- **Morph Cloud Infinibranch:** snapshot, branch and restore entire VMs "in under 250ms." The workflow is instance → snapshot → branch into N parallel instances. Devboxes "can branch to hundreds of parallel replicas or scale to zero," preserving memory state. At AI Engineer World's Fair 2025, Jesse Han described parent agents delegating reasoning to subagents that each start from an identical environment copy. — [Morph docs](https://cloud.morph.so/docs/developers); [Morph branch docs](https://cloud.morph.so/docs/documentation/instances/branch); [Morph Devboxes](https://cloud.morph.so/web/product/devboxes); [AI Engineer talk](https://ai.engineer/talks/the-infrastructure-for-the-singularity)
- **kubernetes-sigs/agent-sandbox:** a `Sandbox` CRD plus `SandboxTemplate`, `SandboxClaim` and `SandboxWarmPool` (pre-warmed pods handed out on claim). The Kubernetes blog covered it on 2026-03-20. — [GitHub repo](https://github.com/kubernetes-sigs/agent-sandbox); [agent-sandbox docs](https://agent-sandbox.sigs.k8s.io/docs/getting_started/overview/); [Kubernetes blog](https://kubernetes.io/blog/2026/03/20/running-agents-on-kubernetes-with-agent-sandbox)
- **GKE Agent Sandbox** (managed) adds snapshot, suspend and resume for checkpointing, and "sandbox forking for parallel agent branching." The third-party cocoonstack/sandbox-operator adds pause, resume, fork and snapshot subresources, with resume and fork **node-local**. — [Google Cloud blog](https://cloud.google.com/blog/products/containers-kubernetes/accelerate-agentic-rl-with-gke-agent-sandbox); [cocoonstack sandbox-operator](https://pkg.go.dev/github.com/cocoonstack/sandbox-operator)
- **Temporal + OpenAI Agents SDK:** public preview July 2025, GA for Python about March 2026. The agent loop, tool selection and handoffs run inside a deterministic Workflow, while model calls and tools run as Activities on workers, giving durable retry and resume. Temporal's durability does not cover MCP servers. TypeScript has `TemporalOpenAIRunner`. Temporal also has a post on "agentic sandboxes." — [Temporal blog](https://temporal.io/blog/announcing-openai-agents-sdk-integration); [Temporal docs](https://docs.temporal.io/develop/python/integrations/openai-agents); [Temporal: agentic sandboxes](https://temporal.io/blog/introducing-temporal-and-agentic-sandboxes-openai-agents-sdk); [InfoQ](https://www.infoq.com/news/2025/09/temporal-aiagent)
- **Google A2A protocol:** launched April 2025 and donated to the Linux Foundation in June 2025 (founders include AWS, Cisco, Microsoft, Salesforce, SAP, ServiceNow). It had 150+ organizations by April 2026 and is now joining the Agentic AI Foundation (AAIF). An **Agent Card** is a JSON manifest (identity, capabilities, endpoint, auth) at `/.well-known/agent-card.json`. Remote agents are **opaque**: callers don't see their tools, memory, model or plan. In v1.0 a card lists multiple interfaces instead of one URL. — [Linux Foundation press](https://linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents); [LF 1-year release](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year?hsLang=en); [AAIF: A2A v1.0 builder's guide](https://aaif.io/blog/a2a-v1-0-a-builder-s-guide-part-1-discovery-tasks-and-clients); [AAIF: A2A joins](https://aaif.io/blog/a2a-joins-aaif?hsLang=en)
- **Claude Managed Agents** supports a self-hosted sandbox on your own infrastructure, with the coordinator ("brain") in Anthropic's cloud. This is the only first-party vendor option found that places agent *hands* on customer machines. — [Managed Agents docs](https://platform.claude.com/docs/en/managed-agents/overview); [Trilogy AI](https://trilogyai.substack.com/p/the-plumbing-wars-are-claude-managed)

### Inferences
- For Nekko, the transferable design is: **A2A-style capability cards per machine** (GPU, OS, installed toolchains, repos present), plus **Temporal-style pull-based workers with durable task state**, plus **per-task isolated workspace** (worktree, container or VM). Snapshot/fork (Morph, GKE) matters for best-of-N and branching exploration but is mostly unavailable on consumer macOS and Windows hosts.
- Kubernetes/agent-sandbox and Morph assume operator-controlled homogeneous capacity, which does not fit a two-machine home fleet behind NAT. Temporal workers can run anywhere with outbound connectivity, which does fit a relay-based fleet.

### Gaps
- Not verified this session: **Ray** (actors/tasks with custom resource labels, which do support heterogeneous nodes, from memory), **Dagger**, **Modal**, **E2B**, **Daytona**, **Fly Machines**, **OpenHands remote runtime**, **LangGraph Platform**, **AutoGen distributed runtime** (gRPC host/worker runtime, from memory), **CrewAI**, and **MCP over Streamable HTTP**. Their architectures are not cited here and need a follow-up pass.
- No source confirmed whether any of these sandbox providers support BYO consumer machines (Mac/Windows) as execution targets.

---

## 3. Doing this on users' own heterogeneous machines (home fleet / LAN / edge)

### Takeaway
On user-owned machines, prior art is almost entirely **young, self-reported open-source projects from 2025-2026**, mostly built on Tailscale plus git worktrees. Sidefleet, apra fleet, fleetSpark/fleet and cmesh do capability- or load-aware routing to your own machines. Perry, StarAgent and Firetower are remote workspaces or dashboards. Claude Code Remote Control is the first-party "control a local agent remotely" precedent but does not delegate between machines. No established commercial product does coordinator-to-user-fleet subtask placement, which is a real gap Nekko could fill.

### Cited Findings
- **Sidefleet** (v0.1.2): a control plane plus a worker per machine. It routes each task to the **least-busy machine that has the repo and the agent installed**. Each task gets its own **git worktree and branch**. The control plane needs Postgres, is self-hostable, and should sit on a private network such as Tailscale. — [Sidefleet listing (search snippet; page not fetchable)](https://www.everydev.ai/tools/sidefleet/llms.txt)
- **apra fleet**: Apache-2.0 **MCP server** that runs agents "across your real machines (laptops, build servers, VMs)" with mixed providers, aimed at long unattended work. — [Product Hunt](https://www.producthunt.com/posts/apra-fleet)
- **fleet (fleetSpark)**: "agents across every machine you own, coordinated through git." No further detail verified. — [GitHub](https://github.com/fleetSpark/fleet)
- **cmesh**: a Go tool for policy-gated agent delegation over Tailscale, handing coding tasks to machines you control. Very new (about 1 star). — [ecosyste.ms listing](https://awesome.ecosyste.ms/projects/github.com%2Fsomoore%2Fcmesh)
- **Perry**: Claude Code, OpenCode and Codex CLI preinstalled on self-hosted machines reachable over Tailscale. It is a remote workspace, not a scheduler. — [GitHub](https://github.com/Gricha/perry)
- **StarAgent**: long-lived tmux sessions, Tailscale networking, and a web dashboard across machines. — [README](https://raw.githubusercontent.com/SiriusNEO/StarAgent/main/README.md)
- **Firetower**: Rust, self-hostable, runs several agents in parallel on servers you connect. — [Product Hunt](https://www.producthunt.com/products/firetower)
- **AgentFleet OSS**: makes throughput and failover claims in its own README (self-reported). — [Product Hunt](https://www.producthunt.com/products/agentfleet-oss)
- Practitioner write-ups on Tailscale as the missing networking layer for multi-machine agents ("your remote coding agent has the repo, not the machine"). — [DEV: clarkbw](https://dev.to/clarkbw--/your-remote-coding-agent-has-the-repo-not-the-machine-tailscale-is-the-missing-half-k4d); [DEV: whoffagents](https://dev.to/whoffagents/how-tailscale-simplified-our-multi-machine-ai-agent-network-kbp); [DEV: private control room](https://dev.to/sendlogz/i-built-a-private-control-room-for-coding-agents-running-on-my-machines-32ni)
- **Netclode** (Feb 2026): a personal "cloud" coding agent on self-hosted hardware. — [stanislas.blog](https://stanislas.blog/2026/02/netclode-personal-cloud-coding-agent/)
- **Claude Code Remote Control**: an account-relayed bridge to a local session with local execution and reconnect after sleep (see Q1). — [Claude Code docs](https://code.claude.com/docs/en/remote-control.md)

### Inferences
- The emerging home-fleet pattern is: **private overlay network (Tailscale) or account relay → per-machine worker daemon advertising repos and agents → control plane picks the machine (least-busy plus has-repo) → git worktree and branch per task → results return as branches or PRs.** This maps almost one-to-one onto Nekko (nekkod as worker, Nekko Cloud relay as overlay).
- Nekko's advantages over these projects: an existing account-synced fleet, a relay instead of a Tailscale dependency, mobile control, and an in-process coordinator. Those projects mostly lack an LLM *coordinator* that decomposes one task. A human assigns tasks to machines.

### Gaps
- Not verified this session: **exo** (splits model inference across home devices, which is out of scope per brief), **Prime Intellect / Nous** decentralized agent work, and any **BOINC-style volunteer compute for agents**. I found no sources showing volunteer-compute agent task execution in practice.
- All home-fleet projects above are self-reported, with no usage numbers or published results.

---

## 4. Classic non-LLM analogs and which lessons transfer

### Takeaway
Distributed build systems (Bazel REAPI, BuildBuddy) already solved "ship a hermetic task to a capable worker and cache the result." Their core ideas transfer directly: content-addressed inputs, action caches, workers advertising platform properties to a scheduler, and graceful fallback to local execution. Agent tasks are non-deterministic, so caching must be weaker (cache tool and test results, not agent outputs). Leases and heartbeats, idempotent claims, and pull-based work-stealing are the parts that transfer cleanly. Anthropic's git lock-file scheme is a crude lease without expiry.

### Cited Findings
- **Bazel Remote Execution API:** an Action contains everything needed to reproduce a run. Inputs live in **content-addressable storage (CAS)**, and results are cached in an **Action Cache** keyed by action hash. **Platform requirements** are attached to the action, and servers favor Action-level platform properties. — [REAPI v2 (Go docs)](https://pkg.go.dev/github.com/bazelbuild/remote-apis/build/bazel/remote/execution/v2)
- The action cache (action hash → result metadata) and the CAS (output files) are evicted independently. Bazel **falls back to local execution** on a cache miss or error. — [Bazel remote caching docs](https://bazel.build/remote/caching)
- **Capability-aware placement:** BuildBuddy executors "connect to [the] scheduler and advertise their platform properties (such as OS and architecture)." Platform properties are part of the cached action result, so inconsistent properties lower hit rates. Namespace exposes custom worker pools as Bazel execution platforms selected with `exec_compatible_with`. — [BuildBuddy blog](https://www.buildbuddy.io/blog/bazels-remote-caching-and-remote-execution-explained); [BuildBuddy architecture](https://mintlify.com/buildbuddy-io/buildbuddy/architecture-remote-build); [Namespace docs](https://namespace.so/docs/bazel/execution)
- Practice article on remote caching for Bazel at scale. — [CACM](https://cacm.acm.org/practice/using-remote-cache-service-for-bazel)
- **Agent-world analogs already observed:**
  - Anthropic's `current_tasks/*.txt` lock files are an advisory lock with git as the consensus layer. There is no expiry or heartbeat; a crashed agent's lock would linger, and the post does not say how stale locks were handled.
  - Cursor found explicit locking and dynamic coordination "brittle" and a bottleneck, and replaced them with a planner-owned task queue.
  - Temporal gives durable retries and resume for agent loops.
  
  — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler); [Cursor (snippet)](https://cursor.com/blog/scaling-agents); [Temporal docs](https://docs.temporal.io/develop/python/integrations/openai-agents)
- **Oracle-based partitioning** (Anthropic using GCC to split the kernel build across agents) is essentially delta-debugging and sharding against a known-good reference. — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)

### Inferences
- **Transfers well:**
  1. Workers advertise capability properties and the scheduler matches them (OS, arch, GPU/VRAM, installed SDKs, repos cloned, battery or on-AC state).
  2. Content-addressed inputs: dispatch a task as (git commit SHA + patch + prompt + tool manifest), so any machine can reconstruct the exact workspace.
  3. Result caching for the deterministic sub-steps (builds and tests run by agents), not for LLM outputs.
  4. Local fallback when a remote machine is offline.
  5. Leases with heartbeats and expiry, instead of git lock files, so crashed or asleep laptops release work.
  6. Idempotent task IDs, so relay retries don't double-run.
  7. Pull-based workers (Temporal and BuildBuddy style), which suit NAT'd home machines behind a relay.
- **Transfers poorly:** hermeticity and determinism. Agent runs are non-reproducible, so "cache hit = same result" does not hold. Best-of-N and judge selection is the agent-era substitute.
- MapReduce and work stealing map onto research-style fan-out (map = subagents, reduce = lead synthesis). Coding fan-out is closer to a build DAG with conflicts, which is why partitioning by file or test is critical.

### Gaps
- Not separately sourced this session: distcc, Buck2 remote execution, Nx/Turborepo remote caching, HTCondor ClassAds matchmaking, Nomad constraints/affinities, and BOINC work units and redundancy. These are well-known analogs (HTCondor ClassAds is the classic capability-matchmaking design), but no citations were gathered.

---

## 5. Common patterns: scheduling and placement, merging work back, failure handling

### Takeaway
Across products and experiments: **placement** is mostly trivial (any identical cloud VM) except in home-fleet tools (least-busy plus has-repo) and build systems (platform properties). **Merge-back** is branch or worktree per task plus PR, or a shared branch with agent-resolved conflicts behind a CI gate. **Failure handling** relies on fresh-context restarts, judges, durable workflows, and above all strong test oracles. The most cited failure modes: parallel writers clobbering each other on monolithic tasks, risk-averse drift in flat swarms, orchestrators collapsing to serial work, and runaway token cost (about 15x).

### Cited Findings
- **Placement:**
  - Home-fleet: least-busy machine that has the repo and agent. — [Sidefleet (snippet)](https://www.everydev.ai/tools/sidefleet/llms.txt)
  - Build systems: executors advertise OS/arch to the scheduler. — [BuildBuddy](https://www.buildbuddy.io/blog/bazels-remote-caching-and-remote-execution-explained)
  - Cloud products: one isolated VM or container per task. — [Cursor cloud agents talk](https://claude.com/code-with-claude/session/sf-giving-coding-agents-their-own-computers-how-cursor-built-cloud-agents); [OpenAI Codex](https://openai.com/index/introducing-codex/)
  - Role-based model routing: Cursor found different models excel at planner vs. worker roles. — [Cursor (snippet)](https://cursor.com/blog/scaling-agents)
  - Anthropic Research uses Opus lead plus Sonnet workers. — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)
- **Work splitting:**
  - Recursive planners and sub-planners generate tasks. — [Cursor (snippet)](https://cursor.com/blog/scaling-agents)
  - Self-selection from a shared task directory. — [Anthropic C compiler](https://www.anthropic.com/engineering/building-c-compiler)
  - Shared task list plus direct messaging. — [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)
  - Lead decomposes into items for N homogeneous subagents. — [Manus](https://manus.im/blog/manus-wide-research-solve-context-problem)
  - RL-trained orchestrator decides the fan-out. — [Kimi K2.5](https://arxiv.org/html/2602.02276v1)
- **Merge-back:**
  - Per-task worktree and branch. — [Sidefleet (snippet)](https://www.everydev.ai/tools/sidefleet/llms.txt); [Cursor /in-cloud (snippet)](https://cursor.com/changelog/cloud-in-agents-window)
  - Designated branches and partitioning advice. — [GitHub mission control](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/)
  - Pull, merge, push to a shared upstream with agent-resolved conflicts. — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
  - Hundreds of workers on the same branch. — [Cursor (snippet)](https://cursor.com/blog/scaling-agents)
  - Human picks among N attempts. — [OpenAI community](https://community.openai.com/t/codex-generates-multiple-responses-simultaneously/1287639)
- **Failure handling and quality control:**
  - Judge plus fresh-start cycles. — [Cursor (snippet)](https://cursor.com/blog/scaling-agents)
  - CI blocking regressions, near-perfect verifiers, progress files for fresh agents. — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
  - Durable workflow retries. — [Temporal](https://docs.temporal.io/develop/python/integrations/openai-agents)
  - Snapshot/checkpoint for recovery. — [GKE Agent Sandbox](https://cloud.google.com/blog/products/containers-kubernetes/accelerate-agentic-rl-with-gke-agent-sandbox)
  - Reconnect after laptop sleep or network drop. — [Claude Code Remote Control](https://code.claude.com/docs/en/remote-control.md)
  - Separate reviewer agent. — [Cognition](https://cognition.ai/blog/multi-agents-working)
- **Documented failure modes:**
  - Flat-swarm risk aversion and churn. — [Cursor (snippet)](https://cursor.com/blog/scaling-agents)
  - Locking bottlenecks. — [Cursor (snippet)](https://cursor.com/blog/scaling-agents)
  - All agents hitting the same bug on a monolithic task. — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler)
  - Serial collapse. — [DataCamp (secondary)](https://datacamp.com/tutorial/kimi-k2-agent-swarm-guide)
  - Context loss between parallel writers. — [Cognition 2025](https://cognition.ai/blog/dont-build-multi-agents)
  - Unexplained conflict handling. — [The New Stack on Devin Bots](https://thenewstack.io/cognition-devin-bots-management/)
  - About 15x token cost. — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)

### Inferences
- A defensible Nekko design synthesized from this prior art:
  - The coordinator stays local (or on the user's primary machine).
  - Subtasks are content-addressed bundles: commit SHA, worktree, prompt, tool manifest.
  - Placement matches subtasks against machine capability cards (e.g., GPU work → RTX 5090 PC; macOS/iOS builds → M1 Max).
  - Workers pull over the relay with leases and heartbeats.
  - Each subtask writes to its own branch or worktree. The coordinator, or a judge or reviewer agent, merges behind tests.
  - Read-only fan-out (research, review, test runs) is the low-risk first step. Parallel writers wait for strong per-task test oracles.
- With only 2-3 machines, the win is less raw parallelism (cloud VMs are cheap) and more **capability and locality**: using the GPU box, the OS-specific toolchain, local files or credentials that only exist on one machine. None of the surveyed products optimizes for this, and it is the most distinctive angle for Nekko.

### Gaps
- No source found that measures the overhead of cross-machine delegation (latency, repo sync time) vs. same-host subagents.
- No source found on handling heterogeneous model or toolchain versions across a user's machines (e.g., different agent CLI versions on Mac vs. Windows).
- No primary source on how Cursor's hundreds of same-branch workers avoided conflicts ("minimal merge conflicts" is asserted, but the mechanism is not visible in the snippets).
