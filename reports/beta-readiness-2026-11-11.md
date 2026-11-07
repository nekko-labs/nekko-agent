# Nekko Agent beta readiness: competitive investigation

Date: 2026-11-11. Baseline: `cb46157` on main. Audience: local-first individual/prosumer beta; not an enterprise platform launch. This is an engineering/product investigation, not a certification that beta is ready.

## Executive recommendation

**Ship fewer new surfaces, finish the safety and recovery contract.** Nekko already covers an unusually broad intersection of coding, cowork, local models, scheduling, browser tools, connected computers, and phone access. Its beta risk is not the absence of another agent dashboard. It is the distance between an implemented feature, a dependable end-to-end journey, and an honest release promise.

The highest-confidence new implementation tranche is **durable pending-change originals** and **transactionally validated batch file edits**. They close concrete code-level gaps without replacing the agent architecture or duplicating active onboarding work. These are a bounded recovery foundation, **not** Cline-equivalent workspace checkpoints.

Do not hold the individual beta for SSO, every messaging channel, native support for every model vendor, a plugin runtime, or enterprise RAG governance. Do hold the advertised launch scope for reproducible first-run, recovery, permission, distribution, and mobile acceptance failures.

## Method and confidence

- Read the current project rules, product boundaries, specifications, Rust implementations, tool catalog, existing tool/security reviews, launch epic #609 and open issues/PRs.
- Retrieved primary project READMEs and focused documentation for Cline, Bionic, OpenClaw, Pi, Hermes, Goose and OpenCode. External claims below are **documented, not executed or independently benchmarked**.
- Current upstream documentation is mutable. Retrieval date is not the date the feature first shipped. These comparisons must not become an unqualified marketing claim.
- Code evidence is stronger than old task status. Open tickets can describe already-implemented work or missing acceptance. Historical TS engine references are not current implementation: the engine now lives in Rust.
- No customer interviews, conversion analytics, competitor installs, latency benchmarks, billing tests or penetration test were performed. Priority is qualitative product judgment, not measured demand.
- “Bionic” is interpreted as **Bionic / bionic-gpt**, the sovereign Rust AI platform. `bionic.ai` redirects to CrowdStrike application security, a different product. Identity confidence is medium because no URL was supplied.
- “Pi” means the coding agent historically at `badlogic/pi-mono`, whose current documentation links to `earendil-works/pi`, not Inflection's consumer chatbot.

## Competitor findings

| Product | Documented strengths | Most useful beta lesson | What not to copy blindly |
|---|---|---|---|
| Cline | File/command checkpoint history in a separate shadow Git repository; persistent checkpoints; independent file/task restore; Plan/Act; tools, MCP, skills, plugins; provider choice; CLI and desktop surfaces | Recovery is a core trust feature, not an advanced setting. Let users inspect and recover changes without destroying productive conversation | Its auto-approval documentation says the model labels command risk; Nekko's deterministic read-only allowlist is a different and valuable boundary. Shadow Git has storage/performance cost |
| Bionic | Self-hosted sovereign platform; virtual filesystem for memory, documents, conversations, skills and artifacts; sandboxed execution; OpenAPI integrations; teams, audit and usage controls; dataset-backed retrieval | Make knowledge, reusable workflows and durable outputs accessible in one work loop; explicitly describe deployment/data boundaries | Enterprise tenancy, Kubernetes, identity governance and broad integration catalog are not prerequisites for an individual desktop beta. Encryption claims on product pages are not independently verified |
| OpenClaw | Personal gateway, messaging channels, memory, skills, cron/wakeups, session tools and node/device control; onboarding/doctor; documented loop protections and trust boundaries | Unattended work needs bounded failure, durable scheduling and clear destination/identity controls; not just a timer and optimistic toast | A large messaging attack surface and always-on gateway are expensive support commitments. Do not equate documentation breadth with safety or execution quality |
| Pi | Minimal extensible coding core; directory-scoped saved sessions; tree/fork/clone; structured compaction retaining original history; overflow recovery; skills/extensions/packages; export/share and diagnostic reports | Stable primitives, recoverable context and clear session semantics matter more than built-in feature count | Tree navigation is not a file rollback system. Extension-first does not mean Nekko needs an arbitrary plugin execution surface for beta |
| Hermes | Persistent curated memory and cross-session search; reusable/self-improving skills; cron with delivery; messaging continuity; subagents; multiple execution backends; model setup and doctor; migration tools | Remembering, recalling and recurring work must be discoverable, observable and verifiable. “I saved it” should require an actual save | Autonomous learning and imported skills can persist unsafe instructions; migrations should preview and avoid credentials by default. Its own memory docs warn against multiple writers to one profile |
| Goose | Native desktop, CLI/API; local and hosted providers; subscription access via ACP; MCP extension ecosystem | A credible beta needs a small number of polished end-to-end journeys and easy interoperability, not provider lock-in | Provider/extension counts alone do not establish compatibility or reliability |
| OpenCode | Provider-independent coding agent; desktop beta; read-only Plan vs Build; subagents | Make planning vs acting and permissions legible; preserve provider neutrality | Another UI metaphor is not inherently a beta gap |

### Cross-competitor requirements, not a feature-count contest

1. **Install → configure → first successful task** with honest errors and an obvious recovery path.
2. **Inspect → approve → act → undo/recover**, preserving the user's work and explaining the limits.
3. **Long-running work survives context growth and restart** without replaying uncertain mutations.
4. **Choose local/cloud deliberately**, with no silent provider switch or misleading privacy promise.
5. **Reusable knowledge and workflows** with provenance and visible writes, not hidden “self-improvement.”
6. **Outputs are usable after the chat**, and sharing/export is explicitly scoped.
7. **Unattended work has bounded failures**, human approvals where appropriate, and observable delivery.

## Nekko: what already exists versus the real gaps

| Area | Evidence in current repository | Assessment |
|---|---|---|
| Model/provider choice | `packages/shared/src/models.ts`; `crates/nekko-agent/src/providers/`; `spec/models/` | Anthropic/OpenAI/OpenRouter, ChatGPT and Claude Code integration, local servers, managed engine, Bedrock/Vertex/Foundry exist. Native Gemini and Azure OpenAI are not declared provider kinds. OpenRouter/OpenAI-compatible use is not equivalent to a native provider integration |
| File review/recovery | `crates/nekko-tools/src/changes.rs`; `crates/nekkod/src/main.rs`; `routes.rs` `changes:*` | Originals captured on first native file-tool write/edit, but memory-only at baseline. No per-tool shadow repository. Shell/external edits are not comprehensive checkpoints |
| Edit fidelity | `crates/nekko-tools/src/exec.rs` `edit_file`; `spec.rs`; `crates/nekko-turn/src/catalog.json` | Unique exact single replacement only. No validated batch. Existing JS replacement interpolation is a compatibility detail; a new batch must use literal replacements |
| Stuck runs | `crates/nekko-loop/src/progress.rs`, `run.rs`, `runaway.rs` | Already implemented: repeated-result/error detection, nudge then wrap-up, streaming repetition limits and bounded retry. Do not add a duplicate loop detector |
| Transcript recovery/context | `crates/nekko-loop/src/resume.rs`, `history.rs`; `crates/nekkod/src/turns.rs`; `spec/chat/chat-cowork-unified-surface.md` | Checkpointed transcript/recovery and compaction already exist. Distinguish transcript recovery from workspace recovery; longer native/real-model acceptance remains separate |
| Permissions/privacy | `crates/nekko-tools/src/guardrails.rs`, `gitguard.rs`; `spec/context/agent-data-security.md`; `reports/agent-data-security-2026-11-06.md` | Read-only shell allowlist, path jail, private-network fetch gating, taint egress/memory gating and injection fixtures already exist. Do not claim old report recommendations are all missing. Offline UI is not a host shell network sandbox; Claude Code has separate policy boundaries |
| MCP/connectors | `crates/nekkod/src/mcp.rs`; `spec/context/workspaces-indexing-connectors.md` | stdio and Streamable HTTP, optional configured bearer token, connectors exist. No OAuth discovery/consent/token-refresh flow found in the MCP client. “MCP supported” needs an auth compatibility matrix |
| Web research | `crates/nekko-turn/src/catalog.json`; `packages/shared/src/tool-categories.ts`; `reports/tool-gap-review-2026-10-15.md` | Browser and `fetch_url` exist; first-class `web_search` is absent from built-ins. Browser/manual search or an MCP service is a workaround, not a native search product |
| Memory/knowledge | `spec/context/context-guardrails-memory-the-differentiators.md`; `workspaces-indexing-connectors.md` | Global/workspace Markdown memory, visible save cards, indexing/connectors exist. Do not label memory wholly absent. Curated memory, session recall and governed datasets are different capabilities |
| Automation | `crates/nekko-automation/`, `crates/nekkod/src/watches.rs`; `spec/automation/` | Durable watches and workflow execution exist. #680 launch acceptance is not proof of no scheduling implementation |
| Distribution/outputs | `apps/artifact-server/`, `spec/code/rich-responses-reports-and-design-workspace.md`; launch #609/#693 | Local rich artifacts exist. The desired hosted/share/download journey has separate availability, ownership and retention acceptance; not equivalent to a local preview |
| Onboarding/mobile | Launch #609, #617, #661, #668, #684, #691; active onboarding PR #1969 observed | Existing implementation and concurrent work require fresh end-to-end proof; avoid overlapping the onboarding branch. No iPhone/iPad/foldable acceptance was performed here |

## Prioritized backlog

Priority separates **launch gates**, **this implementation tranche**, and **later differentiation**. Effort is a rough relative estimate; dependencies and verification can dominate coding time.

| Rank | Item | Why / acceptance | Priority and action |
|---|---|---|---|
| 1 | First-run and release-path acceptance | Clean install, connect a supported provider/local engine, complete one useful task, reopen, update/recover; accessible guidance for missing credentials/runtime | P0 launch gate. Existing #617 / active #1969; do not duplicate concurrent implementation. Release owner must verify supported OS builds |
| 2 | Durable file-review originals | Restart must not silently erase the only original used by Review Changes. Fail closed before mutation if the required snapshot cannot be saved; no incognito persistence; delete snapshots with chat data | P0 recovery gap; **selected for implementation**. Narrower than full checkpoints |
| 3 | Batch-edit validation | Multiple literal substitutions to one file validate in order in memory; invalid or ambiguous later edit leaves file unchanged; same jail/approval gates; bounded payload; original retained | P1 coding reliability; **selected for implementation**. One-file validation transaction, not arbitrary multi-file or shell rollback |
| 4 | Supported-provider acceptance matrix | Valid tool call, cancellation, retry/429, overflow, attachments, local/offline, auth expiration; unsupported capabilities fail clearly | P0 for advertised providers. Test matrix across supported providers; do not silently route missing native Gemini to a cloud service |
| 5 | First-class web search | Bounded title/URL/snippet results, explicit provider/key setup, privacy/egress/offline enforcement, honest citations and failures | P1 research table stake. Implement a vetted backend plus settings/permissions/tests as a dedicated change; no brittle search-engine scraping |
| 6 | Remote MCP OAuth | Standards-compliant discovery, consent, PKCE, scope binding, protected token storage/refresh, revoked-session errors | P1 interoperability. Dedicated security-reviewed feature; configured bearer token remains a documented limited option |
| 7 | Mobile continuation/approval acceptance | Offline/reconnect, approval identity, streamed answer, backgrounding, stop, local/cloud route; phone and tablet layouts | P0 **if** companion is launch scope; otherwise clearly label preview. Include foldables by folded/unfolded/posture capabilities; no assumptions about unannounced hardware |
| 8 | Real artifact handoff | Save/download/share with access control, expiry/revocation, retention and clear local-vs-upload disclosure | P0 if shareable outputs are promised, P1 otherwise; existing #693. Avoid quietly uploading local content |
| 9 | Explicit run spending boundaries | Cost visibility exists, but advisory monthly budget is not a hard cap. Bound unattended spend using reliable accounting or call/token limits with clear semantics | P1 before promising cost-capped autonomous cloud runs. Unknown provider prices must not read as free |
| 10 | Cross-session recall and migration | Search prior work with privacy scope; preview imported memory/skills; credentials excluded unless expressly selected | P2. Hermes/Pi are useful references, but do not add hidden retrieval or secret migration |
| 11 | Full workspace checkpoints | Capture shell-created/deleted/untracked files and preserve new-user edits; safe per-step restore and storage GC | P2 follow-on to durable originals. Requires an explicit conflict model, symlink/binary/large-repo policy and UI acceptance |
| 12 | Enterprise governance / broad messaging | SSO, org policies, audit export, team quotas; many delivery channels | Defer for individual beta. Bionic/OpenClaw differentiation does not establish demand from Nekko's launch users |

## Release acceptance matrix

| Journey | Minimum evidence required | Status in this investigation |
|---|---|---|
| Windows/macOS/Linux first task | Isolated install, real supported provider/local model, edit/test/review/reopen | Not executed here |
| Restart during coding | Native tool originals survive daemon recreation; accept/delete lifecycle; incognito negative test | Implementation tranche; result to be recorded below |
| Invalid batch edit | Disk bytes unchanged; no snapshot mutation for invalid request; no approval bypass | Implementation tranche; result to be recorded below |
| Provider failure | Auth/429/disconnect/overflow produces bounded, actionable error and no unintended replay | Existing code audited, full live matrix not executed |
| Safe browser/MCP use | Scope and egress fixtures, cancelled approval, malicious content stays data | Existing tests/reports inspected, not a new penetration test |
| Recurring task | Restart, one delivery, offline/provider error, cancellation and bounded next wake | Existing implementation; end-to-end launch acceptance not executed |
| Mobile | Phone/tablet and relevant folding postures; reconnect/approve/stop | Not executed; physical devices and platform release builds required |
| Artifact handoff | Recipient access, revoke/expire, download and correct disclosure | Not executed |

## Implementation boundaries and privacy

Durable review originals contain local source content, potentially secrets. Store them locally with private file permissions where supported; do not sync/upload them. Incognito remains memory-only. Snapshot write failure must be surfaced before an agent mutation, not silently downgrade recovery. Chat deletion/clear/reset must remove sidecars. Existing review does not become a backup system or a crash-safe filesystem transaction.

For batch edits prefer an additive optional `edits` array on the existing `edit_file` tool, retaining the old `{path, old_string, new_string}` form. This keeps existing tool permissions, workflow allowlists and categories. Reject mixed forms, empty searches and malformed entries; validate all replacements before writing. Container execution must implement the same behavior rather than accepting a schema it cannot honor.

## Sources (retrieved 2026-11-11)

- [Cline README](https://raw.githubusercontent.com/cline/cline/main/README.md)
- [Cline checkpoints](https://docs.cline.bot/core-workflows/checkpoints): persistent shadow Git, restore options and cost caveat.
- [Cline auto approval](https://docs.cline.bot/features/auto-approve): permission categories and model-provided command risk.
- [Bionic homepage](https://bionic-gpt.com/), [README](https://raw.githubusercontent.com/bionic-gpt/bionic-gpt/main/README.md), [integrations](https://bionic-gpt.com/product/integrations/), [datasets](https://bionic-gpt.com/product/datasets/).
- [OpenClaw README](https://raw.githubusercontent.com/openclaw/openclaw/main/README.md), [loop detection](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/tools/loop-detection.md).
- [Pi README](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md), [sessions](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/sessions.md), [compaction](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/compaction.md).
- [Hermes README](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/README.md), [persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).
- [Goose README](https://raw.githubusercontent.com/block/goose/main/README.md).
- [OpenCode README](https://raw.githubusercontent.com/anomalyco/opencode/dev/README.md).
- [Nekko launch epic #609](https://github.com/nekko-labs/nekko-agent/issues/609), [onboarding #617](https://github.com/nekko-labs/nekko-agent/issues/617), [workflow launch #680](https://github.com/nekko-labs/nekko-agent/issues/680).

A guessed Cline raw documentation path returned 404; the current public docs URL above resolved successfully. Bionic identity was disambiguated as described above. No inaccessible source has been treated as proof of a missing feature.

## Implementation and verification record

Tracked by [issue #2172](https://github.com/nekko-labs/nekko-agent/issues/2172). This report is the first layer; the follow-on implementation adds local saved-chat originals and ordered batch replacements, with its feature specification, user guide and executable regressions. Neither layer certifies the wider beta launch.

Windows focused Rust suites and Clippy with warnings denied passed during development. Direct review subsequently identified a shared-turn save path needing incognito cleanup and corrected the helper's literal-string test; final checks are being rerun on the implementation layer. Added evidence covers restart, acceptance, deletion/privacy races, failed metadata/snapshot reads, failed writes, invalid batches and existing approval/jail boundaries. A real-daemon restart script is included in the follow-on layer, not a claim of packaged-desktop or live-model acceptance.

No visual change is intended. Required Linux CI will execute the actual shipped Python helper and Unix permission assertions. The inspected local Docker image contains no Python, so it cannot supply that evidence. Live-provider/strict-schema acceptance, packaged desktop builds and physical mobile journeys remain unverified. The independent initial review found defects that were addressed; its follow-up failed with an expired authentication token, so it is not recorded as a passed review. See the implementation PR's current **Unfinished work / release blockers** section for final check results and the remaining release conditions.
