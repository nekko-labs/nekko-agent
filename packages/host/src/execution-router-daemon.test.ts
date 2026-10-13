import { describe, expect, it, vi } from 'vitest';

const calls: unknown[][] = [];
let release: (() => void) | undefined;
vi.mock('./engine/daemon.js', () => ({
  daemonOwns: (what: string) => what === 'sandbox',
  daemonCall: () => async (channel: string, ...args: unknown[]) => {
    calls.push([channel, ...args]);
    if (channel === 'sandbox:tool') {
      await new Promise<void>((resolve) => { release = resolve; setTimeout(resolve, 20); });
      return { toolCallId: (args[1] as { id: string }).id, output: 'from the daemon' };
    }
    return true;
  },
}));
import { executeSandboxTool } from './execution-router.js';

describe('sandbox tools under a daemon that owns the containers', () => {
  it('asks here, runs there, and sends a Stop there', async () => {
    const approve = vi.fn(async () => true);
    const ac = new AbortController();
    const call = { id: 'c1', name: 'bash', input: { command: 'ls' } };
    const pending = executeSandboxTool('s1', call, approve, ac.signal);
    await new Promise((r) => setTimeout(r, 1));
    ac.abort();
    release?.();
    await expect(pending).resolves.toEqual({ toolCallId: 'c1', output: 'from the daemon' });
    expect(approve).toHaveBeenCalledWith(call, 'Sandbox bash: access only the copied workspace', 'high');
    expect(calls[0]).toEqual(['sandbox:tool', 's1', call]);
    expect(calls).toContainEqual(['sandbox:abort', 's1']);
  });

  it('never reaches the daemon for a refused or unsupported call', async () => {
    calls.length = 0;
    const refused = await executeSandboxTool('s1', { id: 'c2', name: 'read_file', input: {} }, async () => false);
    expect(refused).toEqual({ toolCallId: 'c2', output: 'Sandbox action not approved', isError: true });
    const unsupported = await executeSandboxTool('s1', { id: 'c3', name: 'browser', input: {} }, async () => true);
    expect(unsupported.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
