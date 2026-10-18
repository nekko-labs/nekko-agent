# Agent tool gap review (2026-10-15)

Question from Philip: with tools now grouped by category, are we missing useful tools that other agent systems ship?

## What Nekko ships today

| Category | Tools |
| --- | --- |
| File system | `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `list_dir` |
| Shell & processes | `bash`, `start_process`, `read_process`, `kill_process` |
| Desktop | `capture` (window screenshots/recordings) |
| Online | `fetch_url`, `browser` (in-app Playwright or existing CDP) |
| Agent | `update_plan`, `ask_user`, `spawn_agent`, `delegation_targets`, `agent_watch`, `decide`, `set_chat_title`, `complete_session` |
| MCP | Anything from connected servers |

Sources compared (from their public tool documentation as of this writing, not re-verified live today): Claude Code (Read/Write/Edit/MultiEdit, Glob, Grep, Bash, WebFetch, WebSearch, TodoWrite, Task, NotebookEdit), OpenAI Codex CLI (shell, apply_patch, update_plan, web search), Cursor agent (codebase semantic search, edit, terminal, web, lints), Gemini CLI (read_many_files, web search, save_memory), Cline/Roo (diff edits, browser, MCP, attempt_completion).

## Gaps, ranked by value

1. **`web_search`** (Online). Every major harness has it; `fetch_url` needs a URL the model already knows. Backend options: a configured provider's native search (Anthropic/OpenAI server tools), or a user-supplied key (Brave, Tavily, SearXNG for local-first). Offline: blocked by category. Effort: medium (needs a key/settings surface).
2. **`multi_edit` / patch apply** (File system). Several exact-string edits to one file in one call, applied atomically. Cuts round trips and half-applied edits on local models. Effort: small; reuses `edit_file` validation.
3. **`search_index`** (File system). Expose the workspace index (already built for context snippets) as a semantic/keyword search tool, like Cursor's codebase search. Effort: small; the index and search exist in the host and daemon.
4. **`read_many_files`** (File system). Read several paths or a glob in one call with a total cap. Helps small-context local models avoid dozens of calls. Effort: small.
5. **`memory_save` / `memory_search`** (Agent). Let the agent write and query the existing Memory store (global/workspace) instead of only having it injected. Effort: small; respects incognito (disabled there).
6. **`diagnostics`** (Shell). Run the project's type checker or linter and return structured errors (Cursor "read lints"). Could start as a project-detect mapping onto `bash`. Effort: medium.
7. **`notebook_edit`** (File system). Cell-aware `.ipynb` edits; relevant to the Training tab's data-science users. Effort: medium.
8. **`git` helpers** (Shell). Structured status/diff/log rather than parsing `bash` output; the host already has git status/diff services. Effort: small, but `bash` covers it today, so lower priority.
9. **`open_artifact` / `report_artifact` outside goal runs** (Agent). Let any chat register an output explicitly so the new Artifacts tab does not rely on link and `write_file` heuristics. Effort: small; the tool exists for training runs only.

Deliberately not recommended: a generic "computer use" mouse/keyboard tool (planned separately as the safe offline PC-control feature with its own permission model), and arbitrary HTTP POST (exfiltration risk without a much stronger approval story).

## Suggested next step

Ship 2, 3 and 9 together (all local, small, and they improve the Artifacts tab), then 1 behind an explicit settings opt-in. Each new tool needs a category entry in `packages/shared/src/tool-categories.ts`. An unlisted tool shows under Agent in the menu but is refused in offline chats until it is classified, so a networked tool cannot slip through by default.
