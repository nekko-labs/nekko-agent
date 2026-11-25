---
title: "Orchestrate a chat"
area: chat
---

# Orchestrate a chat (#3175)

**Intent.** Give a chat an explicit opt-in to coordinate scoped work across agents and review their results, without making the user change how the model reaches its tools.

**Selection contract.** On desktop, open **Mode → Approach → Orchestrate**. On iPhone and Android, open **Run settings → Approach → Orchestrate** from the chat's model menu in Detailed view. Only `session.orchestrate === true` turns it on; chats without the field show it off. The switch saves one Boolean for this chat through `session:setOptions`. The local and phone gates reject other values. Saving or applying a mode and opening a new chat do not copy this choice; a background turn save does not overwrite a more recent choice. Tool list / Code mode remain a separate setting.

**Boundaries.** Changing this switch is not consent to use another provider, widen tool access, or relax existing approval, privacy, sandbox or routing policy. It does not enable delegation in contexts where delegation is unavailable.

**Daemon turns.** An eligible admitted turn with `spawn_agent` takes the coordinator role. It uses `update_plan` when available, delegates self-contained assignments, and checks worker results. The optional `capability` request (`small`, `medium`, or `large`) follows the existing route constraints and does not override the saved worker route. The coordinator's advisory batch size is `maxParallel` (default 2, bounded to 1–12); the daemon runs these tool calls one at a time. A worker admitted through the coordinator's spawn path receives its own task, does not get the coordinator's plan or sibling records, and is not offered further delegation on that worker turn.

**Prompt boundaries.** Built-in role guidance uses the exact admitted model's tier (including `settings.fusion.modelTiers` overrides) and distinguishes local and hosted routes when known. Model IDs, the worker task, and the coordinator's bounded snapshot of plan steps and direct worker statuses are quoted data on the outgoing user message. They are not stored as prompt instructions or replayed from the transcript. Worker status is saved metadata, not proof that work is live or complete. The [built-in model playbook library](orchestrate-model-playbooks.md) adds a short coordinator or worker instruction based on an exact ID, an inferred family, or a neutral fallback. A nonblank exact user model instruction replaces the built-in line. Solo, restricted and non-opted-in turns do not receive the Orchestrate role context.

An in-flight reply stops before sending another role-bearing request if the coordinator, worker, or a projected child becomes ineligible. An automatic resume must belong to the original spawn call, not just to another worker under the same parent.

**Worker outcomes.** The coordinator gets an explicit partial result when the provider stops a worker at its output cap; usable text still comes back, but a returned tool response is not task completion or verification. The daemon recognizes the exact OpenAI-compatible `length` and Anthropic-family `max_tokens` signals. It does not run tool calls from a capped response. After the final attempt (including an automatic resume), the existing child record stores the spawn-scoped outcome: `returned`, `partial`, `failed`, `interrupted`, or `unknown`. A later turn or daemon reload projects these labels with the child and spawn IDs only, not child answers, errors, or titles. Older records without that evidence remain `unknown` (or `running` when a saved run marker exists); unrelated turns in a child do not change the original outcome. The snapshot is fixed within a turn, so a new tool result takes precedence over it.

**Verification scope.** Daemon loopback tests cover coordinator and worker requests, route and tier selection, and omission of role context on restricted turns. The new OpenAI-compatible tests exercise partial results, retry/resume, and coordinator follow-up after daemon reload. The [app investigation](../../reports/orchestrate-investigation.md) includes a live, isolated Qwen-to-Gemma run and a post-fix truncation rerun. Two-provider switching and revocation were tested with scripted endpoints, not live hosted inference. Desktop, iPhone and Android controls were exercised in isolated fixtures, not a released installer.
