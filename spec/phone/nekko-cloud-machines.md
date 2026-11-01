---
title: "Nekko Cloud machines: a sandboxed computer the phone pairs with (2026-10-24)"
area: phone
---

# Nekko Cloud machines: a sandboxed computer the phone pairs with (2026-10-24)

`[first build 2026-10-24: the Cloud API's machines routes with an in-memory driver and the Fly driver (tested), the relay-agent mode's preset pairing code and scope (shared TS), the daemon's relay access token and preset code (Rust, unit-tested), and the iPhone's Machines list, New chat → Nekko Cloud, and the machine's scope sections (NekkoKit tested against an in-memory Nekko Cloud; the screens build only on macOS CI); not deployed, never run against Fly; egress enforcement, metering by the machine's own uptime, memory copy-up and the GitHub App clone are still to do]` **User intent:** use cloud models from the phone with no computer paired, on a sandboxed cloud machine, the way Claude Code on the web and Devin work; and **the phone restricts the data the cloud can see.** Decisions: [0017](../../docs/decisions/0017-nekko-cloud-machines-run-tools-in-a-per-user-jail.md) (the machine and its scope) and [0016](../../docs/decisions/0016-a-phone-carries-a-sealed-provider-key-and-never-holds-one.md) (its provider keys). Design and alternatives: [reports/ios-chat-modernization-2026-10-24.md](../../reports/ios-chat-modernization-2026-10-24.md) §6.

## What the user sees

- **New chat → Runs on** offers a paired computer, **Nekko Cloud** and **This iPhone**. Choosing Nekko Cloud with no machine running makes one (a few seconds) and the chat starts there; the chat's computer pill shows a cloud glyph.
- **Computers** lists the cloud machine beside the paired computers. Its page is the computer details page (round trip, models, providers, hardware, connection) plus **Repositories**, **What the cloud may see**, **Sandbox**, **Hours this month**, **Sleeps in …**, and **Stop and delete this machine**.
- **Settings → Nekko Cloud → Machines** lists every machine on the account with its region, size and state.
- A cloud machine behaves as a computer in every chat screen: streaming, tool rows, approvals, questions, watches, files, git and pull requests, through the same end-to-end encrypted relay path.

## What the cloud may see (the scope)

Set from the phone per machine, minimal by default; the machine refuses what its scope does not grant and the page shows every item.

| Item | Default | Changing it |
| --- | --- | --- |
| Repositories the machine may clone | none | add by `owner/repo` through the GitHub App the user installs; remove any time |
| Model providers | none | keys arrive sealed to the machine (0016); never held by Nekko Labs |
| Privacy Shield on every cloud model request | on | turning it off needs Face ID |
| Memory, rules and saved prompts from the user's computers | off | a switch; when on, the phone copies the selected items up over the E2EE path, never the computer itself |
| Connectors (Gmail, Slack, Linear, …) | off, not offered in v1 | later, per connector |
| Network egress | github.com and the chosen providers' hosts | derived; shown read-only |
| Chat sync back to the account | on, end-to-end encrypted | a switch |

Boundaries: a cloud machine is never paired with the user's computers and never receives a computer's credentials, folders or terminal; the user's provider keys are sealed to the machine's device key; operators have no shell into a user's machine by policy; the machine holds no chat plaintext that sync has not already sealed.

## How it is built (planned)

- **The machine:** the repository's Docker image (nekkod and the Local Web UI, `NEKKO_SANDBOX=workspace-jail`) plus `git`, `gh`, Node, Python and the common toolchains, digest-pinned, started in relay-agent mode (`RELAY_URL`, `ROOM`, `PAIR_KEY`) on a Fly Machine in the user's region, no public IP, one size to start (2 vCPU, 4 GB, 20 GB disk).
- **Nekko Cloud** (`apps/nekko-agent-api`): `POST /v1/machines` (region, size, scope), `GET /v1/machines`, `POST /v1/machines/:id/stop`, `DELETE /v1/machines/:id`, `PUT /v1/machines/:id/scope`; mints the room and pair key, authorizes the machine as a relay agent through `NEKKO_RELAY_AUTHZ_URL`, returns the pairing link to the phone, enforces the egress allowlist and the clone list outside the machine, meters machine hours. Pro and Team. `[updated 2026-11-01]` Plan hours are per account per calendar month (UTC), across all of the account's machines, deleted ones included (`machine_usage`): running time is counted on every state change (stop, a self-stop seen on refresh, start, delete) and by a sweep every 10 minutes, which also stops the machines of an account that has used its hours; create and start answer 402 `hours-used` once the month's hours are gone, and `GET /v1/machines` reports `hoursUsed` for the account.
- **The phone:** pairs with the link as with any computer; `cloud:setScope` (change class, a signed proof) on the machine; the Runs-on picker, the machine page and the Machines list.
- **Lifecycle:** start on first chat; stop after 15 minutes idle (disk kept); delete after 7 days unused or on request.

## Built so far (2026-10-24) and still to do

- **Built:** `apps/nekko-agent-api/src/machines.ts` and `fly.ts` (routes, scope checks, egress host derivation, the Fly Machines driver, a memory driver for tests; migration `0006_cloud_machines.sql`); `apps/local-web-ui/src/relay-agent.ts` takes `NEKKO_PAIR_CODE` (the code Nekko Cloud minted) and `NEKKO_CLOUD_SCOPE` (Privacy Shield pinned on unless the scope turns it off); `nekko-remote`'s `remote:pair` takes a preset code and nekkod sends `NEKKO_RELAY_ACCESS` to the relay's enrolment gate; the Docker image carries `git` and `gh`; the iPhone's `CloudSync` gains `machines`, `createMachine` (pairs the returned link like any computer and remembers which computer the machine is), `setScope`, `stopMachine`, `startMachine`, `deleteMachine`; Settings → Nekko Cloud → **Machines**, New chat → **Nekko Cloud**, and the computer page's *Nekko Cloud machine* and *What the cloud may see* sections.
- **Still to do:** deploying the machines Fly app and the image digest; the relay pointed at `/v1/relay/authorize`; egress enforcement outside the machine (Fly has no per-machine firewall: a proxy sidecar or Fly's private networking plus an allow-listing egress proxy); metering from the machine's own uptime (today the hours count from start to stop as this service sees them, with a self-stop counted when a refresh or the sweep sees it); the idle stop (15 min) and the 7-day delete; cloning the scope's repositories at boot through the GitHub App; the memory copy-up; Android; a run against a real machine.

## Acceptance (to verify when built)

- A chat started with *Runs on: Nekko Cloud* streams, runs tools in the jail, opens a PR on an allowed repository, and never reaches a paired computer.
- A repository not in the scope cannot be cloned; a host not in the egress list is unreachable from the machine; with Privacy Shield on, the provider's request body holds placeholders.
- The machine's disk and Nekko Cloud's database hold no provider key and no chat plaintext.
- Stopping keeps the chat readable on the phone from the synced copy; deleting removes the machine, its disk and its pairing.
