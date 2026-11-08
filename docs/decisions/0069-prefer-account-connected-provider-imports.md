---
status: accepted
date: 2026-11-08
---

# 0069. Prefer account-connected provider imports, with export files as the secondary route

## Context

People bringing an existing provider to Nekko Agent should be able to bring their history and personalization too. The data categories are past prompts/conversations, compatible settings, saved memory and profile. The [feature specification](../../spec/models/provider-data-import.md) records the journey and acceptance criteria; [capability research](../../reports/provider-data-import-capabilities.md) records what current documentation actually establishes.

## Options considered

1. **Account-connected first, export files second:** reuse the selected account identity and request supported read authorization, while retaining portable files where direct access is unavailable. Least manual work when supported, but requires a real provider data-access contract.
2. **Export files only:** avoids direct integration dependencies, but makes every person request/download files and does not meet the desired account-first experience.
3. **Assume model sign-in grants history access:** superficially convenient, but inference and identity permissions do not establish consumer data access. Credential scraping or guessed private endpoints are not an acceptable substitute.

## Decision

Prefer account-connected import, with export-file import as the secondary option. Use per-account and per-category capabilities; disclose unavailable direct access rather than disguising a guided export as a direct import. Retrieval, review and activation are separate steps. The current Claude credential boundary remains intact.

This decision settles ordering, not an unsupported promise that every provider exposes every category. Persistent schemas, public protocol changes and provider-specific authentication require their own implementation review.

## Consequences

Both input methods should share local staging, selective review, provenance, deduplication, apply and undo. Export parsing can be implemented independently once its fixtures are verified, without replacing the primary requirement. A provider connection may offer only identity/inference today and must say so. Supported direct-data contracts, authorization and test accounts are implementation dependencies. No account-import capability is enabled by accepting this decision.
