import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ exec: vi.fn(), token: '', session: null as any }));
vi.mock('child_process', () => ({ execFile: mock.exec }));
vi.mock('./store.js', () => ({ getSettings: () => ({ connectors: mock.token ? [{ kind: 'github', connected: true, token: mock.token }] : [] }) }));
vi.mock('./sessions.js', () => ({ getSession: () => mock.session }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mock.token = '';
  mock.session = null;
  vi.stubGlobal('fetch', vi.fn());
});
it('blocks ordinary merge when the authoritative PR belongs to a stack', async () => {
  mock.exec.mockImplementation((_bin, args, _opts, cb) => cb(null, JSON.stringify({ stack: { number: 3, size: 2 } }), ''));
  const { prAction } = await import('./pr.js');
  const result = await prAction('https://github.com/owner/repo/pull/12', 'merge');
  expect(result.ok).toBe(false);
  expect(result.message).toContain('all included layers');
  expect(mock.exec.mock.calls.every(call => call[1][0] === 'api')).toBe(true);
});
it('does not merge when native membership cannot be verified', async () => {
  mock.exec.mockImplementation((_bin, _args, _opts, cb) => cb({ code: 1 }, '', 'no access'));
  const { prAction } = await import('./pr.js');
  expect((await prAction('https://github.com/owner/repo/pull/12', 'merge')).ok).toBe(false);
  expect(mock.exec).toHaveBeenCalledTimes(1);
});
it('writes ordered PR numbers through gh without installing an extension', async () => {
  mock.exec.mockImplementation((_bin, _args, _opts, cb) => cb(null, '{"number":3}', ''));
  const { githubStackRequest } = await import('./pr.js');
  await githubStackRequest('repos/owner/repo/stacks', [12, 13]);
  expect(mock.exec.mock.calls[0][1]).toEqual(['api', 'repos/owner/repo/stacks', '--method', 'POST', '-H', 'X-GitHub-Api-Version: 2026-03-10', '-F', 'pull_requests[]=12', '-F', 'pull_requests[]=13']);
});
it('falls back to connector auth with a bounded REST request when gh is missing', async () => {
  mock.token = 'synthetic-test-token';
  mock.exec.mockImplementation((_bin, _args, _opts, cb) => cb({ code: 'ENOENT' }, '', ''));
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ number: 3 }) } as Response);
  const { githubStackRequest } = await import('./pr.js');
  await githubStackRequest('repos/owner/repo/stacks', [12, 13]);
  expect(fetch).toHaveBeenCalledWith('https://api.github.com/repos/owner/repo/stacks', expect.objectContaining({ method: 'POST', body: '{"pull_requests":[12,13]}', signal: expect.any(AbortSignal), headers: expect.objectContaining({ Authorization: 'Bearer synthetic-test-token' }) }));
});
it('does not repeat a possibly completed mutation after a gh error', async () => {
  mock.token = 'synthetic-test-token';
  mock.exec.mockImplementation((_bin, _args, _opts, cb) => cb({ code: 1 }, '', 'timeout'));
  const { githubStackRequest } = await import('./pr.js');
  await expect(githubStackRequest('repos/owner/repo/stacks', [12, 13])).rejects.toThrow('timeout');
  expect(fetch).not.toHaveBeenCalled();
});
it('refreshes host fallback membership after linking and preserves it for subsequent polling', async () => {
  let linked = false;
  mock.session = { messages: [
    { role: 'assistant', toolCalls: [{ id: 'create', name: 'bash', input: { command: 'gh pr create --title feature --body feature' } }] },
    { role: 'tool', toolResult: { toolCallId: 'create', output: 'https://github.com/owner/repo/pull/12', isError: false } },
  ] };
  mock.exec.mockImplementation((_bin, args, _opts, cb) => cb(null, JSON.stringify(args[0] === 'pr' ? { state: 'OPEN', title: 'Feature' } : { stack: linked ? { number: 3, size: 2 } : null }), ''));
  const { listSessionPrs } = await import('./pr.js');
  expect((await listSessionPrs('test'))[0].stack).toBeUndefined();
  const initialReads = mock.exec.mock.calls.length;
  linked = true;
  expect((await listSessionPrs('test'))[0].stack).toBeUndefined();
  expect(mock.exec).toHaveBeenCalledTimes(initialReads);
  expect((await listSessionPrs('test', true))[0].stack).toEqual({ number: 3, size: 2 });
  const refreshedReads = mock.exec.mock.calls.length;
  expect(refreshedReads).toBeGreaterThan(initialReads);
  expect((await listSessionPrs('test'))[0].stack).toEqual({ number: 3, size: 2 });
  expect(mock.exec).toHaveBeenCalledTimes(refreshedReads);
});
