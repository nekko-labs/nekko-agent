---
status: accepted
date: 2026-11-12
---

# 0089. Designs are files in the project's designs folder; Library lists the folder and agents are told to use it

## Context

Philip asked (#2677) why designs made in Claude Code chats were missing from Library, for
design canvases to show whoever made them, and for agents to be able to see and use them.

Library worked designs out from transcripts only: a `write_file` call, or a Markdown link
in a reply. Across 299 saved chats on one Mac, Claude Code chats recorded 33 `Write` calls
with a `file_path` and named their files in code formatting, so nothing they made was
listed. A design put in the project by the Design tab, a person or a tool outside Nekko
Agent had no chat at all. And nothing told an agent where another chat's designs were, so
each chat started from nothing.

Constraints: Library does not open a file until it is picked. Claude Code chats run on
Claude Code's own prompt; Nekko adds tools and notes to them only where the Claude policy
allows. The Design board is experimental and stores its concepts in the app's data folder.

## Options considered

1. **Fix the transcript index only.** Count Claude Code's `Write`, file designs by name.
   Small, and fixes the report. Does nothing for designs with no chat, and nothing for
   agents.
2. **The designs folder is the contract.** `nekko-designs/` in the project is where
   designs live. Library lists it, the prompt tells agents to read and write it, and any
   tool that can write a file takes part. No new tool, no new store, works for agents
   outside the app. Agents only see what is in files (no board notes), and an agent that
   does not get the prompt has to learn the folder from the project's own instructions.
3. **A `designs` tool in the engine**, bridged to Claude Code. Agents can list and read
   every design Library knows, with notes. Needs the index in the engine instead of the
   renderer, a policy row for Claude Code, and approval rules. The most capable and the
   most work.
4. **An open canvas file format** (JSON Canvas, tldraw, Excalidraw) as the design type.
   Portable between tools, but agents write poor layouts by coordinates, the app would
   need a renderer and editor for it, and it cannot hold a working prototype.
5. **Import from Claude Design or claude.ai artifacts.** There is no API to list a
   person's artifacts, and the standalone Claude Design product closes on 2026-12-14.

## Decision

Options 1 and 2 together. A design is an ordinary file, normally one self-contained HTML
page that lays its screens, states or options side by side (a design canvas), and the
project's `nekko-designs/` folder is its shared home. Library lists that folder for every
saved project (names only) beside what the chats produced, counts Claude Code's `Write`,
and files a page or image as a design when its name says so. The shared prompt tells
Nekko's agents to look in the folder before designing or building an interface, to save
new designs there, and to revise a design by editing its file.

Files are what every provider, every harness and every outside tool already share, so
this is the only option that works for all of them today and leaves nothing to keep in
step. Option 3 stays open as the next step (#2681) for what files cannot carry.

## Consequences

- A design is visible in Library whoever made it, and a later chat can find it.
- The listing is bounded (one level of subfolders, 40 subfolders, 300 files per project)
  and reads names only, so Library's "nothing is read until picked" rule holds.
- Designs saved elsewhere (`reports/checkout-design.html`) are still only found through
  their chat. The name rule keeps them under Designs, but another agent will not find
  them unless the project's instructions point there.
- Claude Code chats are not told about the folder by Nekko. A project that wants them to
  use it says so in its `AGENTS.md`.
- The Design board has to follow the same folder, or its concepts fork from their files
  (#2680).
- We will know this was wrong if agents keep ignoring the folder in practice, or people
  keep designs where the listing does not look. Then build the tool.
