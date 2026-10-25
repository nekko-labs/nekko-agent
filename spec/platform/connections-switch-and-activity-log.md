---
title: "Connections: one switch for every network connection, and its activity log"
area: platform
---

# Connections: one switch for every network connection, and its activity log (2026-10-24)

`[implemented; unit-tested (engine switch, log, path scrubbing, chats forced Offline, Settings card, browser guard); not yet checked in the packaged app, the Local Web UI or against live services, and no visual evidence yet]`

**User intent:** see every inbound and outbound connection Nekko Agent makes, switch them all off at once or one by one, and read how often each one talks to the network to debug it ([#1034](https://github.com/nekko-labs/nekko-agent/issues/1034)).

- **Settings > Connections** is its own item in the Settings nav, between Safety and Tools. It lists every connection besides the UI talking to its own engine, in three groups:
  - **In the background:** app updates, provider model lists, skills catalog, Nekko Cloud, phone relay, plan and limit checks, connectors, decision models, usage and crash reports, GitHub pull requests, Telegram.
  - **Incoming:** API server, model server on your network, relay on this computer, Visible on this network, workflow webhooks.
  - **When you or an agent asks:** cloud model providers, provider sign-in, models and runtimes, skill sources, web tools, MCP servers, the in-app browser, Send feedback, resource queue.
- **All connections off** makes the app fully offline:
  - Nothing reaches or leaves this computer over the network.
  - Every chat runs as Offline: only local models on a loopback address answer, and online and MCP tools are removed.
  - Incoming listeners close; the model server stays on 127.0.0.1.
  - Loopback stays allowed, so local models, local runtimes and the UI keep working.
- **Each row has its own switch.** A row that is off is blocked everywhere, loopback included. The row switches are greyed out while All connections off is on.
- **The row switch is a block on top of the feature's own setup.** Updates, Remote access, Sync and the others keep their own switches, which decide whether the feature runs at all. The Connections switch decides whether it may use the network.
- **Each row shows** when the connection was last used, how many contacts it made in the last 24 hours, and how many failed or were blocked. **Show log** opens its recent events, newest first: time, method, host, path, status, duration, bytes and error.
- **Privacy:**
  - The log never records a body, header, token or query string.
  - Path segments that look like secrets are replaced with `…`, such as Telegram's `bot<id>:<token>` or any run of 24 or more letters and digits.
  - The card says that Nekko Agent sends no usage or crash reports unless they are turned on ([opt-in reports](opt-in-usage-and-crash-reports.md)); those appear here as **Usage and crash reports**.
- **Storage:** events are kept 200 per connection in memory, and in `<data>/logs/connections.log`, which rotates at 2 MB and keeps 2 older files (about 6 MB at most). They are reloaded at startup. **Clear connection logs** empties both.
- **Default:** everything allowed, as before. Nothing changes until someone flips a switch.

## Not covered

- **Commands an agent or you run in a terminal** (curl, npm, git in a shell) use the computer's network directly. All connections off removes online tools from chats but does not sandbox the shell. For that, use the Docker sandbox or turn the network off.
- **The in-app browser and the agent's browser windows** are blocked by Chromium's own request filter in the desktop app, but are not logged.
- **A model server already listening on the LAN** moves to 127.0.0.1 the next time it starts; it is not restarted when the switch flips.

Decision: [0020](../../docs/decisions/0020-one-network-switch-enforced-in-the-engine.md). User docs: [docs/connections.md](../../docs/connections.md).
