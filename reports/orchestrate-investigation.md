# Can a local coordinator usefully investigate Nekko Agent?

**Yes, with a qualification: a worker returning text does not mean it finished its task.** In a fresh Orchestrate chat, Qwen 3.6 27B planned a source review, asked for a Small worker, and received Gemma 4 E4B's findings. The first live trial exposed a lost output-limit signal. After the fix, an otherwise equivalent trial hit the same cap, the daemon explicitly reported a partial result, and Qwen told the user which question the worker had not answered.

## The assignment and the evidence

The investigator was given only a read-only [public excerpt of the Model Server](https://github.com/nekko-labs/nekko-agent/blob/4c6569ff723fee4d82e777d95f52d4ca0578c95f/crates/nekko-engine/src/server.rs#L1275-L1315). Its job was to distinguish listing available models from loading one and propose a regression test. The coordinator and worker ran on separate already-installed GGUFs through two isolated llama.cpp b11224 processes, exposed as **one configured localhost provider**. Approval was required for the scoped assignment. The test used fresh daemon state, no user settings or credentials, no downloads and no load into a user-owned server. The source was unchanged and the trial processes were stopped.

| Trial | What happened | What it proves |
| --- | --- | --- |
| Two-turn [scripted pilot](../scripts/orchestrate-investigation-pilot.mjs) | The real daemon persisted a plan, gated a spawn on approval, ran a worker file read, and recovered the plan and direct worker status on follow-up. Originally the status was just `idle`; after the change it is `returned`. | Wiring and persistence, not reasoning quality. The assertions inspect actual provider requests and tool results. |
| First live attempt | The harness misread the approval payload and denied the call. Qwen disclosed the denial and read the source itself. No worker inference took place. | Denial does not silently substitute a different worker. This is not a successful delegation. |
| Corrected live trial, before outcome fix | Qwen delegated to Gemma. Gemma read the source, explained listing, then hit the 384-token cap before finishing the load-path question. Qwen received its text as a successful result and did not disclose the truncation. Six inference requests; 197.648 s for the turn. | Tier routing and handoff worked; completion reporting did not. |
| Live rerun after outcome fix | The same weights, task and output cap produced six requests. The coordinator received “Worker outcome: partial (provider output limit). Do not treat this answer as complete or verified.” Qwen disclosed the cutoff in its final answer. 152.856 s for the turn. | The **engine** preserved the signal; disclosure in prose was **observed model behavior**, not guaranteed wording. The timings are single observations, not a performance comparison. |
| [Two configured provider regression](../crates/nekkod/tests/daemon/orchestrate_fusion.rs) | A native Anthropic-format coordinator received the result from a compatible-format worker. Each received only its own exact overlay. Revoking Fusion before dispatch caused zero worker catalog or inference requests. | Cross-provider consent and wire composition in the real daemon with scripted loopback endpoints. No live hosted account was exercised. |

The worker was not offered further delegation or the parent plan. The coordinator received actual tool results during the turn, and a **bounded turn-start snapshot** of saved state on the next turn. The engine runs worker tool calls sequentially; the configured batch size is advice, not a concurrency promise.

## What to improve next

1. **Worker outcomes — addressed in this change.** Preserve `returned`, `partial`, `failed`, `interrupted`, or `unknown` against the original spawn call. Do not infer success from an idle session, a non-error tool result, or a completed plan. The new tests cover scoped outcomes and follow-up after restart. The Plan Sheet's older UI still treats some idle workers as done: align it with the engine in a follow-up. [Projection](../crates/nekkod/src/orchestrate_state.rs) · [Plan Sheet](../apps/desktop/src/renderer/components/PlanSheet.tsx).
2. **Add a catalog-without-loading regression.** The live models identified the right behavior but not all of its details. Test `state: "not-loaded"` after `GET /v1/models`, then assert that a known, matching unloaded model with JIT loading disabled returns `409` without loading. Qwen did not state the status code; the pinned source supplies it, not a live endpoint test.
3. **Explain requested versus effective mode.** Preserve the user's Orchestrate preference but show why it is inactive when, for example, a chat is offline or Solo. Use the daemon's eligibility decision instead of copying it into three clients. Clarify the global Swarm/parallel wording alongside it. [Mode panel](../apps/desktop/src/renderer/components/ModePanel.tsx) · [orchestration settings](../packages/shared/src/orchestration.ts).
4. **Measure history scan cost before indexing it.** At most six workers reach the coordinator, but the snapshot filters a session metadata listing. Benchmark fixed child count against increasing unrelated history before adding a parent index. No slowdown was measured here. [Store](../crates/nekko-store/src/lib.rs) · [projection](../crates/nekkod/src/orchestrate_state.rs).

## Reproduce the deterministic check

From the repository root, with the normal Rust build prerequisites and Node 22+:

```sh
cargo build --locked -p nekkod --bin nekkod
node scripts/orchestrate-investigation-pilot.mjs
cargo test --locked -p nekkod --test daemon orchestrate
```

On the test Mac the installed static ONNX Runtime archive required `ORT_LIB_LOCATION` and `ORT_PREFER_DYNAMIC_LINK=0`; an earlier build without those settings failed at link time. The pilot uses a debug daemon, a new temporary profile and scripted SSE, not weights. The live trial additionally used Q4_K_M weights, 8,192-token runtime contexts, one slot per model and a 384-token output limit. No tests demonstrate that one prompt is optimal for an entire model family, a cost reduction, or a shipped installer. See the [feature spec](../spec/chat/orchestrate-approach.md) and [model playbook coverage](../spec/chat/orchestrate-model-playbooks.md).
