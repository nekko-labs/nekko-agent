---
title: "In-chat pull requests"
area: code
split-from: SPEC.md (2026-10-22)
---

# In-chat pull requests

Updated 2026-10-02. Open pull-request cards lead with the actual GitHub head branch, with repository, PR number and target branch retained as secondary context. Until live metadata arrives, the label uses the repository and PR number from the URL rather than inventing a branch. Open and closed cards share the merged banner's compact rounded layout with a faint neutral wash, no enclosing border, and slim borderless actions. Approve keeps a green text cue, Decline keeps a danger cue, and Merge uses neutral ink; filled gradients and purple are reserved for the unchanged merged celebration. Existing action confirmation and disabled states remain intact.

Reading files or searching code does not create PR cards from example URLs in tests or documentation. Explicitly discussed PR links and shell output, including `gh pr create`, still surface cards.

## Complete progress observations

Implemented data contract: the existing session PR poller also fetches the current head's check contexts and review threads using paginated GitHub GraphQL reads, through `gh` or the connected GitHub token. Each connection is published only when complete. Permission failures, missing page metadata, truncation and head changes are unknown, never zero. Empty complete connections are genuinely empty. Review counts mean resolved/unresolved **threads**, not individual comments, approvals or review decisions.

Check observations distinguish successful/neutral/skipped, pending, failing (including cancellation), and unknown results. Only safe HTTP(S), credential-free check destinations are retained. A local observation timestamp is separate from GitHub's PR modification timestamp. The minute cache, serialized reads and shared renderer polling remain in use; a failed refresh retains the last observation without advancing its timestamp. This reads metadata only and adds no automatic PR action or new credential collection.

Acceptance: paginate both connections, omit partial counts, retain explicit unknown outcomes, reject unsafe links, and preserve exact legacy mapper output. Focused Rust mapping and connector transport tests cover these boundaries. Shared-renderer presentation and visual inspection are a separate layer; live hosted GitHub behavior remains unverified until exercised.
