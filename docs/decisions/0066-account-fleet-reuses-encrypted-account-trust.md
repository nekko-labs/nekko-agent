---
status: accepted
date: 2026-11-07
---

# 0066. The computer fleet reuses encrypted-account trust, not per-computer pairing

Issue: [#2160](https://github.com/nekko-labs/nekko-agent/issues/2160). Spec: [account-synced computer fleet](../../spec/phone/account-synced-computer-fleet.md).

## Context

A phone should discover a user's own computers through Nekko Cloud and use a local model on the selected computer. Existing paired-computer aggregation and provisioned Cloud machines do not provide that path. Sync already distinguishes signing into an account from unlocking its encrypted keyring and trusting a device.

## Options

1. Continue requiring a separate code/link/QR pairing with every computer. This preserves today's transport but does not meet the account-fleet goal.
2. Let same-account sign-in grant fleet access. Simpler onboarding, but an identity-service compromise becomes authority to use computers and bypasses sync's current trust boundary.
3. Unlock the encrypted account once per device through recovery or trusted-device approval, then discover explicitly shared computers. No per-computer pairing. Preserve end-to-end peer authentication and separate sharing consent.

## Decision

Use option 3. The owner explicitly chose one-time encrypted-account unlocking rather than sign-in-only access. Reuse the existing trust primitives; do not invent a cloud-held decryption key or silently manufacture direct-pairing grants.

The initial registry requires a live device wrap and current-epoch proof, stores opaque descriptors, and is disabled by default. It grants discovery only. A later connection implementation must authenticate the host and client and enforce revocation on live sessions before the feature is usable.

## Consequences

- A stolen sign-in session without the unlocked account cannot publish or discover computers.
- Computer sharing must be opt-in and independent of transcript upload consent.
- Production auth, client descriptor crypto, authenticated account-based connections, native UI and real-device inference remain unfinished; the registry alone is not a shipped fleet.
- The first target is a Windows PC serving a local model to a phone. Other desktop platforms and Android remain part of the fleet product, not silently dropped.
- This decision concerns user-owned model-serving computers. It does not accept or implement the separate proposed CI-runner broker in decision 0064.
