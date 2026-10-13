import { describe, expect, it, vi } from 'vitest';

const calls: unknown[][] = [];
vi.mock('./engine/daemon.js', () => ({
  daemonOwns: (what: string) => what === 'agent-watches',
  daemonCall: () => async (channel: string, ...args: unknown[]) => {
    calls.push([channel, ...args]);
    return (args[1] as { action?: string }).action === 'list' ? '[]' : { error: 'A valid GitHub PR URL is required' };
  },
}));
import { agentWatchTool, configureAgentWatches, watchResume, watchSnapshot } from './agent-watches.js';

describe('agent watches under a daemon that owns them', () => {
  it('sends tool calls to the daemon and leaves the scheduler to it', async () => {
    const resume = vi.fn(async () => {});
    const service = configureAgentWatches({ busy: () => false, exists: () => true, snapshot: async () => 'snap', resume });
    const start = vi.spyOn(service, 'start');
    expect(start).not.toHaveBeenCalled();
    await expect(agentWatchTool('s', { action: 'list' })).resolves.toBe('[]');
    await expect(agentWatchTool('s', { action: 'create', kind: 'pr' })).rejects.toThrow('A valid GitHub PR URL is required');
    expect(calls[0]).toEqual(['watch:tool', 's', { action: 'list' }]);
    service.stop();
  });

  it('answers the daemon scheduler callbacks', async () => {
    const resume = vi.fn(async (_id: string, text: string) => { if (text === 'fail') throw new Error('provider offline'); });
    configureAgentWatches({ busy: () => false, exists: () => true, snapshot: async (url) => `snap:${url}`, resume }).stop();
    await expect(watchSnapshot('u')).resolves.toBe('snap:u');
    await expect(watchResume('s', 'go')).resolves.toEqual({});
    await expect(watchResume('s', 'fail')).resolves.toEqual({ error: 'provider offline' });
    expect(resume).toHaveBeenCalledWith('s', 'go');
  });
});
