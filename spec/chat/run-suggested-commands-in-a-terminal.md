---
title: "Run the commands the agent suggests, in the chat's terminal"
area: chat
---

# Run the commands the agent suggests, in the chat's terminal (2026-11-11)

Tracked by [#2595](https://github.com/nekko-labs/nekko-agent/issues/2595).

**User intent (Philip, 2026-11-11):** "When the agent suggests terminal commands for the user to run, let's allow running right there with a connected terminal." Copying a command out of a reply, finding a terminal, changing to the right folder and pasting is busywork; the reply should run where it is.

## What the user sees

`[implemented in source on the desktop and the Local Web UI; unit-tested and checked in a hidden, isolated full-ChatPane fixture with a synthetic terminal; not yet tried against a real shell in the packaged app]`

- **Run beside Copy.** A shell code block in an agent's reply (`bash`, `sh`, `shell`, `zsh`, `fish`, `powershell`, `ps1`, `pwsh`, `cmd`, `bat`, and the session kinds `console`, `shell-session`, `terminal`, `pwsh-session`) shows **Run** next to **Copy** on its language line. Its tooltip says how many lines it runs when there is more than one.
- **The chat's terminal.** Run finds the chat's connected terminal: a running shell opened for this chat (the last one Run used while it lives, else the newest; never the agent's read-only command log). With none, it opens one in the chat's folder (its worktree when it has one), titled **Chat terminal**, with the default shell. It types the block's lines and presses Enter.
- **Right there.** The terminal appears under the block that ran it, 240px tall, live and interactive, so a password prompt, a `y/N` or a long-running server works as in any terminal. Its line names it (the terminal-reported title, else Chat terminal) and its state, with **Share output**, **Open in a panel** and **Hide** (×). Hide closes the view; the shell keeps running and Run brings it back.
- **The block stays in sight.** A transcript following the latest reply would push the block up and out of view as the terminal opens under it; right after Run the transcript instead scrolls just enough to show the whole block (its top when it is taller than the view), which stops it following, so **Scroll to latest** shows. A view remounted later by scrolling leaves the transcript alone.
- **One view at a time.** Run on another block reuses the same terminal and moves the view under that block, so two views never fight over the shell's size. The view survives the block scrolling out of the transcript and back.
- **Share output.** Puts the terminal's last 80 lines, escape sequences removed, into the composer as a fenced `text` block under "Output from my terminal:", and focuses it. Nothing goes to the model until the user sends.
- Copy moved from a floating outlined button to the same quiet action style; a block with no language line keeps a floating Copy shown on hover.

## Rules

- **Only a click runs anything.** Run is a button in the UI; the agent has no tool or event that presses it, and nothing runs when a reply arrives.
- **What runs.** A script block runs every line, minus a `$ `, `% `, `PS> ` or `C:\path> ` prompt a model wrote in front of one; comments and redirections stay, since the shell understands them. A session block (`console` and the like) runs only its prompt lines (`$ `, `% `, `PS> `, `PS C:\path> `, `C:\path> `) without the prompt, plus the lines a prompt line continues onto (a trailing `\`, backtick, `|` or `&&`, with a `> ` continuation prompt removed). Its output, `> ` lines (npm prints script lines that way, and in a shell they would empty a file) and `#` lines never run. A session block with no prompt at all is taken as commands, minus its `>` and `#` lines. Code: `apps/desktop/src/renderer/suggestedCommands.ts`.
- **Where Run is offered.** Only on an agent's own words (not your messages, tool output or reasoning), in a chat you can write in, and not in a Sandbox chat, whose work never runs on this computer's shell (the engine refuses native terminals for them too). A fence still being written is not offered until it closes.
- **Which shell.** The terminal uses the default shell (Settings > Terminal > Default shell), whatever language the block names. A `powershell` block in a bash terminal runs as bash would read it.

## Verification

- `suggestedCommands.test.ts` (fences, prompts, session blocks, continuations, terminal choice, output text) and `ChatCodeRun.test.tsx` (where Run shows). The desktop Vitest suite passes apart from the four files that need the production bundle (`out/`), which CI builds first.
- `apps/desktop/scripts/run-in-terminal-sandbox.cjs` with `run-in-terminal-fixture.tsx` (through `layout-evidence-integration.cjs`, `NEKKO_RUN_WIDTH` 1100 or 390, `NEKKO_RUN_BASELINE=1` for an unchanged renderer): the real ChatPane in a hidden, off-screen, non-focusable window with a fake terminal that echoes. It checks both blocks offer Run, Run creates one terminal for the chat in its folder and types `npm ci\rnpm run build`, the inline xterm appears, the console block runs only `npm test` in the same terminal and the view moves under it, Share output puts plain text in the composer, and Hide closes the view.
- **Not yet verified:** a real shell (ConPTY, zsh, PowerShell) receiving multi-line input, the Local Web UI's terminal transport, the packaged app, and light theme captures.

## Phones

The phones render agent replies but have no Run yet: [#2607](https://github.com/nekko-labs/nekko-agent/issues/2607) (iPhone) and [#2608](https://github.com/nekko-labs/nekko-agent/issues/2608) (Android), in the [gaps table](../phone/ios-and-android-stay-in-step.md).
