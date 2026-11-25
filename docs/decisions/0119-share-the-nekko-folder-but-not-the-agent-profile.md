# 0119. Share the Nekko folder, not the Agent profile

Status: accepted. Issue: [#3174](https://github.com/nekko-labs/nekko-agent/issues/3174).

Nekko products use `~/.nekko` as their common parent. Agent owns
`~/.nekko/nekko-agent` by default; an explicit `NEKKO_DATA_DIR` still wins.
Neither the source checkout nor borrowed model folders move. During an upgrade,
a confirmed, journaled move can take a previous Agent profile into the new
location. When the source is the flat shared parent, only known Agent entries
move; the parent itself is never a consolidation or cleanup candidate.

On the host, give agents (including delegated turns) access to the shared
folder without making it a workspace, working directory or scratch-delete root.
Keep normal permission checks and do not grant the host directory to containers.

**Alternatives not taken:** Keeping `~/.nekko-agent` as the canonical profile
would separate Agent from the other products. Giving agents access only to the
Agent profile would still require manually attaching the shared folder.
