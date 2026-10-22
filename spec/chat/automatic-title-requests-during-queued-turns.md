---
title: "Automatic title requests during queued turns (2026-10-13)"
area: chat
split-from: SPEC.md (2026-10-22)
---

# Automatic title requests during queued turns (2026-10-13)

Implemented, native macOS CI verification pending: automatic chat naming has one in-flight title request per session. A queued follow-up continues without waiting for that title request, but cannot start duplicate title work while it is pending. Failure, empty output or cancellation releases the claim so a later turn can try again. Eligibility is checked again after claiming; a user rename is never replaced by a pending automatic title result. Session-specific claims do not block naming in another chat. A held-response regression verifies queue progress before the title lands, plus failure/empty retry, cancellation and rename protection. This fixes the duplicate-request race exposed by macOS CI; it does not alter composer pixels or provider routing.
