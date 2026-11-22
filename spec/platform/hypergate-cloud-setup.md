---
title: Hypergate setup in Nekko Cloud
area: platform
status: in-progress
---

# Hypergate setup in Nekko Cloud

Employee preview alongside the [Cloud management console](cloud-management-console.md). A verified @nekkolabs.com account, or a verified alternate email on the configured Nekko staff roster, can publish and edit its own portable setup on any plan. Other accounts see Coming soon. A user cannot select another employee's setup.

The console lists Nekko Agent and Hypergate as separate products. Nekko Agent owns fleet and operations; Hypergate owns portable setup settings. Billing, organizations and privacy requests are shared workspace destinations.

In Hypergate, open Settings → Nekko Cloud, sign in by email code, review and publish. The Cloud console shows the latest revision, timestamp, desktop startup and window-close choices, and enabled flags for recognized catalog servers. Saving an edit changes no computer. Refresh and compare in each local manager, then apply. Existing credentials and custom definitions are untouched. Missing catalog servers require local setup. Enabled flags take effect at the next daemon start, not on receipt.

The service validates a closed format before storing it. Version 1 has no free-form values, executable definitions, keys, credential references, connection strings or activity. It is an account-readable profile, not part of the encrypted Library. Stale edits cannot overwrite a newer revision. No automatic sync, remote execution or fleet monitoring in this preview. Production rollout and identity-provider verification remain pending.
