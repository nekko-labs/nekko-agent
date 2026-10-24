---
status: accepted
date: 2026-10-24
---

# 0017. Nekko Cloud machines run the agent's tools in a per-user jail; the phone decides what the cloud may see

## Context

The product spec said the cloud never runs the agent's tools: *Cloud never runs your shell/filesystem tools on our servers; the cloud is a sync + relay + billing layer* ([scope-boundaries.md](../../spec/product/scope-boundaries.md), [spec-web-and-hosted.md](../../spec-web-and-hosted.md) §4.1). TASKS PF21 kept *cloud runners* as the phone's later half, and PF14 step 4 (2026-10-13) planned one shared multi-tenant nekkod for a hosted browser edition.

On 2026-10-24 Philip asked for the phone to use cloud models with no computer paired, on a sandboxed cloud machine, the way Claude Code on the web and Devin work, and added one requirement: **the phone must restrict the data the cloud can see.** Design: [reports/ios-chat-modernization-2026-10-24.md](../../reports/ios-chat-modernization-2026-10-24.md) §6; spec: [spec/phone/nekko-cloud-machines.md](../../spec/phone/nekko-cloud-machines.md).

What exists: the Docker image at the repo root (nekkod and the Local Web UI, `NEKKO_SANDBOX=workspace-jail`), the headless relay-agent mode (`apps/local-web-ui/src/relay-agent.ts`: `RELAY_URL`, `ROOM`, `PAIR_KEY`, prints a pairing link), the relay's agent authorization hook (`NEKKO_RELAY_AUTHZ_URL`), Nekko Cloud sign-in and E2EE sync (`crates/nekko-cloud`, `apps/nekko-agent-api`), and the phone's full computer protocol.

## Options considered

1. **One multi-tenant nekkod with a Docker sandbox per chat** (PF14 step 4). Every channel scoped by tenant, fair scheduling, a shared daemon always on; a tenant bug is a cross-user bug. Months of engine work before a demo, and the phone would need a tenant id on the wire.
2. **Rent a third-party sandbox API** (E2B, Modal, Daytona) and bridge it. A second executor beside nekkod, a vendor holding the user's repository and keys, a new client path on the phone.
3. **A Fly Machine per user per machine, running the existing image in relay-agent mode.** A microVM each, no public IP, an egress allowlist, `workspace-jail` inside. To the phone it is another computer: the same pairing keys, E2EE frames, allowlist, chat, approvals, watches, git and PR screens. Nekko Cloud mints the machine and hands the phone its pairing link; it never holds the user's provider key (decision 0016) and never sees chat plaintext (sync stays E2EE).

For *what the cloud may see*:

1. **Everything the user's computer has** (memory, rules, connectors, saved prompts, folders), synced up for convenience. Rejected: it turns a cloud machine into a copy of the user's desktop on hardware Nekko Labs operates.
2. **Nothing but the chat.** Safe, but a machine that cannot clone a repository does nothing useful.
3. **An explicit scope the phone sets per machine, minimal by default.** Repositories by name, Privacy Shield on, memory and rules off, connectors off, secrets none, egress limited to GitHub and the chosen providers. Each item is a switch the owner flips, shown on the machine's page, and the machine refuses what its scope does not grant.

## Decision

Option 3 for the machine and option 3 for its scope.

The boundary becomes: **Cloud never runs tools on your computer. A Nekko Cloud machine runs them in its own jail, which you can see, scope and delete; nothing reaches it that you did not put in its scope.** A cloud machine is never paired with the user's computers and never receives the computer's credentials.

The scope (`CloudScope`, set over a new change-class channel `cloud:setScope` on the machine and recorded by Nekko Cloud for the machine's egress and clone list):

| Item | Default | Who sets it |
| --- | --- | --- |
| Repositories the machine may clone | none | the phone, by `owner/repo`, through the GitHub App the user installs |
| Model providers | none; keys arrive sealed (0016) | the phone |
| Privacy Shield on every cloud model request | on | the phone (off needs Face ID) |
| Memory, rules and saved prompts from the user's computers | off | the phone |
| Connectors (Gmail, Slack, Linear, …) | off, not offered in v1 | the phone, later |
| Network egress | github.com and the providers' hosts | derived from the above |
| Chat sync back to the account | on (E2EE) | the phone |

The decision of 2026-10-13 (one shared multi-tenant nekkod) stands for a hosted browser edition and is not superseded: per-user machines are a different surface, and they do not block it.

## Consequences

- No new phone protocol: `session:create`, streaming, approvals, watches, git and PRs work on a cloud machine as on a PC, and the computer details page is the same screen.
- Nekko Cloud gains a machines API (create, list, stop, delete, scope), a Fly Machines driver, metering by machine hour, and the relay authorization that admits a machine as an agent. The image gains `git`, `gh` and the common toolchains, and an egress allowlist enforced outside the machine.
- The user's provider key is sealed to the machine's device key; Nekko Labs never holds it. Nekko-paid model credits are a billing decision, not taken here.
- Lifecycle: start on first chat, stop after 15 minutes idle, delete after 7 days unused; stopping keeps the disk, deleting is explicit on the phone.
- Operators have no shell into a user's machine by policy, and the machine holds no plaintext that sync has not already sealed.
- We will know it was wrong if users need the computer's memory or connectors on the cloud so often that the scope's defaults are always flipped, or if per-user machines cost more idle than a shared daemon would.
