---
title: "Editing, reviewing & previewing, without leaving the app"
area: code
split-from: SPEC.md (2026-10-22)
---

# Editing, reviewing & previewing, without leaving the app

Files open as windows right in the workspace: a **Files** explorer window lists a project root and opens files as windows of their own beside the chat and terminal, and the app-wide Folders panel does the same from the right-hand side. Markdown is rendered or code opens in a mono editor, with an integrated browser pane for the live preview beside the code. When the agent edits files, a **Changes** panel shows a line diff and the user keeps or reverts at line/file/all granularity. Reviewing AI-made changes, browsing a preview, and writing better prompts (via the always-on prompt analyzer) all happen in one calm window. *(Planned next:)* the user drops a **+ comment** on a line and either queues it for the next prompt or runs it immediately, turning in-place review notes into agent work.

On desktop, **Commands** in a chat opens an optional read-only terminal window showing the agent's approved shell commands and their output as it arrives. It mirrors the existing guarded execution rather than running a command twice. Desktop chats can also ask the agent to use a browser: by default a hidden in-app Nekko browser that Playwright drives inside the app's own Chromium (see *In-app browser automation*), or, explicitly, an existing browser started with localhost CDP enabled, attached through Stagehand. Every browser action requires approval; attaching never silently exposes or takes over an ordinary browser profile. In both modes the browser tool navigates, inspects page text, clicks, and fills a selected element; the in-app browser adds waiting, typing, key presses, scrolling, text and link extraction, page expressions, screenshots into the chat, tabs and a console/network log. It is unavailable in web, cloud, offline, and unattended runs. The integrated preview browser remains a separate, user-driven pane.
