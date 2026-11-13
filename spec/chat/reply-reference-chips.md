---
title: "Code file and PR references in replies as chips"
area: chat
---

# Code file and PR references in replies as chips

**User intent:** Philip asked (2026-11-12) that the code files and PRs an agent cites in a reply ("built with the same theme setup (RootView.swift:164-166). Since the Winter snow change (#2480) ...") show as rich chips, not plain text, the same way a full GitHub PR URL already does. Issue #2676.

**Status:** implemented on desktop; unit/renderer-tested (`replyRefs.test.ts`, `Markdown.test.tsx`, Rust `git::tests`) and captured before/after in the hidden isolated Electron fixture (`chat-artifacts-evidence-sandbox.cjs` with `NEKKO_CHAT_ARTIFACTS_REPLY=refs`), not yet reviewed in the running app. Native mobile and the Local Web UI chat are unchanged.

## Behavior

**File chips.** A code reference in an assistant reply, in prose or as a code span (`RootView.swift:164-166`, `src/App.tsx:12`, `crates/x/src/git.rs`), becomes a chip: the file-type badge, the filename and the line or range, with the full path and lines on hover. Selecting it opens the file pane in the originating chat (the pane opens the file; it does not jump to the line yet). Source, config and doc extensions count (Swift, Kotlin, Java, TS/JS, Rust, Go, Python, Ruby, C/C++/ObjC, C#, PHP, CSS, HTML, Vue, Svelte, Markdown, JSON, YAML, TOML, shell, SQL, XML, plist, Gradle). A code span naming a page, image or PDF output (see [chat artifact cards](chat-artifact-cards-and-session-local-documents.md)) is a file chip too, and still gets its preview card under the reply.

Where a reference points:
- An absolute path, as written.
- Otherwise a file the chat's agent read or edited (absolute `file_path`/`path` arguments in its tool calls) whose path ends with the reference, preferring one inside the chat folder.
- Otherwise, for a reference with a folder (or a named output), the path under the chat folder.
- Otherwise nothing: a bare filename the agent never touched stays plain text, so a chip never points at a guess. Without a chat folder, relative references also stay text.

**PR and issue chips.** `#2480`, `PR #2636`, `issue #12` and `owner/repo#5`, in prose or as a code span, render as the existing PR chip with GitHub's live state glyph and tone (or the issue chip with the issue's state when the reply says "issue"), linking to GitHub in the browser. The live state is the same cached `gh`/REST read the PR cards use. A bare `#N` uses the chat's repo: the GitHub repo its folder's `origin` points at, reported by the engine's git status (`GitStatus.github`), or else the one repo all of the chat's PRs are in. With no repo it stays text. A bare one-digit number (`step #3`) stays text unless the reply calls it a PR or issue. Colours (`#2480ff`), anchors (`page.html#12`), entities and URLs are never read as references.

## Boundaries and acceptance

- Chat messages get chips wherever a reference resolves (the user's own messages use the same renderer). Documents opened in the file pane keep prose references as text; a code span there that names a file is a chip.
- Nothing inside fenced code blocks changes.
- Sandbox chats read nothing on the host: file references stay text. PR chips still show, like any web link.
- No new file reads: resolution uses the chat's own tool calls and folder. The one new host work is one `git remote get-url origin` per uncached git status read (five-second cache), already shared by the sidebar card and chat header.
- Chips keep the line height of the prose around them, and the file badge never wraps.
