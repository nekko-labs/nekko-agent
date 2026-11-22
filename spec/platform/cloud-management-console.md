---
title: Nekko Cloud management console
area: platform
status: in-progress
---

# Nekko Cloud management console

Tracking: [#3222](https://github.com/nekko-labs/nekko-agent/issues/3222). [Screen designs](../../nekko-designs/cloud-console-design.html).

The hosted browser console has three scopes. A signed-in person sees their account, Stripe-hosted billing when enabled, and their own privacy cases. They select an organization before seeing its roster or changing its name, invites or membership. Only an owner can delete it, after confirming its name. A separate staff queue requires explicit compliance authorization; neither an org role nor ordinary team membership grants it.

Export and erasure are separate requests. Submitting either starts review, not fulfillment. The request history shows when the case changed. Staff verify identity and scope and fulfill outside this console; a status change never delivers an export or destroys data. Do not collect attachments or identity documents here.

The browser is not an unlocked Nekko device. Fleet descriptors, pairing secrets, CI logs and automation content stay on trusted hosts. Operations views must distinguish missing telemetry from an empty or healthy fleet. Planned: consented org-level operational summaries, audited pairing changes on a trusted device, broader org audit review, and approved delivery or erasure receipts. No platform-wide customer directory or cross-org impersonation.

Navigation wraps on narrow and folded screens, with the same scope and destructive confirmations. Pilot verification uses synthetic accounts; production Supabase, Stripe and legal fulfillment require separate operational verification.
