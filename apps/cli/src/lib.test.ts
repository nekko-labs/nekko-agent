import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { approvalPolicy, runChat, type Client } from './lib.js';
import { CliError, EXIT_CODES, exitCodeForError, parseFlags, runCli } from './run.js';
import { normalizeInstallTarget } from '@nekko-agent/shared';

function fakeClient(events: any[] = [], mode: 'ask' | 'guardrails' | 'yolo' = 'ask') {
  let listener: ((event: any) => void) | undefined;
  const approvals: boolean[] = [];
  const modes: Array<string | undefined> = [];
  const client = {
    ready: async () => {},
    getSession: async () => ({ mode }),
    setSessionOptions: async (_id: string, patch: { mode?: string }) => { modes.push(patch.mode); },
    onAgentEvent: (cb: (event: any) => void) => {
      listener = cb;
      return () => { listener = undefined; };
    },
    sendChat: async () => {
      for (const event of events) queueMicrotask(() => listener?.(event));
    },
    approveTool: async (_session: string, _id: string, approved: boolean) => { approvals.push(approved); },
    abortChat: async () => {},
  } as unknown as Client;
  return { client, approvals, modes };
}

describe('CLI identity and compatibility', () => {
  it('publishes under nekko-agent with canonical and legacy executable aliases', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.name).toBe('nekko-agent');
    expect(manifest.repository.url).toBe('git+https://github.com/nekko-labs/nekko-agent.git');
    expect(manifest.bin).toEqual({
      'nekko-agent': 'dist/index.js',
    });
  });

  it.each([{ argv: [] }, { argv: ['--help'] }, { argv: ['help'] }])('leads help with Nekko Agent for $argv', async ({ argv }) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runCli(argv);
      const help = String(log.mock.calls[0][0]);
      expect(help).toMatch(/^Nekko Agent CLI \(nekko-agent /);
      expect(help).toContain('nekko-agent status|sessions|watch');
      expect(help).toContain('NEKKO_URL');
      expect(help).toContain('NEKKO_TOKEN');
      expect(help).toContain('NEKKO_DATA_DIR');
    } finally {
      log.mockRestore();
    }
  });

  it('keeps workflow as an alias of scheduled-task', async () => {
    await expect(runCli(['workflow', 'invalid', '--url', 'http://127.0.0.1:1'])).rejects.toMatchObject({
      message: expect.stringContaining('Usage: nekko-agent scheduled-task'),
      exitCode: EXIT_CODES.usage,
    });
  });

  it.each(['workspace', 'tasks', 'scheduled-task', 'train'])('uses canonical %s usage without changing exit codes', async (command) => {
    await expect(runCli([command, 'invalid', '--url', 'http://127.0.0.1:1'])).rejects.toMatchObject({
      message: expect.stringContaining(`Usage: nekko-agent ${command}`),
      exitCode: EXIT_CODES.usage,
    });
  });

  it('shows the canonical skill target in usage and normalizes unknown values', async () => {
    await expect(runCli(['skills', 'install', '--url', 'http://127.0.0.1:1'])).rejects.toMatchObject({
      message: 'Usage: nekko-agent skills install <id> [--target nekko-agent|claude|codex]',
      exitCode: EXIT_CODES.usage,
    });
    expect(normalizeInstallTarget('claude')).toBe('claude');
    expect(normalizeInstallTarget('bogus')).toBe('nekko-agent');
  });
});

describe('CLI policy and flag parsing', () => {
  it('parses flags without consuming positional prompts', () => {
    expect(parseFlags(['chat', 'hello world', '--approve', 'guardrails', '--json'])).toEqual({
      _: ['chat', 'hello world'],
      flags: { approve: 'guardrails', json: true },
    });
  });

  it('defaults approval to guardrails and validates explicit modes', () => {
    expect(approvalPolicy(undefined)).toBe('guardrails');
    expect(approvalPolicy('yolo')).toBe('yolo');
    expect(() => approvalPolicy('unsafe')).toThrow();
  });

  it('records blocked approvals and emits typed events without approving them', async () => {
    const events: any[] = [];
    const { client, approvals, modes } = fakeClient([
      { type: 'tool_call', sessionId: 's', call: { id: 'c', name: 'run', input: { command: 'rm -rf x' } } },
      { type: 'tool_approval_required', sessionId: 's', call: { id: 'c', name: 'run', input: { command: 'rm -rf x' } }, reason: 'destructive', severity: 'high' },
      { type: 'tool_result', sessionId: 's', result: { toolCallId: 'c', output: 'blocked', isError: true } },
      { type: 'text', sessionId: 's', delta: 'done' },
      { type: 'done', sessionId: 's', messageId: 'm' },
    ]);
    const result = await runChat(client, { sessionId: 's', providerId: 'p', modelId: 'm', text: 'x', onEvent: (event) => events.push(event) });
    expect(result.text).toBe('done');
    expect(result.blocked[0]).toMatchObject({ command: 'rm -rf x', severity: 'high', ruleLabels: ['destructive'] });
    expect(approvals).toEqual([false]);
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'blocked', 'tool_result', 'text', 'done']);
    expect(result.toolCalls[0]).toMatchObject({ name: 'run', ok: false, error: 'blocked' });
    expect(EXIT_CODES.blocked).toBe(4);
    expect(modes).toEqual(['guardrails', 'ask']);
  });

  it('approves tool calls in explicit yolo mode', async () => {
    const { client, approvals } = fakeClient([
      { type: 'tool_approval_required', sessionId: 's', call: { id: 'c', name: 'run', input: {} }, reason: 'ask', severity: 'low' },
      { type: 'done', sessionId: 's', messageId: 'm' },
    ]);
    await runChat(client, { sessionId: 's', providerId: 'p', modelId: 'm', text: 'x', approve: 'yolo' });
    expect(approvals).toEqual([true]);
  });

  it('rejects ask mode when stdin is not a TTY', async () => {
    const { client, modes } = fakeClient([
      { type: 'tool_approval_required', sessionId: 's', call: { id: 'c', name: 'run', input: {} }, reason: 'ask', severity: 'low' },
    ]);
    await expect(runChat(client, { sessionId: 's', providerId: 'p', modelId: 'm', text: 'x', approve: 'ask' }))
      .rejects.toThrow('requires an interactive TTY');
    expect(modes).toEqual(['ask', 'ask']);
  });

  it('maps timeout failures to the timeout exit code', () => {
    expect(exitCodeForError('Chat timed out after 2 seconds')).toBe(EXIT_CODES.timeout);
  });

  it('times out in seconds and restores the session mode', async () => {
    const { client, modes } = fakeClient([]);
    await expect(runChat(client, {
      sessionId: 's',
      providerId: 'p',
      modelId: 'm',
      text: 'x',
      timeoutMs: 10,
    })).rejects.toThrow('Chat timed out after 0.01 seconds');
    expect(modes).toEqual(['guardrails', 'ask']);
    expect(exitCodeForError('Chat timed out after 0.01 seconds')).toBe(EXIT_CODES.timeout);
  });

  it('returns usage exit code for an unknown command', async () => {
    await expect(runCli(['not-a-command'])).rejects.toEqual(expect.objectContaining({
      exitCode: EXIT_CODES.usage,
    }));
    expect(new CliError('bad', EXIT_CODES.usage).exitCode).toBe(2);
  });
});
