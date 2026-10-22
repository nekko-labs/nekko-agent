---
title: "Repository review integration"
area: code
split-from: SPEC.md (2026-10-22)
---

# Repository review integration

[Configured; activation and live review unverified] CodeRabbit is intended to automatically review draft and ready pull requests and incremental pushes for the public nekko-agent repository. The root .coderabbit.yaml uses quiet actionable review guidance aligned with AGENTS.md, protects the PR description from automatic summaries, and disables automatic approval and code-generating finishing touches. Reviews are advisory and never replace required CI, human review, or inspected UI evidence. Acceptance requires repository-scoped GitHub App installation, confirmation of the free public-repository offering with paid add-ons disabled, and an observed real review plus an incremental update. No credential or Actions secret is added; hosted review processes public code and PR context under CodeRabbit terms. Access to unrelated/private repositories or external MCP integrations requires separate approval. See reports/code-review-integrations.md for owner activation steps, fair-use limits and complementary tools.
