---
title: "iPhone: connectors and pull requests (2026-11-05)"
area: phone
---

# iPhone: connectors and pull requests (2026-11-05)

`[Connectors: implemented 2026-11-05, iPhone only. The connector model (catalog, field checks, each service's sign-in check, Keychain storage, the selected git provider) is tested in NekkoKit (Linux Swift container); the screen builds on macOS CI. Not yet tried against the real services from a device. Android has none of it yet]` `[Pull requests: implemented 2026-11-05, iPhone only. The requests and answers for GitHub (GraphQL), GitLab and Bitbucket, the merge into one list, Projects' repositories, pins, the prompts and where they run are tested in NekkoKit; the screen builds on macOS CI. Not yet tried against the real services from a device]` Decision: [0058](../../docs/decisions/0058-the-iphone-keeps-its-own-connector-tokens.md).

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

- **Where:** **Pull requests** in the chat list's menu. With no git provider connected it says so, with **Open Connectors**.
- **From the selected git provider**, named under the switch (*From GitHub as octocat*). The menu switches provider when more than one is connected, and opens Connectors.
- **Mine / Projects**, a switch at the top (remembered).
  - **Mine:** open pull requests that involve you, each once: **To review** (review requested), **Opened by me**, **Assigned**, with a chip per kind and counts, and **All**. GitHub asks all three in one GraphQL call; GitLab lists created-by-me, assigned-to-me and reviewer; Bitbucket lists the ones you opened.
  - **Projects:** the open pull requests of the repositories your paired computers' project folders hold (a folder whose name, or the last part of its path, is the repository's name, among the repositories the provider lists for you), plus repositories you pin with **Add a repository**. One heading per repository; a pinned one can be removed from its heading.
- **Each row:** repository and number, when it last changed, the title, and badges: **Draft**, checks (passing, failing, running, on GitHub; running or failing on GitLab), **Approved** or **Changes requested**, **To review**, and the author. Filter by title, repository or author from the search field. Pull to refresh.
- **Start a prompt about a pull request**, in one tap:
  - **Tap a row** for its sheet: the branch and what it merges into, then **Start a chat** with **Review it**, **Fix the failing checks** (only when they fail), **Address the review comments** (when changes were requested, or it is yours), **Summarize it**, **Update from the base branch** and **Ask about it**; **Open in browser** and **Share link**.
  - **Touch and hold** a row for the same prompts, Open in browser and Copy link. **Swipe right** to review; **swipe left** to fix failing checks.
  - The sheet says where the chat will run before it starts: the paired computer with a folder named like the repository (the active computer first), in that folder; else the active computer, asking you to pick a folder.
  - A prompt opens **New chat** with the words filled in (naming the pull request's link, repository, number, title and branches) on that computer and folder, keeping New chat's model and tools. Nothing is sent until **Start**. With no computer paired, it says a computer is needed: a chat about code runs where the code is.

## Acceptance criteria

- A token is never written anywhere but the Keychain service `dev.nekkolabs.nekkoagent.phone-connectors`; the saved list holds no token (tested).
- Connect sends nothing until the fields pass their checks, sends the token only to the kind's own https address, and keeps nothing on a refusal, including Linear's errors inside a 200 (tested).
- Settings → Forget everything on this iPhone deletes every connector and its token.
- Pull requests lists only what the selected provider's token can see, asks nothing with no git provider connected, and shows a refusal in the service's words, including GraphQL errors inside a 200 (tested).
- A prompt is never sent by itself: it is New chat's draft, on the computer and folder that hold the repository when one does (tested: the matching, the active computer first, the fallback).

## Privacy and security

- Same model as the phone's own model providers ([decision 0050](../../docs/decisions/0050-the-iphone-runs-chats-on-its-own-cloud-providers.md)): this device only, after first unlock, never synced, not in backups; ephemeral URL session with no cache.
- `connector:connect` and `connector:disconnect` stay refused from phones: the phone never sets or reads a computer's connector.
