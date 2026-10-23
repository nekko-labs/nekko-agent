# Code mode

Code mode changes how a chat's tools reach the model. Normally the model is handed every tool as a separate definition (its name, what it does, and a JSON Schema of its inputs) on every request, and it calls tools one at a time, reading each result before deciding what to do next. In code mode the model gets two tools instead: one to look tools up, and one to run JavaScript that calls them. The model writes a short script, the script calls your tools in a sandbox, and only what the script returns goes back to the model.

The idea comes from Cloudflare's [Code Mode](https://blog.cloudflare.com/code-mode/) and Anthropic's [code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp). Both found that models write calls against typed code more reliably than they make tool calls, and that most of the tokens an agent spends go on tool definitions and intermediate results the model never needed to read.

```
Tool list                                   Code mode
─────────                                   ─────────
Every request: 40 tool definitions          Every request: search_tools + run_code
model → grep            → 30 KB result      model → run_code:
model → read_file(a.ts) → 8 KB result         const hits = await tools.grep({ pattern: 'TODO' });
model → read_file(b.ts) → 9 KB result         const files = [...new Set(hits.split('\n').map(l => l.split(':')[0]))];
model → (reads all of it, then answers)       return files.length;
                                            ← "12"
```

## Turning it on

Open the composer's **Mode** panel, click **Tools**, and pick **Code mode** under *How tools reach the model*. It applies to that chat, and its sub-agents inherit it. Save the chat as a mode to keep it.

The **Local only** starter mode turns code mode on for you. Small local models are where long tool lists hurt most: every definition takes context the model needs for your work, and a model that writes a short loop is often more reliable than one making a dozen calls in a row.

Sandbox chats always use the tool list. Their few tools already run in the container.

## What the model sees

- **`search_tools`** returns the tools that match a query as TypeScript signatures, for example:

  ```ts
  /** Search file contents. */
  tools.grep(input: {
    /** A regular expression. */
    pattern: string;
    path?: string;
  }): Promise<string>;
  ```

- **`run_code`** runs JavaScript as the body of an async function. `await tools.<name>(input)` calls a tool and returns its output as a string, and a failed tool throws a `ToolError` the script can catch. `return` sets what the model sees, alongside anything sent to `console.log`. Its description lists the available tools, one line each.

A few tools stay as direct calls because they are about the conversation itself: asking you a question, the plan, the chat's title, finishing the chat, and sub-agents.

## Safety

Code mode adds no new permissions:

- The script runs in an embedded QuickJS engine with nothing in it: no network, no files, no modules, no timers, no environment variables. The only way out is a tool your chat already has.
- Every call a script makes goes through the same checks as a direct call: the chat's tool switches, guardrails, hooks and approvals. In **Ask** mode you approve each call the script makes, one by one.
- A script stops after 5 minutes (time spent in tool calls counts), when you press **Stop**, if it uses more than 64 MB of memory, or after 100 tool calls. Output over 40,000 characters is cut.

## How much it saves

Each reply made in code mode shows an estimate on its stats line, for example *≈14k saved by code mode*. Hover the line to see where the estimate comes from:

- **Tool definitions not sent**: the definitions code mode stood in for, less its own two tools, times the number of model calls in the reply.
- **Results kept out of context**: what the script's tool calls returned and were sent, less what the script returned to the model.
- **Tool lookups**: what `search_tools` added. This is code mode's own cost, and it is subtracted.

For a sense of scale: with no MCP servers, Nekko Agent's own tools take about 2,660 tokens of definitions on every model call as a list, and about 1,860 in code mode, so a 10-call reply saves about 8,000 tokens on definitions alone. Each MCP server adds its whole schema to the list but only one index line to code mode, so the gap grows with every server you connect. The bigger saving is often results: a script that reads twenty files and returns a count sends the model a number, not twenty files.

The figures are estimates at about 4 characters a token, the same rule the Context Inspector uses. They are not your provider's billed counts. If code mode costs more than a tool list on a reply (a very short tool list, or a single small call), the line shows nothing and the hover says by how much.

## When to use the tool list instead

- You want to watch each tool call appear in the transcript as it happens. In code mode a script's calls show up as approvals and in the script's output, not as separate rows.
- The chat has only a handful of small tools, and replies make one or two calls.
- The model writes TypeScript annotations. Scripts must be JavaScript; a syntax error goes back to the model, which usually fixes it on the next try.

## Coming next

- **Hypergate code mode**: the same `search_tools` and `run_code` served by [Hypergate](https://github.com/nekko-labs/hypergate), so any agent that connects to your MCP servers through it (Claude Code, Cursor, Codex) gets code mode too.
- Parallel tool calls from one script, code mode in sandbox chats, and a script's calls as their own transcript rows.
