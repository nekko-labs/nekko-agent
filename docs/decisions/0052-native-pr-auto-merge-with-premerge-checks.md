# 0052: Native PR auto-merge with pre-merge checks

Date: 2026-11-05
Tracking: [#1855](https://github.com/nekko-labs/nekko-agent/issues/1855)
Status: implementation proposed; settings cutover remains unverified until recorded on the issue

## Decision

Philip requested native GitHub PR auto-merge and no required merge queue. Asked
where queue-tier checks should run, he explicitly chose each PR, not nightly only.

Move path-gated performance and build-gated loopback integration checks to PR CI.
Both hold the existing required `gate`; budgets, paths and platform label opt-ins
are unchanged. Native squash auto-merge matches the old queue's merge method and
the allowed PR methods. It does not bypass checks, reviews or conversation resolution.

The policy executes trusted main scripts with a repository-scoped GitHub App
token. It considers only current same-repository PRs into main with a successful
gate and no draft/hold/conflicts. Reconcile when CI completes and readiness or
labels change. Disable armed auto-merge for draft/hold or an incomplete/failed gate.
Gate also checks current draft/hold and head. Retire scheduled queue repair and
sweeper workflows; retained scripts are historical and not automatically executed.
No blind reruns or budget changes are part of this migration.

## Cutover and rollback

Land the migration through the existing protected queue first, including PR and
merge-group checks. Then remove only the `merge_queue` rule from ruleset 23611651,
keeping the other rules, parameters, conditions and bypass actors identical.
Add required GitHub Actions context `native-premerge`, which depends on migrated
gate. This prevents old green PR-tier gates from merging without fresh coverage.
Do not automatically rerun held PRs; existing PRs can get fresh CI on their next
normal push/readiness/label event.
Verify `allow_auto_merge: true`, the retained required gate, new native-premerge context and resolved-thread
rule, and no merge-queue rule. Keep backups and record API readback in the issue.
Held PRs remain held. No batch arming of existing PRs is authorized by this change.

If cutover fails, leave the old ruleset in place. If native merging malfunctions,
pause auto-merge, diagnose it and restore the saved queue rule if needed; do not
weaken checks to recover. `merge_group` compatibility remains during transition.

## Trade-offs and verification

Native auto-merge does not test combined merge groups. The existing non-strict
required-check policy is unchanged: this decision does not add a requirement to
update every PR with each main commit. PR CI now costs more and known baseline
performance failures can block earlier; diagnose those separately (#712).

No product UI/engine behavior changes or visual evidence update is required.
The existing speed-contract specification records its changed CI enforcement
location and the still-unverified settings cutover. Verify policy command payloads, stale heads,
hold/draft, forks/stacks, pending/failed gates, CI scope fallback, integration gate
dependency and workflow trust boundaries. Actual CI and settings readback remain
separate acceptance steps from local tests.
