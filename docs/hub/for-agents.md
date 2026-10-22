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

1. [`AGENTS.md`](../../AGENTS.md): the rules for every change and a map of the runbooks (landing a PR, failing checks, visual evidence).
2. [`spec/`](../../spec/README.md): what the product does and why, one file per feature with an index. Read the index and the files your change touches, and update them whenever a feature changes.
3. [`TASKS.md`](../../TASKS.md): the technical plan and the task list, with stable task IDs.
4. [Contributing](/docs/contributing) and [Architecture](/docs/architecture) on this site.

## Editing these docs

Each page is rendered from one Markdown file in the repo, listed in `docs/hub/nav.json`. Edit the Markdown; the generated site is not committed, Vercel builds it on every deploy. To look at the result before it ships, `npm run website` builds the docs and serves the site on [http://127.0.0.1:8080](http://127.0.0.1:8080) (set `PORT` to change it), with the same clean URLs as production.

```bash
npm run website
```

A change to `nav.json` also changes `apps/website/llms.txt` and `apps/website/sitemap.xml`, which are committed; `npm run docs` updates them, and if you skip it the **Docs site** workflow commits them to the pull request. A pull request that changes user-facing behaviour should also update the page that describes it.
