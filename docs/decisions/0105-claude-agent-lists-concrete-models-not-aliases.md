---
status: accepted
date: 2026-11-17
---

# 0105. Claude Agent lists concrete models, never the "latest in plan" aliases

Issue: [#2927](https://github.com/nekko-labs/nekko-agent/issues/2927). Spec: [models and providers](../../spec/models/models-providers.md).

## Context

The Claude Agent provider listed `opus`, `sonnet` and `haiku` as "Claude Opus (latest in plan)" and so on, above the concrete models. Claude Code resolves a bare alias to the plan's default, which lags the newest release, so the first row of the picker (and the phones' "Claude latest") ran an older Opus than the Opus 5.5 listed below it.

## Options considered

1. **Keep the aliases, fix the label.** Still runs an older model than the newest the account has.
2. **Drop the aliases; list the shared Anthropic catalog, newest first.** The picker says what runs.
3. **Drop them and resolve each at launch from Claude Code's own output.** Claude Code offers no list of what a plan can use.

## Decision

Option 2. `MODEL_ALIASES` is gone; the provider lists `CLAUDE_MODELS` only. A chat saved on `opus`, `sonnet` or `haiku` is sent to `claude --model` as the newest concrete model of that family (`resolve_alias`, applied in nekkod when the turn's launch is built), and the desktop picker shows it as that model. An account that cannot use the newest model gets Claude Code's own error and picks another; Nekko does not guess a fallback. Sub-agent routing still passes bare family names through `CLAUDE_CODE_SUBAGENT_MODEL`, which is a separate Claude Code setting.
