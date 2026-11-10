---
status: proposed
date: 2026-11-10
---

# 0078. Make a profile a scope below the data folder, enforced in the daemon

## Context

Profiles ([spec](../../spec/platform/profiles.md)) let one account keep separate chats, settings, permissions, connectors, repositories and folders. The hard requirement is that a model running in one profile cannot reach another profile's content.

Today everything sits flat in one data folder. `nekkod` builds every store from a single `data_dir`, `settings.json` holds one list each of folders, providers, connectors and MCP servers, secrets are namespaced by the data folder's path, and the tool jail's roots are the folders in settings plus the whole data folder. There is one daemon per data folder, held by a process lock.

## Options considered

1. **One data folder per profile.** Start a separate `nekkod` (and Electron user-data folder) per profile, as `NEKKO_DATA_DIR` already allows. Isolation comes free from what exists. But downloaded models would be duplicated or need a shared store bolted on, a second engine would compete for the same GPU, background agents in the other profile need a second daemon running, the phone would pair with each one separately, and one Nekko account per folder contradicts "under the same account".
2. **A profile id column in the existing flat stores.** Add `profileId` to each record and filter on read. The least code moved. But isolation then depends on every query remembering the filter, forever, and a missed filter leaks silently. Files on disk are mixed, so encryption per profile and deleting a profile are both hard.
3. **A scope below the data folder, in one daemon.** A `profiles/<id>/` folder per profile holding everything personal, a machine level above it for what holds no content, and a `ProfileScope` handle that is the only way to open a per-profile store or run a tool.

## Decision

Option 3. One daemon and one engine serve every profile, so models, the GPU, the account and paired devices are shared without duplication, while the content boundary is structural: a store is opened from a scope's folder, so code without the scope has no path to the data. The tool jail gains a deny set (other profiles' data and folders) checked before any sandbox mode and never offered for approval. Each profile's data is encrypted at rest with its own key, and agent commands move into an OS sandbox, because a shell command runs as the OS user and no in-process check contains it.

## Consequences

- Every `data_dir.join(...)` call site is sorted into machine level or profile level; a lint keeps new ones honest. This is the bulk of phase 1.
- A one-way, journaled migration moves an existing install into a profile named Personal. Older builds refuse a migrated folder.
- `settings.json` splits into machine and profile files; the shared TypeScript types and every settings screen follow.
- MCP servers and connector clients run once per profile, which costs memory when the same server is configured in two profiles.
- The shell boundary is delivered in steps (a non-approvable guardrail, then encryption at rest, then the OS sandbox). Until the sandbox ships, another profile's own folders are protected from the file tools but only by a best-effort check from shell commands, and the product has to say so.
- The daemon can read every profile. A person at the unlocked computer can open every profile. Neither is in the threat model; a per-profile lock is a possible later record.
- We will know this was wrong if the canary suite cannot be kept complete as stores and tools are added, or if one daemon serving background agents for several profiles degrades the speed contract.
