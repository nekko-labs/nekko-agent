---
title: "Nekko Cloud machines: a sandboxed computer the phone pairs with (2026-10-24)"
area: phone
---

# Nekko Cloud machines: a sandboxed computer the phone pairs with (2026-10-24)

`[decided 2026-10-24; planned, nothing built]` **User intent:** use cloud models from the phone with no computer paired, on a sandboxed cloud machine, the way Claude Code on the web and Devin work; and **the phone restricts the data the cloud can see.** Decisions: [0017](../../docs/decisions/0017-nekko-cloud-machines-run-tools-in-a-per-user-jail.md) (the machine and its scope) and [0016](../../docs/decisions/0016-a-phone-carries-a-sealed-provider-key-and-never-holds-one.md) (its provider keys). Design and alternatives: [reports/ios-chat-modernization-2026-10-24.md](../../reports/ios-chat-modernization-2026-10-24.md) §6.

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
- **Nekko Cloud** (`apps/nekko-agent-api`): `POST /v1/machines` (region, size, scope), `GET /v1/machines`, `POST /v1/machines/:id/stop`, `DELETE /v1/machines/:id`, `PUT /v1/machines/:id/scope`; mints the room and pair key, authorizes the machine as a relay agent through `NEKKO_RELAY_AUTHZ_URL`, returns the pairing link to the phone, enforces the egress allowlist and the clone list outside the machine, meters machine hours. Pro and Team.
- **The phone:** pairs with the link as with any computer; `cloud:setScope` (change class, a signed proof) on the machine; the Runs-on picker, the machine page and the Machines list.
- **Lifecycle:** start on first chat; stop after 15 minutes idle (disk kept); delete after 7 days unused or on request.

## Acceptance (to verify when built)

- A chat started with *Runs on: Nekko Cloud* streams, runs tools in the jail, opens a PR on an allowed repository, and never reaches a paired computer.
- A repository not in the scope cannot be cloned; a host not in the egress list is unreachable from the machine; with Privacy Shield on, the provider's request body holds placeholders.
- The machine's disk and Nekko Cloud's database hold no provider key and no chat plaintext.
- Stopping keeps the chat readable on the phone from the synced copy; deleting removes the machine, its disk and its pairing.
