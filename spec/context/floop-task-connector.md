---
title: "Floop task connector"
area: context
---

# Floop task connector

`[implemented 2026-10-22: catalog card, Rust fetch with golden cases, Tasks tab source; agent write-back through Floop's own MCP server]`

**User intent:** Nekko Labs tracks its work in Floop ([nekko-labs/floop](https://github.com/nekko-labs/floop)), a work tracker where people and agents keep separate streams and every agent acts under its own identity. Philip asked for Nekko Agent to show up there as an agent that can pick up, update and finish its own tasks, and for Floop to appear among Nekko Agent's task connectors.

**What ships:**

- **Connector card.** Floop is a `category: 'tasks'` connector in the catalog. It takes the server URL (`settings.url`) and an API token (`flp_…`), ideally an agent token minted for Nekko Agent in Floop's Settings so its reads show under its own name. Connect stays disabled until both are filled in.
- **Reads.** `nekko-connectors` fetches `GET <url>/api/v1/items?assignee=me&open=true&limit=100` (plus `&q=` for a search) with `Authorization: Bearer`. Each open task becomes a resource titled `#<number> <title>`, with a subtitle naming the stream (task or agent task), status and project, a link to the task page, and its notes as the body. Floop shows in the Agent Monitor's Tasks section like the other task systems.
- **Writes.** Claiming, progress notes, finishing and handing a task to a person go through Floop's MCP server (`floop mcp --profile <agent>`), added under Settings → MCP servers, so every write passes Nekko Agent's normal tool approvals. The connector itself only reads, like the other task connectors.

**Boundaries:** the server URL must be https, except `localhost`, `127.0.0.1` and `[::1]` for a local Floop. The token is stored like every other connector token. Nothing is sent to Floop beyond the read request and the user's search text.

**Verified:** golden cases for a search with two tasks (one in the agent stream, one with a project), a missing URL, a non-https URL and a rejected token; the shared catalog and the automation catalog stay in step (engine-data golden test). Floop's MCP server was run through `nekkod`'s own MCP client against production (11 tools listed; calls answered as @nekko-agent).

**Not verified:** a live fetch from the packaged desktop app against production; Floop write-back through the connector itself (not planned while MCP covers it).
