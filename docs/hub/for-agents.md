# Docs for AI agents

These docs are written for people and for AI agents. Every page is also published as plain Markdown, and the whole set is available as one file, so an agent can read it without parsing HTML.

## Machine-readable docs

| URL | What it is |
| --- | --- |
| [`/llms.txt`](/llms.txt) | An index of the site and every docs page, in the [llms.txt](https://llmstxt.org) format |
| [`/llms-full.txt`](/llms-full.txt) | Every docs page in one Markdown file |
| `/docs/<page>.md` | Any single page as Markdown, for example [`/docs/cli.md`](/docs/cli.md) |

Each page also links its Markdown version at the top, next to the title.

## Use Nekko Agent from your agent

Nekko Agent can be a subagent for Claude Code, Codex, Cursor and other tools: they hand it work, and it runs that work on your local models. Register its MCP server once, for example in Claude Code:

```bash
claude mcp add nekko-agent -- node /abs/path/nekko-agent/apps/cli/dist/index.js mcp
```

The tools, the other harnesses and the CLI commands are in [CLI and MCP](/docs/cli).

## Working on the code

An agent changing Nekko Agent should read these files in the repo first:

1. [`AGENTS.md`](../../AGENTS.md): how work lands (a worktree per task, a PR for every change, visual evidence for UI changes).
2. [`SPEC.md`](../../SPEC.md): what the product does and why. Update it whenever a feature changes.
3. [`TASKS.md`](../../TASKS.md): the technical plan and the task list, with stable task IDs.
4. [Contributing](/docs/contributing) and [Architecture](/docs/architecture) on this site.

## Editing these docs

Each page is rendered from one Markdown file in the repo, listed in `docs/hub/nav.json`. Edit the Markdown, then regenerate the site:

```bash
npm run docs
```

To look at the result before it ships, `npm run website` serves the site on [http://127.0.0.1:8080](http://127.0.0.1:8080) (set `PORT` to change it), with the same clean URLs as production.

If you skip that step, the **Docs site** workflow rebuilds the pages on the pull request and commits them to its branch, but only when the output actually changed. A pull request that changes user-facing behaviour should also update the page that describes it.
