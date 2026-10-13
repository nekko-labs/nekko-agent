# Nekko Agent walkthrough

A guided tour of Nekko Agent, from install to your first agentic edit. Screenshots
are from the running app.

- [1. Install](#1-install)
- [2. Connect a model](#2-connect-a-model)
- [3. The unified chat](#3-the-unified-chat)
- [4. The Context Inspector](#4-the-context-inspector)
- [5. Guardrails & sandbox](#5-guardrails--sandbox)
- [6. Projects & the codebase index](#6-projects--the-codebase-index)
- [7. Memory](#7-memory)
- [8. Connectors](#8-connectors)
- [9. The mascot](#9-the-mascot)

---

## 1. Install

**Download a build** for your platform from the
[Releases page](https://github.com/nekko-labs/nekko-agent/releases/latest):

| Platform | Artifact |
| --- | --- |
| Windows | `NekkoAgent-<version>-x64.exe` (NSIS installer) |
| macOS | `NekkoAgent-<version>-arm64.dmg` (Apple Silicon) |
| Linux | `.AppImage` or `.deb` |

**Or run from source:**

```bash
git clone https://github.com/nekko-labs/nekko-agent
cd nekko-agent
npm install
npm run dev          # launches the desktop app
```

Nekko Agent stores everything locally (under your OS app-data dir): settings,
sessions, memory, and a usage log. No account, no telemetry.

---

## 2. Connect a model

Open the **Models** tab. This is where Nekko Agent differs from most tools, local
model servers are first-class, not an afterthought.

![Models tab](screenshots/models.png)

- **Auto-discover local** probes `localhost:11434` (Ollama), `:1234` (LM Studio),
  and `:8000` (vLLM). Anything running is added with one click.
- **Add provider** lets you configure a server manually, or add a cloud provider -
  Anthropic, OpenAI, OpenRouter, or any OpenAI-compatible endpoint (just paste the
  base URL + key).
- For **Ollama**, you can **pull** new models and **load / unload** them into memory
  right from the card.
- The **Token usage** panel charts input/output tokens over time and breaks them
  down per model and per provider.

> Tip: set a default provider + model in Settings so new chats start ready to go.

### Example: connect an LM Studio server

1. In LM Studio, load a model and start its server (Developer → Start Server).
2. In Nekko Agent: **Add provider → LM Studio**, set the **Base URL** to your server,
   e.g. `http://10.5.0.2:1338` (you can paste just `host:port`, Nekko Agent appends
   `/v1` automatically). No API key needed.
3. **Test connection** → the model dropdown fills with whatever LM Studio is serving.
4. Pick the model in the chat header and go.

**Reasoning models** (Gemma, DeepSeek-R1, Qwen-thinking, etc.) are first-class:
their chain-of-thought streams into a collapsible **Thinking** block above the
answer, so you see progress during long reasoning and the answer stays clean.

---

## 3. The unified chat

The **Chat** tab is the heart of the app. There are no separate "chat", "cowork",
and "code" modes, it's one thread. Ask a question, or hand off a task and let
Nekko Agent act on your machine through tools (read / write / edit files, glob, grep,
list dirs, run shell commands).

![Unified chat](screenshots/chat.png)

- Pick the **provider and model** from the header dropdowns at any time.
- Assistant messages render **markdown and code**; every **tool call** the model
  makes shows up as a card so you can see exactly what it did.
- Streaming is live; hit **Stop** to abort a turn.

**Keyboard shortcuts**: Nekko Agent has a command palette (think Cmd-K everywhere):

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + K` | Open the command palette |
| `Ctrl/Cmd + N` | New chat |
| `Ctrl/Cmd + \` | Toggle the context panel |
| `Ctrl/Cmd + Shift + E` | Complete the focused agent chat |
| `Ctrl/Cmd + Shift + M` | Minimize the focused agent or terminal board window |
| `Ctrl/Cmd + Shift + Delete` | Delete the focused chat or close its terminal, with confirmation |

![Command palette](screenshots/command-palette.png)

---

### Add windows and read the dock

The Agents toolbar ellipsis opens an anchored dropdown with horizontal **Chat**, **Media** and **Terminal** categories. Narrow widths can scroll the categories horizontally. Opening the dropdown does not move wall tiles, resize the wall or change its layout mode. Escape, Close or an outside pointer dismisses it; pending creation prevents dismissal and double activation. This replaces the prior inline Add-tile reveal.

Utilization shows a Claude subscription account once when provider entries share the same token key, preferring the Anthropic entry. Independent accounts and API entries remain separate. In Budget, choose today, 1wk, 1m, 6m, 1y or all-time; the active range is tinted. Spend, tokens, top agent, local tokens, savings and compared model membership all follow that UTC range, not lifetime totals. See [usage limits and prices](/docs/usage-limits).

These 2026-10-13 changes are implemented and unit/fixture interaction tested. Matching captures exist, but image/motion inspection remains pending; earlier walkthrough pictures are not visual proof of this batch.

### Complete, minimize, and delete

Hover a window's lifecycle buttons to see the action and hotkey. Shortcuts target the window you are using, not every chat. **Complete** keeps the chat under its group's **Show completed** control in the left Agent panel for 60 days. **Minimize** removes only the board window: the item remains in the Agent panel, and a terminal keeps running. Terminals do not have completed history; **Close** ends their process.

Settings has **Show tips**, enabled by default. Your first successful completion highlights Show completed with a dismissible explanation. On a narrow screen, the existing agent list drawer opens automatically to reveal Show completed without taking focus. If you close it, the highlighted Agents button lets you return to the destination. Opening or closing the drawer does not dismiss the tip. Turning tips off does not disable deletion warnings. The in-app delete dialog offers **Skip future deletion confirmations**; only choose it if you want permanent deletions without another prompt. Re-enable **Confirm deletions** in Settings at any time. General chats no longer display a redundant missing-project label.

### A composer that follows your draft

In the Command Center, one docked composer targets the selected agent window.
Click another agent window to write in that chat's context, or use the dock picker
to move the composer above or below the wall.

The reply editor grows with new lines and wrapped text, then shrinks when you
delete them. In the bottom dock it grows upward, leaving the agent board above
it in its own scroll area. Once the draft reaches the height cap, only the editor
scrolls; the header, send controls, queued prompts, images and skill rows stay
inside the composer ring. A saved manual height remains a preferred minimum,
not a ceiling that prevents a longer draft from growing.

### Follow delegated work without opening every detail

Delegation cards start collapsed, including while a child is working or returning
a large result. Their compact, plain-text activity sentence shares its status
with the plan's sub-agent list and the working-subagent indicator:

- **Working**: the child is thinking, writing or using a tool.
- **Waiting**: it needs an answer or approval, or is waiting to retry.
- **Completed**, **Failed** or **Stopped**: recorded terminal events, not guesses
  based on the presence of a stored reply.

Expand a card to read the full task and result in bounded scroll areas. This does
not resize the entire agent window. Summaries use existing local events, without
an extra model request or additional transmission.

Live card-to-child matching is best effort, using the parent, title and creation
time. There is no authoritative spawn-call child ID yet. Ambiguous matches and
historical calls without observed events do not borrow another child's status;
they retain a task summary or report that no current run status is recorded.

### Plan and capacity at a glance

The plan icon in an agent window opens or closes only that chat's plan, sub-agents and queue panel. Each chat remembers its own choice locally. Narrow windows fold the panel automatically without changing that choice.

The context-window gauge has a subtle green background below 60% full, yellow from 60% to below 85%, and red at 85% or higher. Counts remain estimated; an unknown window limit stays neutral.

In Agents, the Hardware panel names each detected GPU and shows its own utilization. Missing readings say Unavailable rather than zero; switching monitoring off says Monitor off. VRAM remains the aggregate memory reading across devices.

## 4. The Context Inspector

The right-hand panel (toggle it with the panel icon) is Nekko Agent's signature
feature. It shows **exactly what is entering the prompt this turn**, grouped by
where it came from:

- **Guidelines**: `AGENTS.md` / `CLAUDE.md` / `.cursorrules` detected in your
  workspace folders
- **Files**: anything you've attached
- **Memory**: relevant global / per-project notes
- **Connectors**: issues, messages, or docs pulled in from Linear/Slack/etc.

Each item shows a **token estimate**, can be **toggled off** to exclude it, or
**pinned** to always include it. The bar at the top shows how much of the model's
context window you're using. No more guessing what the model "saw", you can see
and shape it.

---

## 5. Guardrails & sandbox

Open **Settings**. Two layers keep Nekko Agent from doing something you didn't intend.

![Guardrails & sandbox](screenshots/guardrails.png)

**Sandbox mode** controls how the agent may touch your machine:

| Mode | Behavior |
| --- | --- |
| Workspace jail *(default)* | File access confined to your added folders |
| Ask everything | Every write or command requires approval |
| Docker | Run shell commands inside a container if Docker is present |
| Off | No restrictions (power users) |

**Guardrails** classify risky shell commands and decide whether to **allow**, **ask**,
or **deny**, per rule, each toggleable. Ships with sensible defaults: recursive
force-delete, raw disk writes, `git push --force`, `curl | sh`, privilege
escalation, secret/`.env` access, and more. When a command matches an "ask" rule,
the chat shows an **approval bar** with the exact command and its severity before
anything runs.

---

## 6. Projects & the codebase index

The **Projects** tab manages your workspace folders, and yes, **multiple roots**
are supported. Each folder is indexed for files and code symbols (functions,
classes, interfaces, types) so the agent and search have a fast map of your code.

![Projects & index](screenshots/projects.png)

- **Add** a folder and it indexes in the background.
- See **file + symbol counts** and index status per project.
- **Search** across the indexed files instantly, or browse the file list with
  per-file symbol counts.

---

## 7. Memory

The **Memory** tab is a simple, durable knowledge base stored as plain markdown.
Keep **global** memories (preferences, conventions) and **per-project** memories.
Relevant entries are surfaced in the Context Inspector and injected automatically,
so Nekko Agent remembers how you like to work across sessions.

---

## 8. Connectors

The **Connectors** tab links external sources so their content can be pulled into
context: **Linear**, **Slack**, **Discord** (token-based), and **Gmail** /
**Google Drive** (OAuth). Tokens are stored locally. Connect one, fetch a sample
to confirm it works, and the results become available to the assistant.

---

## 9. The mascot

**Nekko Agent** is the 8-bit cat that lives at the edge of the window. It waves to say
hello, peeks in from the side, and **"makes cat biscuits"** (kneads its paws) while
the model is thinking. Don't want it? Toggle it off in Settings → Appearance.

---

## 10. Appearance and page recovery

Nekko Agent starts in your system's light or dark mode. Leave the theme on
**System** in **Settings → Appearance** to follow system changes, or choose a
light or dark preset to keep that look. The pixel Nekko in the desktop's top
bar stays the same as you move between pages; the heading names the page.

If Settings or Nekko Server cannot load, the page shows the problem and a
**Try again** button. On desktop, start a stopped service from the tray menu,
then retry. In the web edition, check that the Nekko service is running.
Existing content stays visible when a refresh fails.

If a page or section cannot be displayed, use its **Try again** button to
reopen it. Navigation stays available so you can move to another page. If the
problem persists, include the displayed error and your app version and OS in
a GitHub issue.

---

Questions or ideas? Open an issue on
[GitHub](https://github.com/nekko-labs/nekko-agent/issues).
