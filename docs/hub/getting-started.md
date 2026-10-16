# Getting started

Nekko Agent is AI help on your computer, for coding and everyday work. It reads, edits, searches and runs things in your projects, using AI that runs on your own machine, an online service you already pay for, or both. It is free, open source and MIT licensed.

## Who we are

Nekko Agent is made by [Nekko Labs](https://nekkolabs.com). We develop it in the open on [GitHub](https://github.com/nekko-labs/nekko-agent): the code, the plan and the task list are all public.

We care about three things:

- **Your computer, your choice.** You pick which AI runs, what it can touch and when it needs your approval. Work that uses only local models stays on your machine.
- **Honest software.** The app tells you what a model will cost, whether it will fit in memory and what it is about to do. These docs mark what is planned as planned.
- **Fast and calm.** The interface never waits on the agent, and responsiveness is measured on every change.

## What Nekko Agent does

- **Use AI on your computer or online.** Run models with the built-in engine, connect Ollama, LM Studio or vLLM, or sign in with a Claude or ChatGPT subscription. Mix them in one workspace.
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
| `docker compose up` | The web edition inside Docker, with your workspaces mounted as volumes |
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

Hover over the sidebar **+** to choose **Agent**, **Create or Edit Photos and Videos** or **Terminal**. Moving away closes the menu after a short grace period. Terminal uses your default shell; choose its type in **Settings → Terminal → Default shell**, or leave **Auto-detect** selected. Media gen opens an image session; video generation is not available.
