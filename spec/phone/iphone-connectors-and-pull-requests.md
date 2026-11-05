---
title: "iPhone: connectors and pull requests (2026-11-05)"
area: phone
---

# iPhone: connectors and pull requests (2026-11-05)

`[Connectors: implemented 2026-11-05, iPhone only. The connector model (catalog, field checks, each service's sign-in check, Keychain storage, the selected git provider) is tested in NekkoKit (Linux Swift container); the screen builds on macOS CI. Not yet tried against the real services from a device. Android has none of it yet]` `[Pull requests: planned, #1776]` Decision: [0052](../../docs/decisions/0052-the-iphone-keeps-its-own-connector-tokens.md).

## User intent

Philip asked (2026-11-05):

- On the phone, a **connectors page** to connect a git provider (GitHub, GitLab or another common one) and common project-management tools (Jira, Linear, Floop).
- A **pull requests** screen, from the selected git provider, showing the pull requests for projects or for the current user, with easy options to **start a prompt about a PR**.

## What the user sees

### Connectors

- **Where:** Settings → Computers → **Connectors**, and **Connectors** in the chat list's menu.
- A line at the top says what happens to tokens: each stays in this iPhone's Keychain and goes only to its own service, never to a computer, the relay or Nekko Cloud, and the computers keep their own connectors.
- **Git providers:** GitHub (an API address for GitHub Enterprise, default `https://api.github.com`), GitLab (gitlab.com or your own instance), Bitbucket (Atlassian API token and the account email).
- **Project management:** Linear, Jira (site, email, API token), Floop (server address and token), Asana, ClickUp, Trello (API key and token), Todoist.
- Each row says what it is for (*Pull requests and checks*, *Your open tasks*) or, once connected, *Connected as* the account the service named. **Connect** opens a sheet with the kind's fields, the token, and where to get it. Connect checks the token with a real call and keeps nothing when the service turns it down, showing the service's own words (*GitHub turned the token down (401): Bad credentials*). An address must be a full https:// address.
- A connected row's menu has **New token** (the same sheet, fields kept) and **Disconnect** (asks first; the token is deleted from this iPhone). Swipe also disconnects.
- With more than one git provider connected, **Pull requests from** picks the one the Pull requests screen reads; otherwise it is the one connected.

### Pull requests

Planned in #1776; this file is updated when it lands.

## Acceptance criteria

- A token is never written anywhere but the Keychain service `dev.nekkolabs.nekkoagent.phone-connectors`; the saved list holds no token (tested).
- Connect sends nothing until the fields pass their checks, sends the token only to the kind's own https address, and keeps nothing on a refusal, including Linear's errors inside a 200 (tested).
- Settings → Forget everything on this iPhone deletes every connector and its token.

## Privacy and security

- Same model as the phone's own model providers ([decision 0050](../../docs/decisions/0050-the-iphone-runs-chats-on-its-own-cloud-providers.md)): this device only, after first unlock, never synced, not in backups; ephemeral URL session with no cache.
- `connector:connect` and `connector:disconnect` stay refused from phones: the phone never sets or reads a computer's connector.
