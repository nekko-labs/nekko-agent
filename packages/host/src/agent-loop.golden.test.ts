import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, ChatMessage, ToolCall, ToolResult } from '@nekko-agent/shared';
import { runAgent } from '@nekko-agent/core';

/**
 * What the TS agent loop does on scripted model responses, which the engine
 * daemon's port (crates/nekko-loop/src/run.rs) must reproduce: the events in
 * order, the transcript it leaves, and every request it sends. Scenarios are
 * `golden/runs.json`; ids and timestamps are normalized (they come from the
 * clock and a counter). Rewrite with UPDATE_GOLDEN=1.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-loop', 'tests', 'golden');

type Step = { phase?: 'commentary' | 'final_answer'; text?: string; reasoning?: string; call?: ToolCall; usage?: number[]; done?: boolean; throw?: string };
interface Scenario {
  name: string;
  responses: Step[][];
  tools?: Record<string, { output?: string; isError?: boolean; throw?: string }>;
  history?: ChatMessage[];
  maxHistoryTurns?: number;
  contextWindow?: number;
  resume?: boolean;
  abortBefore?: boolean;
  abortAfter?: [number, number];
}

export function normalize(value: unknown): unknown {
  const text = JSON.stringify(value)
    .replace(/(msg|nudge)_[0-9a-z]+_\d+/g, '$1_ID')
    .replace(/msg_repair_\d+/g, 'msg_repair_N')
    .replace(/"createdAt":\d+/g, '"createdAt":0');
  return JSON.parse(text);
}

async function play(s: Scenario, defaults: { defaultHistory: ChatMessage[]; tools: never[] }) {
  const history: ChatMessage[] = structuredClone(s.history ?? defaults.defaultHistory);
  const requests: unknown[] = [];
  const controller = new AbortController();
  if (s.abortBefore) controller.abort();
  let call = 0;
  const provider = {
    config: {} as never,
    listModels: async () => [],
    test: async () => ({ ok: true, message: '' }),
    async *chat(req: { messages: ChatMessage[]; tools?: Array<{ name: string }>; system?: string; model: string; signal?: AbortSignal }) {
      const n = call++;
      requests.push({ model: req.model, system: req.system, tools: (req.tools ?? []).map((t) => t.name), messages: JSON.parse(JSON.stringify(req.messages)) });
      const script = s.responses[n] ?? [];
      for (let i = 0; i < script.length; i++) {
        if (req.signal?.aborted) throw new Error('This operation was aborted');
        const step = script[i];
        if (step.throw) throw new Error(step.throw);
        if (step.phase) yield { type: 'phase' as const, phase: step.phase };
        else if (step.text !== undefined) yield { type: 'text' as const, delta: step.text };
        else if (step.reasoning !== undefined) yield { type: 'reasoning' as const, delta: step.reasoning };
        else if (step.call) yield { type: 'tool_call' as const, call: step.call };
        else if (step.usage) yield { type: 'usage' as const, inputTokens: step.usage[0], outputTokens: step.usage[1], ...(step.usage[2] !== undefined ? { outputMs: step.usage[2] } : {}) };
        else if (step.done) yield { type: 'done' as const };
        if (s.abortAfter && s.abortAfter[0] === n && s.abortAfter[1] === i) controller.abort();
      }
      if (req.signal?.aborted) throw new Error('This operation was aborted');
    },
  };
  const events: AgentEvent[] = [];
  for await (const e of runAgent({
    sessionId: 's1',
    provider: provider as never,
    model: 'test-model',
    system: 'SYSTEM',
    history,
    tools: defaults.tools,
    executeTool: async (c: ToolCall): Promise<ToolResult> => {
      const t = s.tools?.[c.id];
      if (!t) throw new Error(`no script for ${c.id}`);
      if (t.throw) throw new Error(t.throw);
      return { toolCallId: c.id, output: t.output ?? '', ...(t.isError ? { isError: true } : {}) };
    },
    signal: controller.signal,
    // Backoffs are instant here; the Rust side runs on a paused clock.
    retryBaseDelayMs: 0,
    maxHistoryTurns: s.maxHistoryTurns,
    contextWindow: s.contextWindow,
    resume: s.resume,
  })) events.push(e);
  return normalize({ name: s.name, events, history, requests });
}

describe('agent loop golden set', () => {
  it('matches what the TS loop does on every scripted run', async () => {
    const runs = JSON.parse(readFileSync(join(golden, 'runs.json'), 'utf8'));
    const actual = [];
    for (const s of runs.scenarios as Scenario[]) actual.push(await play(s, runs));
    const path = join(golden, 'runs.expected.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify(actual, null, 1)}\n`);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(actual);
  });
});
