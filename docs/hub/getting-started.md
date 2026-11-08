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

**Find a feature by what you want to do:** the [feature guide](/docs/features) maps local models, file recovery, memory, approvals, automation and MCP to setup instructions and honest limits.

## Install the app

The quickest way to start is the installer.

1. Download the installer for your computer from [nekkoagent.com](https://nekkoagent.com/#download) or the [latest GitHub release](https://github.com/nekko-labs/nekko-agent/releases/latest):
   - **Windows:** the `.exe` installer
   - **macOS (Apple silicon):** the `.dmg`
   - **Linux:** the `.AppImage`, or the `.deb` for Debian and Ubuntu
2. Run it. On macOS, drag Nekko Agent into Applications.
3. Open Nekko Agent, add a project folder and choose a model on the **Models** tab (the violet brain-and-gear icon in the left navigation). Click a model's name there to make it the default for new chats.

The first time it opens, Nekko says hi and asks a few quick questions, all of them skippable: what to call you, an optional email for update news, what you mostly do, and how much detail you like in replies (**Minimal**, **Regular** or **Detailed**, with a sample chat that shows each one and a switch for the **Monitors** panel). Then you pick a look and connect a model. Setup opens in Dark; switch to Light in the look step. Change any answer later in **Settings → General → About you**, or reopen the whole thing with **Replay setup**. An email you give joins the update list once and gets one confirmation email; nothing is sent if you leave it blank or choose **No thanks**.

macOS builds are signed and notarized, so they open normally. If Windows shows an "unknown publisher" prompt for an unsigned build, choose **More info**, then **Run anyway**.

## Typing in a new agent window

A new chat greets you with a welcome phrase, such as “What’s next?” or “It’s building time.”, and a small pixel Nekko peeking beside it, looking toward the heading. Each chat keeps its own greeting rather than rotating while you work. Morning and late-night chats can also get a time-appropriate hello. Type your request in the composer below. The very first time, a short **Send your first prompt** intro opens over it: three looping demos (start with a question, add your files, send). **Skip**, the ✕, Escape or a click outside closes it, and it does not open again. It stays closed for anyone who turned off contextual tips. The iPhone and iPad app shows its own version the first time you start a chat on a computer: the same three steps, shown on the phone's new-chat screen (type or say it, add photos and a folder, tap Start). Tap **Skip**, **Get started**, or swipe the sheet down to close it. The new-chat surface slowly fades through teal/gold, violet/rose, blue/mint and rose/amber palettes over two minutes. In Nekko and Indigo, the selected window instead keeps a soft plum gradient into the full conversation, with a gentle violet/rose color crossfade; in Dynamic View only the active agent has that gradient, even while other agents are working. Reduced motion holds the colors still. Themes with moving dots show them only here, not behind existing conversations. Agent chat rows in the left panel stay flat, without a tile background or border; the title, status and keyboard focus outline identify the relevant chat. The composer's effort gauge is borderless, and **Suggestions** appears on its own row below the model/action controls when there are suggestions to show. Context menus use a neutral light or dark background with accent-colored highlighted rows. Switching to a chat also highlights and reveals its row in the Agents panel. To rename a chat, right-click its card and choose **Rename**, or hover the card and click the pencil beside the X; type the new name and press Enter (Escape cancels). A name you type stays: Nekko no longer replaces it with an automatic title.

Opening an agent composer puts the caret after any restored draft once a usable model provider is available. If you are already typing in another visible text field, that field keeps focus. Normal background agent and provider updates do not pull you back into the composer.

## Returning to the latest message

When you scroll up in a chat, a floating **↓ Scroll to latest** pill appears at the bottom of the conversation, above the message box. Click it to return to the newest message and follow new output again. It also works in completed chats, without waiting for another reply. The pill disappears when you reach the bottom.

## Recovering file edits

Use the chat's **Changes** view to compare native text-tool edits, keep them or revert them. New source builds can retain the saved chat's original text across restart and validate up to 100 ordered replacements before writing. Incognito originals remain memory-only; accepting a change discards its baseline.

See [File recovery and batch edits](/docs/file-recovery) for availability, the exact tool-call example, privacy and storage limits. This is not whole-workspace backup, binary-perfect restoration or protection from concurrent external writers. Keep version control and backups for important work.

## Reviewing visual changes

For UI work, Nekko is instructed to show the actual before/after screenshots in the agent reply, rather than leaving evidence only in a PR. Matching images labeled **Before: screen name** and **After: screen name** appear as a comparison; the reply's **Next step** section also shows a **Verify the visual changes** panel with those same screenshots. Wide conversations show the pair side by side, while narrow conversations stack it. Evidence stays with the reply and chat where the work happened.

Displaying a screenshot does not mean it has been inspected or approved. The agent reports what it checked and what still needs review. New surfaces may have only an after image. Local screenshots retain Sandbox restrictions, and remote images from sources the chat has not seen still wait for **Load image**. If an image cannot load, its card shows the existing fallback rather than hiding the verification gap.

## Make it yours

In **Settings → Customize → Appearance**, choose a palette from the colored circles, then use the small sun/moon switch for light or dark mode. Every offered palette has both modes, including seasonal Spooky. Switching mode keeps the palette and any custom colors; choosing another palette applies its own colors without changing the mode. Choose **Nekko** to return to the default palette.

On desktop and the Local Web UI, light **Nekko** and **Indigo** use pale rose and indigo surfaces, tinted selections, and the same plum/violet/rose gradient colors as their dark counterparts. The selected chat keeps its color field from the greeting into the conversation; other panes stay quiet. Dark themes are unchanged, and reduced motion keeps a static field.

The desktop opening splash uses deep plum for Nekko (including the default System look), rather than the lighter accent used for text. Indigo uses its own deep main color; other chosen palettes keep their colors. Older cached splash colors are refreshed automatically.

Open **Custom colors** to adjust the accent and secondary color with the wheel or an exact color value. **Reset to this theme's colors** restores the defaults for the current palette and mode. The same controls appear during first-run setup. Theme circles respond gently to hover and press; the system's reduced-motion preference turns that motion off.

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
- [Pair your phone](/docs/remote) to use the agent away from your desk. On iPhone, Nekko sits beside an open chat’s title. Pull **up** past the latest message to refresh without returning to the top; lists still refresh by pulling down. The spinner turns while loading, then Nekko grabs it and pulls it in once the reload finishes.
- Want to help build it? Read [Contributing](/docs/contributing) and the [architecture](/docs/architecture).

### Closing the desktop UI and notifications

Closing the desktop window hides it to the tray; the engine and running work remain alive. This is not Quit. **Quit Nekko Agent** stops the service and managed processes; **Stop Nekko service** stops the service while leaving the UI available. This does not promise execution during OS sleep, shutdown or logout.

**Settings > Notifications > Desktop notifications** is on by default. The desktop's main process listens independently of the page for completed replies, failures, questions and approvals. A user Stop is not a failure. Clicking a native notification, on screen or later from the Windows notification centre, brings the window forward and opens that chat. Turn the toggle off to opt out; notices can include the chat title and question, error or approval text. Browser editions use browser notification permissions instead.

**Full-screen games (Windows).** While a game runs in exclusive fullscreen, Nekko Agent holds its notices and shows them together when you leave the game, one per chat and kind. Windows you open yourself (launching the app, a link, the tray) still open at once.

The 2026-10-13 batch is implemented and unit/fixture interaction tested, not yet landed. Image inspection and native toast delivery/click/permission testing remain pending. Known issue under review: the native listener currently also posts for a focused visible chat.

### Create an agent, media session or terminal

Hover over the left navigation panel, including its curved top and bottom wings, to open it and see each destination's name. Keyboard focus opens the same panel; reduced motion disables its width and label transitions. On macOS, **Nekko Agent → Settings…** (⌘,) opens Settings and **About Nekko Agent** shows the About page.

Hover over the sidebar **+** to choose **Agent**, **Create or Edit Photos and Videos** or **Terminal**. Moving away closes the menu after a short grace period. Terminal uses your default shell; choose its type in **Settings → Terminal → Default shell**, or leave **Auto-detect** selected. Create or Edit Photos and Videos opens an image session; video generation is not available.

Each terminal has its own Agents-panel row, including terminals opened beside a chat and shells that have exited. It shows the terminal-reported title and activity when available. The strip above terminal output shows working/ready/attention status, reported directory, and an observed GitHub PR link. **Refresh** fetches that PR's current state and checks; until then, the link is explicitly unverified. No terminal output is sent to a model for summaries.

Claude Code users can opt into explicit tool/permission/completion signals using the [terminal hook setup](https://github.com/nekko-labs/nekko-agent/blob/main/docs/terminal-claude-hooks.md). Nekko never installs hooks or approves tools silently. Without integration signals a terminal says **Shell open**, not Working.

### Approvals and delegated work

When a tool needs permission, its approval card appears in that agent's own window, above its composer. An unrelated tool finishing does not dismiss that request. Read the exact input before choosing Approve or Deny.

For an identified subagent, **Open ↗** beside its activity row opens the child chat using the existing workspace navigation. The chevron still expands task details separately. If the app cannot safely associate a delegation with one child (including older activity after a restart), use the sub-agent cards along the bottom of the plan sheet above the composer (or the Agent Monitor in the Agent tab) instead; the row does not guess which chat to open.

The sub-agent cards, Agent Monitor and child-chat banner show the child's provider and model when available. The banner's parent-chat name opens the chat that delegated the work; for nested agents this is the immediate parent. Transcript model chips also include the provider when known. Hover the route label to read the full model ID. Missing provider configurations fall back to their saved ID rather than hiding the source.

### Model and effort controls

Changing the model or effort in an existing chat shows **Tokens on your next turn**: an estimate of the input tokens needed to resend the chat’s context. Nothing is sent just by changing your selection. To save tokens, start a new chat and include only what it needs instead of carrying over the old history. Actual usage and cost depend on context trimming and provider caching and billing.

Check **Got it. Don’t show me again.** and click **Got it** to hide this notice across chats. To bring it back, enable **Settings → System → Developer → Show model-switch token notice**. Closing the notice without acknowledging does not save that checkbox.

The composer shows the model title without a subscription suffix. Open its menu for provider and account details. Cloud providers appear first under **Cloud**, followed by **Local**; when both exist they occupy independently scrolling columns. Your default model is marked inside its provider group instead of repeated at the top.

**Effort** appears beside the model in Simple and Expert. Its borderless button opens a slider of choices reported by that model's provider. There is no **Normal** stop. ChatGPT and Anthropic catalogs can supply these choices; providers without verified capability metadata show an unavailable control rather than guessed levels. Existing saved Normal settings remain compatible. Native phone choices have not yet moved to this dynamic catalog. On a Claude subscription, the choices are the ones Claude Code takes, and it applies the closest level a model has.

In new and ongoing chats, prompt-writing **Suggestions** appear on the far right of the **Mode** row (Detailed only by default). The **Folders** picker always sits immediately to the right of **+**, in both Simple and Detailed. Open it to choose or add a folder, set defaults, or remove a folder from this chat without revoking its saved access. Folders no longer live inside Mode. While a reply runs, the picker stays visible and becomes editable again when the reply finishes. Model selection and reasoning effort stay in their dedicated composer controls, not in the **Mode** panel. Saved modes remain compatible with their existing model and effort preferences.

Local chats can read and write `~/.nekko-agent` without adding it as a project folder. This is the app data directory and may contain sensitive local state; normal write approvals still apply. This does not grant the rest of your home folder, change the project directory, or expose the host folder to Sandbox containers.

### Quickly filter the model picker

At the top of the model picker, use **All**, **Fusion**, **Cloud**, or **Local**.
All shows every available model and Auto; Fusion shows Auto routing; Cloud and
Local narrow the list to those providers, including favorites and your default.
Filtering does not select a model or change the chat's mode. Fusion is unavailable
where Auto routing is not supported, such as a fixed-model workflow step.
The iPhone and Android apps' model lists have **All**, **Cloud** and **Local** at
the top too (they offer no Auto, so no Fusion).

### How the Agents panel groups your agents

The selected agent has a tinted background across its row, so you can spot the chat you are viewing without hovering. Hovering a chat row adds a soft tinted glow with a quick fade, without switching chats. Keyboard focus gets the same glow and a visible outline; reduced motion removes the fade. Other rows stay flat at rest; their status icons still show whether they are working, waiting or finished.

By default the panel follows each working agent around its loop: **Draft** (nothing sent yet, shown only when there is one), **Exploring** (reading the code and the web), **Building** (editing files) and **Verifying** (tests, builds and checks, and committing, pushing and opening pull requests). An agent can move back: an edit after a failed test puts it in Building again. Reading only moves it back to Exploring when you send something new. An agent that has stopped goes to **Watching** while it has a watch armed or is watching something you asked it to, and to **Done** otherwise. The icon on each card shows what it is doing right now, including an orange **?** when it is waiting on you. A card whose agent opened a pull request shows it as a chip at its bottom right, with the PR icon in the colour of its state: green when open, gray for a draft, purple when merged, red when closed. With several PRs it shows the most current one and **+N**; hover the count to see them all, and click a PR to open it. Use the sliders button to group by project, date or computer instead.

In the vertical Agents panel, the group heading stays at the top of the list while you scroll its agents, then yields to the next group. The horizontal row keeps its usual sideways scrolling.

While agents are working, a group's heading shows a small Nekko animation and a green count at the far right. To hold Nekko still, turn off **Settings > Animations > Agent activity animation**. This setting decides on its own, whatever your system's reduce motion preference says.

Each group initially shows up to **20 agent rows**. Choose **Show more (N)** below a group to show its full list in one click; other groups stay limited. Completed lists also start at 20 when opened. Hidden cards are not loaded into the panel until needed, while group counts and search still cover all your chats. Opening an agent outside the first 20 brings its row into the last visible slot. Changing the grouping resets these expanded lists.

### Delegated agents in the Agents panel

Delegated subagents appear as compact rows beneath their parent, joined to its card by a tree line, each led by its status (a rocket while it works, a check when done). This works in Claude chats too, where a subagent's chat is a live copy you can read but not write to. The plan above the composer also shows each subagent as a live card along its bottom: its status, its task on one line, and what it is doing right now; click a card to open that subagent. A subagent's chat opens under a banner naming the chat that spawned it; click the name to go back to it. A working subagent always has a row; finished ones stay while their chat is working or open, then fold into the count on the card. On desktop and Local Web UI, suggested actions below the reply have a **This chat / Subagent** sliding selector. Typed follow-ups use the normal composer Send/Enter path; the old duplicate routing-button row is removed. You can also ask for delegation in your own message. Native phone controls are unchanged. Opening a child transcript does not add a duplicate full agent card. Closing the parent's windows keeps the saved parent and its nested children accessible.

A turn's working steps fold into one work group whose header says what the agent did, by purpose: for example *Read guidance, looked through the code, edited 3 files*. Hover or keyboard-focus the header to read the complete summary and each purpose group with its number of calls. Click the header to open the steps. Inside it, adjacent calls with one purpose are one row that states the goal, such as *Read the project's guidance · AGENTS.md, CLAUDE.md* or *Ran the tests · passed*. When a call gave its own description (Claude Code's commands do), that description is the goal. Click a group to see its individual calls. A call waiting for your approval, a question for you, and a lone call stay rows of their own. A group with a failed call says *1 failed* and stays open.

### Reading a compaction summary

When older conversation is summarized, a **Conversation compacted** event card shows how many earlier messages were summarized. It starts collapsed, including the newest summary. Click **Show summary** to read it and **Hide summary** to fold it again. Earlier messages remain readable above the card. Expanding or collapsing the card does not change what the model receives.

In a Claude Agent chat, Claude Code compacts the conversation itself: on its own when the context nears its limit, or when you type `/compact`. The card then reads **Claude Code compacted the conversation** and says which of the two it was, how far the context fell (for example `968k → 41k tokens`), and how many messages the summary replaces. That is why the context gauge drops sharply after a compaction: Claude Code carries on from the summary, not from the full history.

### Answering agent questions

When an agent needs a choice, its question opens at the bottom of the conversation without moving your typing focus, even when another agent asks while you are writing. Scroll the conversation to read the reply and question together; the question has no separate scrollbar. Click or Tab into the question to answer it: use the options, arrow and number keys, or type something else, then send your answer. Multiple questions show one step at a time, with Back and Next. Moving between steps keeps the keyboard in the question only while you are interacting with it. The pixel question-mark icon identifies the question.

### Links and files in replies

A pull request link in a reply shows as a small chip with GitHub's state icon: open (green), draft (grey), merged (purple) or closed (red). Click it to open the pull request in your browser.

In agent chats, confirmed PR command results also leave inline cards where the interaction happened: created (including draft creation), set to draft, ready for review, auto-merge enabled, queued, merged, closed, reopened, updated, reviewed or viewed. They appear while the agent is working and remain in saved history. **Merge requested** means the command was accepted, not that the PR merged; **PR queued** and **PR merged** require their own confirmation. The first card for an open PR keeps its live status and review actions, while older event labels stay historical. Ambiguous scripts and failed commands do not create success cards. Other web links have a **Preview** button that loads the page inside the message.

Click a file link to open the file in a window beside the chat. Code is coloured by language, and the toolbar shows which language was detected. You can edit the file there: it saves itself a moment after you stop typing (turn **Auto-save** off in the toolbar if you prefer), and **Ctrl+S** (**Cmd+S** on macOS) saves at once. The toolbar tells you when a save happens: *Auto-saved at 9:41* or *Saved at 9:41*.

### Agent panel shortcuts

Click the plus button in the Agents panel to open a new agent window. Hover over it for the Agent, Photos and Videos, and Terminal choices. Terminals and photo/video projects appear in separate groups at the top of the panel only when there are items to show.

The Agent Board header also has a single **+**: hover or click it for the same three choices. Both menus use a neutral light/dark background and highlight the hovered or keyboard-focused row in your primary color. The shortcut appears beside every choice:

Immediately to its right, **View** brings together **Single agent** (one focused chat), **Multi-agent** (tiled chats), **Snap to grid**, and desktop screen/desktop controls. Cmd/Ctrl+Shift+1 and +2 still switch the two views. Snap to grid is available in free-form Multi-agent view; it keeps windows evenly spaced and attracts dividers only when they are within 3% of a grid boundary. The menu scrolls on smaller windows. The two illustrated layout cards preview one chat or chats side by side; the toolbar icon reflects your selection. Under **Screens**, select an additional display to open or close its Nekko window. A single display shows its connected status instead. **Open new agents** lets you **Spread across screens** (empty screens first, then the one with the fewest agents) or **Prefer main screen**. With only one screen, that preference applies when you connect more displays. These desktop-only controls are not shown in the Local Web UI.


| Action | macOS | Windows/Linux |
| --- | --- | --- |
| New agent | Cmd+T | Ctrl+T |
| New photo/video session (image tools available; video planned) | Cmd+Shift+I | Ctrl+Shift+I |
| New terminal | Cmd+Shift+T | Ctrl+Shift+T |
| Search chats | Cmd+Shift+F | Ctrl+Shift+F |

Hover or focus the search icon to see its shortcut; opening search shows it beside the input too. The search shortcut returns to the Agent Board and reveals its panel when necessary. Cmd/Ctrl+F still searches within the focused chat. In Dynamic view, click an agent window's transcript, title bar, or composer first to search that window.


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
agent from the list straight into a zone. Clicking an agent that is already on
the board just switches to its zone. Each zone has a colour, shown as a small
square before its name and as a thin bar on the cards of the agents it holds. One plus on the right, aligned with the zone headers, adds an empty full-height column. Hover or focus it to see existing zones reflow around the new column preview; move away to cancel. Click to add it, then drag its header to move it elsewhere. There are no bottom plus strips. You can also choose **+ > Add agent zone** in the board toolbar to add and select an empty right-hand column without creating an agent or switching views.
Press a zone's name bar and move the pointer to start dragging it; a click without movement only selects the zone and does not lift it. Hold Shift at a board edge to span the
whole side, and right-click the name bar to change its colour, rename it or close it. Minimizing or completing
an agent leaves its zone in place, dotted, until you fill it.
The composer's borderless action switches from Send to a Stop icon while the agent runs with an empty draft. Type a follow-up and it becomes Send again, queuing the message without interrupting the agent. Clear the draft to get Stop back. To schedule work, open **+ > Automate**; Automate no longer takes up a separate place on the composer.
In Dynamic View (including Fixed grid), a window also minimizes automatically
when its agent finishes a successful reply. Errors and requests for input stay
visible, and Focused View keeps finished replies open. Select the chat in the
Agents list to restore a minimized window; this does not mark it Complete.
Stop cannot undo tokens already consumed. A later intentional run can arm new
watches; a failed delegation should explain its failure and continue directly
when safe, never silently switch provider or model.

Active watches appear above the chat draft as expandable chips. Open one to see
its wake condition, follow the PR, or cancel that watcher without stopping the
chat. Child-agent watchers show their owner.

When an agent opens a pull request, Nekko watches it for you: at the end of the
turn it arms a watcher on every open PR the chat opened, whichever model or
harness the chat runs on (Claude Code included). The exception is Claude on a
Claude plan: Nekko can't start a turn there on its own, so it doesn't watch
those PRs; Claude with an API key or a cloud account is watched, and there
Claude Code can also set watches of its own. The agent wakes when checks
finish, a review arrives or a few hours pass, fixes what it can, and lands the
PR if you or the repository allow it; otherwise it tells you the PR is
merge-ready or what is blocking it. The chip reads **Watching until
merge-ready**. Nekko keeps re-arming it until the PR is merged or closed.
Cancelling the chip stops it for that PR. To turn it off for every PR, go to
Settings › Tools, click **Show advanced settings** if it's there, then turn off
**Watch each PR until it is merge-ready** under Pull requests.

Suggested response buttons are gone;
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

### Customize your experience

Open **Settings > Customize** for appearance, sidebar shortcuts, desktop behavior, mascot options, agent-wall layout, personal instructions, fonts, accessibility, and Simple mode visibility. Existing preferences are kept when controls move. Search in the settings rail finds controls across every section. Computer connections, phone pairing, safety policies, and service management stay in their own sections.

### Skills and Connectors shortcuts

Open **Settings** to find **Skills** and **Connectors** at the top of its left rail. They are no longer shown in the left sidebar by default. To bring either shortcut back, use **Settings > Customize > View settings** and turn on its sidebar toggle. Hiding these shortcuts does not disable their features or command-palette access.

### Download progress in Model Server

When you download a model or install a managed runtime, its button immediately
changes to **Downloading…** and cannot be clicked again while the transfer is
queued, downloading or verifying. A progress bar appears beside the action;
it shows a percentage once all file sizes are known, and stays indeterminate
until then. **Verifying…** means the files are still being checked or installed.
Use **Downloads** to cancel a transfer. A failure or cancellation lets you retry;
other models and runtimes remain available while one downloads.

### Suggested follow-ups

After a reply, **Suggested follow-ups** can offer relevant next messages such as **Inspect the saved PNGs directly** or **Try another image viewer**. Each button sends the words it displays; nothing is sent until you choose one. These suggestions are not questions from you or approval requests from the agent.

When delegation is available, use the small sliding toggle to choose **This chat** (the default) or **Subagent** before choosing a response. If you type your own message instead, send it with the normal composer controls; there is no duplicate routing-button row. Ask for a subagent in your message when that is what you want. Suggestions are optional and may not appear after every reply.

Starred models stay listed under their provider as well as in the model picker shortcuts. Either entry selects the same model. To reorder a monitor card, press its header and move the pointer; clicking without movement does not lift it or show a landing preview.

### Text formatting toolbar

Selecting text in the desktop or Local Web UI message editor opens a compact, single-row Markdown formatting toolbar beside the selection. Its pointer identifies the text being edited. The toolbar can extend over a neighboring agent pane, but stays inside the app viewport. Right-click still offers the formatting controls and clipboard actions.

On iOS, tap the keyboard-down button at the right of the message box’s formatting row to hide the keyboard without sending or clearing your draft. It stays available when **Aa** collapses the formatting controls. Tap the message box to continue typing.

Development builds show the latest reachable release tag plus a `dev` suffix, commit distance and source hash, rather than the checked-in package version. Installed apps show their stamped release version. Restart development mode after pulling a version-identity fix or fetching new release tags.

Nekko Agent’s app icon uses a white cat on deep plum across desktop, browser and phone launchers. The desktop tray and notification icon use the same artwork. An already running or installed app keeps its bundled icon until you update and restart it; a development launch rebuilds its branded runtime when the icon changes.
