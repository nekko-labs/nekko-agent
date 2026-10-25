# Connections

**Settings > Connections** lists everything Nekko Agent connects to besides your own computer. Nekko Agent sends no usage or crash reports unless you turn them on ([Usage and crash reports](usage-reports.md)).

## All connections off

Turn on **All connections off** to make Nekko Agent fully offline:

- Nothing reaches or leaves your computer over the network.
- Every chat runs as Offline, so only local models on this computer answer, and web and MCP tools are not offered.
- The API server, the relay on this computer and Visible on this network stop. Model Server only listens on this computer.

Local models, and runtimes such as Ollama or LM Studio on this computer, keep working.

## One connection at a time

Each row has its own switch. Turning a row off blocks that connection everywhere, even to this computer. A feature still needs its own setup: turning on **App updates** here does not turn on update checks; it only lets them reach the network when Updates has them on.

## The activity log

Each row says when the connection was last used, how many times in the last 24 hours, and how many of those failed or were blocked. **Show log** lists the recent events: the time, method, host and path, the status, how long it took and how much came back.

The log never contains what was sent: no bodies, headers, tokens or query strings, and path parts that look like keys are hidden. It is kept in `logs/connections.log` in your data folder and never grows past about 6 MB. **Clear connection logs** empties it.

## What it does not cover

Commands you or an agent run in a terminal, such as `curl` or `npm install`, use your computer's network directly. To keep an agent's commands off the network as well, use the Docker sandbox, or turn the computer's network off.
