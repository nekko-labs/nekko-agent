---
status: proposed
date: 2026-11-07
---

# 0064. The CI runner fleet goes through Nekko Cloud, with the GitHub key held there

Proposed on 2026-11-07; to be confirmed by Philip. Issue: [#1038](https://github.com/nekko-labs/nekko-agent/issues/1038). Spec: [CI runners](../../spec/automation/ci-runners.md), "Free and Nekko Cloud". Design: [reports/ci-runners-p4-design.md](../../reports/ci-runners-p4-design.md).

## Context

Phase P4 of CI runners turns single Macs into a fleet: presence, a picker endpoint, a broker for the GitHub App key, and a fleet view with notifications. [Decision 0022](0022-ci-runners-vm-and-network.md) put the GitHub App key in each Mac's keychain and said Cloud's broker would hold it later, in the paid plan. Cloud already signs devices in (`nk_` tokens with a plan), but has no teams, and Android has no Cloud sign-in.

## Options considered

**Who is in a fleet**

1. The Macs on one Nekko Cloud account.
2. Cloud teams first, then a fleet per team.

**How the picker job proves itself to Cloud**

3. A Cloud token stored as a repo secret.
4. GitHub Actions OIDC: GitHub signs a short-lived token naming the repository; nothing is stored.

**What the broker hands a Mac**

5. Only JIT runner configs; everything else the Mac does with GitHub goes through Cloud.
6. Installation tokens limited to one hour, the runner's repos and the permissions nekkod uses; the Mac mints its own JIT configs with them.

**Whose GitHub App**

7. One Nekko-owned app, its key a Cloud secret.
8. Each owner's own app, with its key handed to Cloud by the manifest flow.

**How phones see the fleet**

9. Each phone signs in to Cloud.
10. Through the paired computer, over the relay.

## Decision

Proposed: 1, 4, 6, 7 and 10.

- A fleet is one Cloud account's Macs. Teams wait for Cloud teams.
- The picker uses GitHub OIDC, so no secret sits in a repo and a fork PR (which gets no ID token) falls back to hosted.
- The broker hands out narrowed one-hour installation tokens. Every GitHub call on the Mac already goes through one token function, so the change is that function's source, not a proxy for every call. No laptop holds the key; revoking a device cuts it off within the hour.
- One Nekko-owned GitHub App, matching the spec's "Install the Nekko GitHub App". The owner's own app stays the Free path.
- Phones read the fleet through their paired computer with a read-only `runner:fleet` channel, so iPhone and Android stay the same without Android Cloud sign-in.
- All of it is opt-in, needs a Pro or Team plan, and changes nothing for a Mac without Cloud. A Cloud outage sends jobs to hosted runners.
- Golden image mirroring is not part of P4.

## Consequences

- A Mac that turns presence on sends Cloud its name, its runners' repos, labels and states, and the running job's name and link. Keys, networks, battery, activity figures and logs stay on the Mac.
- Cloud becomes part of the runner's path for brokered runners: if Cloud is down for over an hour, brokered runners cannot reach GitHub and their jobs go hosted. Own-app runners are unaffected.
- The picker endpoint answers only for repositories a live fleet Mac serves, so it reveals nothing about anyone else.
- Creating the Nekko Runner GitHub App and its Fly secrets is a step only Philip can take.
- We were wrong if teams need a fleet before Cloud teams exist, or if one-hour tokens on a laptop turn out to be as much exposure as the key.
