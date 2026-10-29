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

## Internet reachability and automatic recovery

For native online model replies, the daemon checks reachability on the **computer running the agent**, not on a paired phone or browser. Timestamped loss/restoration notices appear in the chat's **Internet connectivity** history and, outside Incognito, its command log. Saved tool results are retained; notices are never sent to the model.

**Settings > Agent loop > Automatically resume after internet restoration** is **off by default**. With it off, confirmed loss interrupts the reply; select **Continue** after reconnecting. With it on, the same model request may continue after stable restoration for up to 30 minutes. **Additional provider usage may incur charges.** Completed tools are not replayed, and Stop ends the wait immediately. Turning it on after a reply already ended does not restart that reply. Existing retries for provider-specific failures are unchanged.

While native public-model work is active, or an interrupted reply awaits a restoration notice (at most 30 minutes), Nekko requests two public HTTPS 204 endpoints: `www.gstatic.com/generate_204` and `cp.cloudflare.com/generate_204`. No prompt, account token, cookie or session identifier is sent, but these services see your source IP. Requests are bounded, debounced, recorded under **Model providers**, and stop when that connection or **All connections off** is disabled. Local/LAN inference does not trigger these probes. Blocking both destinations or a captive portal can look unreachable, even if other sites work.

Recovery does not start a new agent, change providers, restart an entire workflow or survive a daemon restart. Claude Code's separate child-harness transport, images/voice and internet calls made by tools are outside this native model-call recovery. Physical network and packaged-device verification remain tracked in [NR-3](https://github.com/nekko-labs/nekko-agent/issues/1179).

## The activity log

Each row says when the connection was last used, how many times in the last 24 hours, and how many of those failed or were blocked. **Show log** lists the recent events: the time, method, host and path, the status, how long it took and how much came back.

The log never contains what was sent: no bodies, headers, tokens or query strings, and path parts that look like keys are hidden. It is kept in `logs/connections.log` in your data folder and never grows past about 6 MB. **Clear connection logs** empties it.

## What it does not cover

Commands you or an agent run in a terminal, such as `curl` or `npm install`, use your computer's network directly. To keep an agent's commands off the network as well, use the Docker sandbox, or turn the computer's network off.
