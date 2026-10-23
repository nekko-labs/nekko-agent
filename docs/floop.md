# Floop tasks

[Floop](https://github.com/nekko-labs/floop) is a work tracker where a team and its AI agents keep their work in two separate streams. Nekko Agent can read your Floop tasks and work on them as its own agent.

## Show your Floop tasks

1. In Floop, open **Settings → Agents**, add an agent for Nekko Agent (or use the existing `nekko-agent`), and create an **API token** for it.
2. In Nekko Agent, open **Connectors**, find **Floop**, and enter your Floop server URL (for example `https://your-team.fly.dev`) and the token.
3. Your open Floop tasks appear in the Agent Monitor's **Tasks** section and can be pulled into a chat's context.

The server URL must use https (a Floop running on `localhost` is the exception).

## Let the agent update tasks

The connector only reads. To let Nekko Agent claim tasks, post progress and finish them, add Floop's MCP server:

1. Install the Floop CLI from the Floop repository (`npm install -g ./packages/cli`).
2. Save the agent's token as a profile: `floop login --profile nekko-agent --url https://your-team.fly.dev --token flp_…`
3. In Nekko Agent, open **Settings → MCP servers** and add a server with the command `floop` and the arguments `mcp --profile nekko-agent`.

The agent then gets tools to find its next task, start it, leave notes, finish it, or hand it to a person with a question. Every call goes through your normal approvals, and Floop records each change under the agent's name.
