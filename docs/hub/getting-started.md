# Getting started

Nekko Agent is AI help on your computer, for coding and everyday work. It reads, edits, searches and runs things in your projects, using AI that runs on your own machine, an online service you already pay for, or both. It is free, open source and MIT licensed.

## Who we are

Nekko Agent is made by [Nekko Labs](https://nekkolabs.com). We develop it in the open on [GitHub](https://github.com/nekko-labs/nekko-agent): the code, the plan and the task list are all public.

We care about three things:

- **Your computer, your choice.** You pick which AI runs, what it can touch and when it needs your approval. Work that uses only local models stays on your machine.
- **Honest software.** The app tells you what a model will cost, whether it will fit in memory and what it is about to do. These docs mark what is planned as planned.
- **Fast and calm.** The interface never waits on the agent, and responsiveness is measured on every change.

## What Nekko Agent does

- **Use AI on your computer or online.** Run models with the built-in engine, connect Ollama, LM Studio or vLLM, or sign in with a ChatGPT subscription. Mix them in one workspace.
- **Pick the right AI for each job.** Use a capable model for hard work and a small local one for simple tasks. Local models have no per-token bill.
- **Work in your real projects.** The agent reads, edits and runs code in the folders you add, with diffs to review, guardrails and an optional sandbox.
- **Automate repeat work.** Schedule tasks and save workflows, with retry limits and a visible history.
- **Take it with you.** Pair your phone to drive the agent on your computer from anywhere, end-to-end encrypted.
- **Plug it into your tools.** Use it from the terminal, or as an MCP server inside Claude Code, Codex, Cursor and other agents.

## Install the app

The quickest way to start is the installer.

1. Download the installer for your computer from [nekkoagent.com](https://nekkoagent.com/#download) or the [latest GitHub release](https://github.com/nekko-labs/nekko-agent/releases/latest):
   - **Windows:** the `.exe` installer
   - **macOS (Apple silicon):** the `.dmg`
   - **Linux:** the `.AppImage`, or the `.deb` for Debian and Ubuntu
2. Run it. On macOS, drag Nekko Agent into Applications.
3. Open Nekko Agent, add a project folder and choose a model on the **Models** tab.

macOS builds are signed and notarized, so they open normally. If Windows shows an "unknown publisher" prompt for an unsigned build, choose **More info**, then **Run anyway**.

## Typing in a new agent window

A new chat greets you with “What should we work on?” and a small pixel Nekko peeking beside it, looking toward the heading. Type your request in the composer below. The new-chat surface slowly fades through teal/gold, violet/rose, blue/mint and rose/amber palettes over two minutes. Reduced motion holds the colors still. Themes with moving dots show them only here, not behind existing conversations. Context menus use a neutral light or dark background with accent-colored highlighted rows. Switching to a chat also highlights and reveals its row in the Agents panel.

Opening an agent composer puts the caret after any restored draft once a usable model provider is available. If you are already typing in another visible text field, that field keeps focus. Normal background agent and provider updates do not pull you back into the composer.

## Following tool activity

The agent's plan sits on top of the message box as a card. Each step shows its title, one line of detail, and chips for what that step produced: the PRs the agent opened (with their CI status) and the files or previews it linked. Finished steps shrink to their title; hover the card to see their details. **Change plan** tells the agent what to do differently.

Chat tool calls use icons for what the agent is doing: reading files, searching, editing, running checks, Git, web access or planning. Shell execution, including Python, uses the same terminal artwork as the current-work indicator. Transcript icons stay still; expand a tool row to read its output. Unknown tools keep the generic tool icon.

## Run it from source

Running from source gives you the newest code and is how you work on Nekko Agent itself. It takes four steps: install the prerequisites, clone the repo, install the dependencies, and run `npm run dev`.

### 1. Install the prerequisites

You need three tools. Check what you already have:

```bash
git --version
node --version
cargo --version
```

**Git.** Any recent version. Get it from [git-scm.com](https://git-scm.com/downloads), or on macOS run `xcode-select --install`.

**Node.js 22.12 or newer**, which includes npm. Install the LTS release from [nodejs.org](https://nodejs.org), or use a version manager such as [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm). The project uses npm workspaces, not pnpm or yarn.

**Rust**, through [rustup](https://rustup.rs). The engine daemon (`nekkod`) is written in Rust and `npm run dev` compiles it. You do not need to choose a version: the repo pins one in `rust-toolchain.toml` and rustup installs it on the first build.

```bash
# macOS and Linux
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

On Windows, download and run `rustup-init.exe` from [rustup.rs](https://rustup.rs).

Rust also needs a C and C++ toolchain on each platform:

| Platform | Install |
| --- | --- |
| Windows | Visual Studio Build Tools with the **Desktop development with C++** workload (rustup offers to install it) |
| macOS | Xcode Command Line Tools: `xcode-select --install` |
| Debian, Ubuntu | `sudo apt install build-essential pkg-config libssl-dev` |
| Fedora | `sudo dnf install gcc gcc-c++ make pkgconf-pkg-config openssl-devel` |

On Linux, the engine's model runtime needs the GCC 13 C++ runtime or newer (Ubuntu 24.04, Debian 13 or later).

### 2. Clone the repo

```bash
git clone https://github.com/nekko-labs/nekko-agent
cd nekko-agent
```

### 3. Install the dependencies

```bash
npm install
```

### 4. Start the app

```bash
npm run dev
```

This builds the Rust engine daemon and the app, then opens the desktop app. The first run compiles the daemon in release mode and takes several minutes; later runs only rebuild what changed.

To stop it, press **Enter** or **q** (or Ctrl+C) in the terminal. The app quits normally and stops the engine and any model servers it started.

### Other ways to run it

| Command | What it does |
| --- | --- |
| `npm run web` | The same app in your browser at `http://localhost:1440` |
| `docker compose up` | The Local Web UI inside Docker, with your workspaces mounted as volumes |
| `npm run build` | Build everything without launching |
| `npm test` | Run the tests in every workspace |

## Next steps

- Take the [walkthrough](/docs/walkthrough) for a tour of the app.
- Set up [local models](/docs/local-models) or [sign in with a subscription](/docs/subscriptions).
- [Pair your phone](/docs/remote) to use the agent away from your desk.
- Want to help build it? Read [Contributing](/docs/contributing) and the [architecture](/docs/architecture).

### Closing the desktop UI and notifications

Closing the desktop window hides it to the tray; the engine and running work remain alive. This is not Quit. **Quit Nekko Agent** stops the service and managed processes; **Stop Nekko service** stops the service while leaving the UI available. This does not promise execution during OS sleep, shutdown or logout.

**Settings > Notifications > Desktop notifications** is on by default. The desktop's main process listens independently of the page for completed replies, failures, questions and approvals. A user Stop is not a failure. Clicking a native notification restores the UI and opens the chat. Turn the toggle off to opt out; notices can include the chat title and question, error or approval text. Browser editions use browser notification permissions instead.

The 2026-10-13 batch is implemented and unit/fixture interaction tested, not yet landed. Image inspection and native toast delivery/click/permission testing remain pending. Known issue under review: the native listener currently also posts for a focused visible chat.

### Create an agent, media session or terminal

Hover over the left navigation panel, including its curved top and bottom wings, to open it and see each destination's name. Keyboard focus opens the same panel; reduced motion disables its width and label transitions. On macOS, **Nekko Agent → Settings…** (⌘,) opens Settings and **About Nekko Agent** shows the About page.

Hover over the sidebar **+** to choose **Agent**, **Create or Edit Photos and Videos** or **Terminal**. Moving away closes the menu after a short grace period. Terminal uses your default shell; choose its type in **Settings → Terminal → Default shell**, or leave **Auto-detect** selected. Create or Edit Photos and Videos opens an image session; video generation is not available.

### Approvals and delegated work

When a tool needs permission, its approval card appears in the chat window, not the separate wall composer. An unrelated tool finishing does not dismiss that request. Read the exact input before choosing Approve or Deny.

For an identified subagent, **Open ↗** beside its activity row opens the child chat using the existing workspace navigation. The chevron still expands task details separately. If the app cannot safely associate a delegation with one child (including older activity after a restart), use the Agent Monitor subagent list instead; the row does not guess which chat to open.

### Quickly filter the model picker

At the top of the model picker, use **All**, **Fusion**, **Cloud**, or **Local**.
All shows every available model and Auto; Fusion shows Auto routing; Cloud and
Local narrow the list to those providers, including favorites and your default.
Filtering does not select a model or change the chat's mode. Fusion is unavailable
where Auto routing is not supported, such as a fixed-model workflow step.

### Delegated agents in the Agents panel

Delegated subagents appear as compact rows beneath their parent. Opening a child transcript does not add a duplicate full agent card. Closing the parent's windows keeps the saved parent and its nested children accessible.

A turn's working steps fold into one work group whose header says what the agent did, by purpose: for example *Read guidance, looked through the code, edited 3 files*. Hover or keyboard-focus the header to read the complete summary and each purpose group with its number of calls. Click the header to open the steps. Inside it, adjacent calls with one purpose are one row that states the goal, such as *Read the project's guidance · AGENTS.md, CLAUDE.md* or *Ran the tests · passed*. When a call gave its own description (Claude Code's commands do), that description is the goal. Click a group to see its individual calls. A call waiting for your approval, a question for you, and a lone call stay rows of their own. A group with a failed call says *1 failed* and stays open.

### Answering agent questions

When an agent needs a choice, its question opens at the bottom of the conversation. Scroll the conversation to read the reply and question together; the question has no separate scrollbar. Choose an option or type something else, then send your answer. Multiple questions show one step at a time, with Back and Next. The pixel question-mark icon identifies the question.

### Agent panel shortcuts

Click the plus button in the Agents panel to open a new agent window. Hover over it for the Agent, Photos and Videos, and Terminal choices. Terminals and photo/video projects appear in separate groups at the top of the panel only when there are items to show.

The Agent Board header also has a single **+**: hover or click it for the same three choices. Both menus use a neutral light/dark background and highlight the hovered or keyboard-focused row in your primary color. The shortcut appears beside every choice:

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| New agent | Cmd+T | Ctrl+T |
| New photo/video session (image tools available; video planned) | Cmd+Shift+I | Ctrl+Shift+I |
| New terminal | Cmd+Shift+T | Ctrl+Shift+T |
| Search chats | Cmd+Shift+F | Ctrl+Shift+F |

Hover or focus the search icon to see its shortcut; opening search shows it beside the input too. The search shortcut returns to the Agent Board and reveals its panel when necessary. Cmd/Ctrl+F still searches within the focused chat.


### Compact agent row and monitor controls

In the horizontal Agents row, the controls sit in a compact two-column strip beside the cards, leaving no unused band below them. Configure monitors stays within the window even when the dock is at either edge. Press Escape or click outside to close it. Dragging monitor headers keeps the scroll surface steady while the landing outline opens.

### Stopping agents and their watchers

Completing or closing an agent stops its active work and cancels pending durable
watches, including watches owned by delegated descendants. The chat is retained
when completed. Minimize only hides a window and deliberately lets work continue.
In Dynamic View the board is laid out in zones: places that each hold one agent.
It starts with two side by side. New agents wait in the Agents list instead of
opening on the board. Click a zone to make it the active one (it gets a heavier
outline), then click an agent in the Agents list to show it there, or drag the
agent from the list straight into a zone. The thin plus buttons along the
board's right and bottom edges add a zone that fits that row or column; the
plus at the end of an edge, or Shift-click, spans the full height or width.
Drag a zone by its name bar to move it (hold Shift at a board edge to span the
whole side) and right-click the name bar to close it. Minimizing or completing
an agent leaves its zone in place, dotted, until you fill it.
In Dynamic View (including Fixed grid), a window also minimizes automatically
when its agent finishes a successful reply. Errors and requests for input stay
visible, and Focused View keeps finished replies open. Select the chat in the
Agents list to restore a minimized window; this does not mark it Complete.
Stop cannot undo tokens already consumed. A later intentional run can arm new
watches; a failed delegation should explain its failure and continue directly
when safe, never silently switch provider or model.

Active watches appear above the chat draft as expandable chips. Open one to see
its wake condition, follow the PR, or cancel that watcher without stopping the
chat. Child-agent watchers show their owner. Suggested response buttons are gone;
the gray draft placeholder and Right Arrow acceptance remain.

### Reading expanded tool details

Click a tool activity row's chevron to see its full inputs or task. Expanded
details wrap long paths, URLs and unbroken text to the chat width, while keeping
indentation and line breaks. Longer details scroll vertically inside a bounded
area. Tool inputs shown as JSON keep JSON escaping (for example, `\n` inside a
string); the display does not rewrite the original input. Watch prompts, results
and wake-up details wrap the same way on desktop and the Local Web UI.

### Resizing the side panels

Hover the edge between the agent list and chat wall, or the edge beside Monitors, to reveal a bright vertical resize line. Drag it to change the panel width, or focus the separator and use the left/right arrow keys. The line disappears when you leave the edge; there is no permanent divider beside the agent list. Monitors starts at 276px wide, with all six Budget time ranges on one row. Resize near that width to snap back, or double-click its separator (Home on the keyboard) to reset. In Focus, untouched new chats use a quiet, borderless frosted surface; reduced-transparency preferences restore a solid background.

### Skills and Connectors shortcuts

Open **Settings** to find large **Skills** and **Connectors** chips at the top. They are no longer shown in the left sidebar by default. To bring either shortcut back, use **Settings > General > View settings** and turn on its sidebar toggle. Hiding these shortcuts does not disable their features or command-palette access.

### Download progress in Model Server

When you download a model or install a managed runtime, its button immediately
changes to **Downloading…** and cannot be clicked again while the transfer is
queued, downloading or verifying. A progress bar appears beside the action;
it shows a percentage once all file sizes are known, and stays indeterminate
until then. **Verifying…** means the files are still being checked or installed.
Use **Downloads** to cancel a transfer. A failure or cancellation lets you retry;
other models and runtimes remain available while one downloads.
