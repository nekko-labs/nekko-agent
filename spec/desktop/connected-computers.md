---
title: "Connected computers (link and host class implemented 2026-11-02)"
area: desktop
---

# Connected computers (2026-11-02)

Issue: [#1492](https://github.com/nekko-labs/nekko-agent/issues/1492). Decision: [0040](../../docs/decisions/0040-a-desktop-is-a-paired-device-with-its-own-class.md). Design: [connected computers](../../docs/superpowers/specs/2026-11-02-connected-computers-design.md).

## Intent

One desktop runs and watches every agent its owner has, wherever each one runs. Where the agent runs and where the model runs are separate choices.

## Pairing

`[implemented 2026-11-02; two real daemons through a stand-in relay, not yet between two machines]`

- **Settings > Computers** lists the computers this one reaches, with their state and how each is reached. **Add a computer** takes a pairing link. **Make a link**, under *Let a computer connect to this one*, makes one that works once, for 10 minutes. It needs Phone pairing set up, which chooses how other devices reach the computer.
- Connecting works one way. Pairing the MacBook to `gomi` lets the MacBook drive `gomi`, never the reverse.
- A phone's link refuses a computer and a computer's link refuses a phone, with what to do next.
- A computer stays paired across restarts of either side and reconnects by itself: nearest route first (LAN, tailnet, relay), retrying as a phone does. Revoking it on the host stops the link for good.
- Removing a computer signs it out of the other computer when that computer can hear, and deletes what was kept here. Its agents keep running there.
- **Connections** has a *Connected computers* row. Off, or with All connections off, every link closes within 30 seconds and the computers read as offline.

## Agents from every computer

`[implemented 2026-11-02; engine proved with two real daemons and a scripted model, window checked with fixtures, not yet on real machines]`

- **One list.** Every connected computer's agents appear in the Agents panel beside the local ones, live. The list paints from what each computer last said, so a slow or dead machine never holds it up, and an offline computer's agents stay visible.
- **Where it runs.** A card on another computer names it on its provider line, and its wall window names it on the title strip. An approval's button reads *Approve on gomi*. A local agent shows nothing: with a second computer, the absence reads as "here". Show > Computer turns the card label off.
- **Group by Computer** in the view menu, shown once a computer is connected. Activity stays the default. Group by Project keeps same-named projects on two computers apart, since they are different checkouts.
- **Offline and watching only.** The composer says why it can't send (*gomi is offline*, *gomi allows watching only*), and a message that can't go stays in the box. The run carries on over there, and reconnecting catches up on a reply under way.
- **Icons.** A computer can have one of 24 icons, set under Settings > Computers. It lives in that machine's own settings (`machineIcon`), so every desktop connected to it shows the same one. With none set, nothing shows. Cards and group headings show it; Show > Computer icons turns that off. Phones don't show them yet.

**How ids stay out of the way.** A chat, folder or provider on another computer has the id `@<computerId>:<rawId>`, opaque to the window. The engine sends a call carrying one to that computer and qualifies what comes back. A channel that may cross is listed in `federation::ROUTED`; a foreign id on any other is refused, so a new channel can't reach the local store with one. Another computer's events travel on a stream only the desktop window's socket hears, never this computer's phones, API server or automation. The CLI's API and the Local Web UI see this computer only.

## Start and monitor

`[implemented 2026-11-02; picker and engine tested, not yet on real machines]`

- **Run on.** New chat gets a *Run on* row once a computer is connected, as on the iPhone. Choosing one swaps the model list to that computer's models and subscriptions, and the folder list to its folders, and picks its first model so starting there is still one click. A computer that is offline, or that allows watching only, can't be chosen. A chat started there has one working folder; supporting folders stay a local feature for now.
- **Monitors.** A switch in the dock points the Hardware monitor at a connected computer. Local models and Utilization still read this one.

## Where the model runs

`[implemented 2026-11-02; two real daemons and a scripted model, not yet on real machines]`

Where the agent runs and where the model runs are separate choices. Whichever computer runs the agent can use its own models and subscriptions, a connected computer's Model Server, or a cloud provider. A rented box with a plain model server is an OpenAI-compatible provider, as it always was.

- **A connected Model Server is a provider here.** Each connected computer adds *gomi Model Server* to this computer's providers, so a chat's model picker lists it, and a phone connected here can pick it too. It reaches that computer over the same sealed link, on LAN, tailnet or relay, with no change to the Model Server's `bind` or key.
- **Only the engine crosses.** Three paths: chat completions, embeddings and the model list. It never reaches a local runtime, a provider or Claude Code, so a subscription stays on the computer it signed in on.
- **It counts as off this computer.** An Offline chat, a local-only task and a local-only workflow refuse it, and Privacy Shield applies to it, though its address here is loopback. It never starts a Model Server its owner stopped: *Start with Nekko* is what lets it.
- **Model Server settings.** *Let connected computers use these models* removes that provider elsewhere when off. *Connected devices choose model settings*, off, means the server's saved settings decide: a request keeps what it asks and loses how to sample, and devices can't load, unload or change how models load. A request can still name a model, which loads it, as on the server's own address. Both are on by default, and neither can be changed from another device.
- A chat using a model on another computer stops if that computer goes away, with *gomi went offline during this reply*. Its transcript is kept here.

## Every run setting, from any client

`[gate implemented 2026-11-02 for phones and computers; the phone section built on iOS and Android; model-loading controls not built on any client]`

- A phone or a desktop can set everything `setSessionOptions` takes on the computer running a chat. The phone's model sheet has *Run settings*: choosing the model automatically, offline, cloud only, incognito, a separate Git branch, work mode and tool style.
- **Options that change what an agent may touch or where its data goes need the same proof as raising a mode, in either direction:** execution mode, Git isolation, disabled tools, MCP servers and connectors, memory, guidance, privacy, offline, cloud only and incognito. A fork keeps its chat's offline, cloud-only, privacy and incognito settings, since it carries the transcript.
- `chat:send` also takes videos, a history limit and no-tools. Attaching a path on the host stays refused.
- How a Model Server loads and keeps models is open to devices while it allows it (`maxLoaded`, `idleTtlSeconds`, `jitLoad`, `autoload`, `autoStart`, presets, loading a model). `port`, `bind`, `apiKey`, `corsOrigins`, the model folders and the two settings above stay on the machine, because they open it to its network or decide this rule.

## A host with no window

`[implemented 2026-11-02; CLI logic tested, not yet run on rented compute]`

`nekko-agent computer serve --relay <wss://…>` keeps a computer reachable with no desktop app, and prints the link for Settings > Computers. Running it again prints a new one. `computer list` and `computer revoke <device>` work while it is stopped, since one engine uses the data folder at a time. A rented box, or a Mac Studio with nobody logged in, is then a computer like any other.

## What a computer may do

`COMPUTER_ACCESS` adds to what a phone may do: reading tool output whole, older messages (`session:page`), a running turn so far (`agent:replay`), compacting, truncating, taking back a queued message, and accepting changes. A chat too large for one relay frame has its tool text cut. The host's Read and Change switches, activity list and revocation work as for a phone, and a mode raise still needs a signed proof, plus step-up where it is on.

Refused from a computer, always: provider keys and sign-ins, sync, remote-access settings, wiping data, terminals, SSH, adding a folder by path, and attaching any file it did not import into that chat.

**Connecting is equivalent to being at the machine.** Those refusals cover what a computer can call directly. It can still run a chat in YOLO mode, and that agent can do anything the logged-in account can. The UI and `docs/REMOTE.md` say so.

## Status

Phases and what is left: `TASKS.md`, section *Connected computers*.
