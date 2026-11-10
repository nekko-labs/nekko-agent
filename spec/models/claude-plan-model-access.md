---
title: "What a Claude plan includes for Fable (2026-11-10)"
area: models
---

# What a Claude plan includes for Fable (2026-11-10)

**Why:** Davide asked that a Claude plan user know before the first message whether they can use Fable and how it is paid for. Fable 5.1 and 5.2 are not included in every plan the way other models are: on Pro they run on usage credits, on Max up to half the weekly usage. Launch offers also move these lines for a few days at a time. The picker listed Fable 5.1 for every plan with nothing beside it. Decision: [0077](../../docs/decisions/0077-claude-plan-model-access-from-a-dated-catalog.md). User docs: [docs/SUBSCRIPTIONS.md](../../docs/SUBSCRIPTIONS.md#fable-on-a-claude-plan).

`[implemented 2026-11-10 (#2464), unit-tested, picker captured in a hidden fixture; not yet checked against a live Pro or Max sign-in; desktop and Local Web UI only, iPhone and Android not yet]`

## Behaviour

- **Picker label.** In a Claude Agent (`claude-code`) provider signed in to a plan, each Fable row has a short label in the place where other providers show a price. The hover text adds one sentence.
  - Pro: "Uses usage credits". During a launch offer it says "Included until <local date and time>".
  - Max and Ultra: "Up to 50% of weekly usage".
  - Team and Enterprise: "Depends on your seat".
  - Free: "Not in your plan".
  - Other models, API logins and an unread plan show no label.
- **Composer line.** A chat on Fable shows one line above the composer, in the slot of the existing model note.
  - **Near the limit**: Claude Code reported the Fable model window as `warning`. The line reads "You're close to your Fable limit for this week (N% used)", in the warning colour.
  - **On credits**: the Fable window is spent and the account has usage credits, or the plan never includes Fable (Pro after the offer). The line says that from here, or for every message, Fable uses usage credits.
  - A spent window with no credits shows no line: the picker already marks the model "Limit reached".
- **Spent but on credits is not blocked.** A Fable row whose model window is spent, on an account that reports usable credits, stays selectable and reads "Uses usage credits" instead of "Limit reached". The shared `resolveModelAvailability`, and Auto with it, is unchanged, so Auto never moves a turn onto credits.

## Sources and how they change

- **Catalog** (`CLAUDE_PLAN_RULES`, `packages/shared/src/claude-plan-models.ts`). These are dated rules: family, optional model prefixes, plan types, access, cap, optional `from`/`until` instants in UTC, source URL and `reviewedAt`. The first matching rule wins.
  - A known change ships in advance and takes effect by itself at its instant, with no release and no network. Example: the Fable 5.2 Pro offer ends at `2026-11-17T07:59:59Z`, which is 16 November 23:59 PST.
  - A rule not reviewed for 60 days (`PLAN_RULE_STALE_DAYS`) reads "Check your plan" with its last check date, instead of a claim.
- **Live windows.** These come from what the user's own Claude Code printed (`rate_limit_event`, `/usage`), parsed by `parse_claude_code_usage` (decision [0035](../../docs/decisions/0035-plan-usage-on-for-claude-plans-from-claude-codes-own-output.md)). A model-scoped window with `modelFamily: "fable"` wins over the catalog.
- **Plan type.** `subscriptionType` from `claude auth status`, read by `useClaudePlan` and the account identity's `plan`.

## Boundaries

- Nothing is blocked on the catalog's word: Claude Code decides what runs.
- Nekko never reads a plan endpoint, header or credential, and never sends `/usage` itself.
- The numbers never drive switching to another account or model.
- An unforeseen change (a new offer or a new plan) needs a catalog edit and a release until signed policy overrides can carry the catalog. That needs the release signing key, which is still a placeholder ([claude policy](../product/claude-policy.md)).

## Acceptance

- Fable 5.2 on Pro reads "Included until …" before the offer ends and "Uses usage credits" from `2026-11-17T07:59:59Z`, with no release.
- Max shows "Up to 50% of weekly usage". A Fable `warning` window shows the near-limit line. A spent Fable window with credits shows the on-credits line and keeps the row selectable.
- Opus, Sonnet and Haiku rows, API logins and unread plans show nothing new.

## Not yet

- iPhone and Android pickers and composers ([#2465](https://github.com/nekko-labs/nekko-agent/issues/2465)).
- A live check with a real Pro and a real Max sign-in. The Claude Code window names (`Fable` as the model scope) are assumed from the documented `/usage` shape.
- `claude-fable-5-2` is added to the Claude API and Claude Code lists only. Bedrock, Vertex and Foundry wait until Anthropic's platform pages confirm it there.
