import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentWatchService, type WatchDependencies } from './agent-watches.js';

describe('durable agent watches', () => {
  let dir: string;
  let now: number;
  let deps: WatchDependencies;
  let service: AgentWatchService;
  const pr = { action: 'create', kind: 'pr', url: 'https://github.com/owner/repo/pull/1', prompt: 'Check CI and continue', timeout_seconds: 600 };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nekko-watch-'));
    now = 1000000;
    deps = { busy: vi.fn(() => false), exists: vi.fn(() => true), snapshot: vi.fn(async () => 'pending'), resume: vi.fn(async () => {}) };
    service = new AgentWatchService(() => join(dir, 'watches.json'), deps, () => now);
  });
  afterEach(() => { service.stop(); rmSync(dir, { recursive: true, force: true }); });
  it('recovers overdue timer watches after restart and delivers once', async () => {
    await service.tool('s', { action: 'create', kind: 'timer', prompt: 'Continue', delay_seconds: 60 });
    service = new AgentWatchService(() => join(dir, 'watches.json'), deps, () => now);
    now += 61000;
    await service.tick();
    await service.tick();
    expect(deps.resume).toHaveBeenCalledTimes(1);
    expect(service.list()[0].status).toBe('done');
  });
  it('reports only active deadlines from disk across restart, cancellation and wake', async () => {
    expect(service.nextWakeAt('s')).toBeNull();
    await service.tool('s', { action: 'create', kind: 'timer', prompt: 'Later', delay_seconds: 600 });
    await service.tool('s', { action: 'create', kind: 'timer', prompt: 'Soon', delay_seconds: 60 });
    await service.tool('other', { action: 'create', kind: 'timer', prompt: 'Elsewhere', delay_seconds: 60 });
    const soon = service.list('s').find((w) => w.prompt === 'Soon')!;
    service = new AgentWatchService(() => join(dir, 'watches.json'), deps, () => now);
    expect(service.nextWakeAt('s')).toBe(now + 60000);
    await service.tool('s', { action: 'cancel', id: soon.id });
    expect(service.nextWakeAt('s')).toBe(now + 600000);
    now += 601000;
    await service.tick();
    expect(service.nextWakeAt('s')).toBeNull();
    expect(service.nextWakeAt('other')).toBeNull();
  });
  it('defers busy chats and wakes only on a changed PR snapshot', async () => {
    await service.tool('s', pr);
    now += 61000;
    await service.tick();
    expect(deps.resume).not.toHaveBeenCalled();
    vi.mocked(deps.snapshot).mockResolvedValue('passed');
    vi.mocked(deps.busy).mockReturnValue(true);
    now += 61000;
    await service.tick();
    expect(deps.resume).not.toHaveBeenCalled();
    vi.mocked(deps.busy).mockReturnValue(false);
    await service.tick();
    expect(deps.resume).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.resume).mock.calls[0][1]).toContain('PR state changed');
  });
  it('does not register on baseline errors or wake on polling errors', async () => {
    vi.mocked(deps.snapshot).mockRejectedValue(new Error('401'));
    await expect(service.tool('s', pr)).rejects.toThrow('401');
    expect(service.list()).toEqual([]);
    vi.mocked(deps.snapshot).mockResolvedValue('pending');
    await service.tool('s', pr);
    vi.mocked(deps.snapshot).mockRejectedValue(new Error('401'));
    now += 61000;
    await service.tick();
    expect(deps.resume).not.toHaveBeenCalled();
    expect(service.list()[0].lastError).toContain('401');
    now += 600000;
    await service.tick();
    expect(deps.resume).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.resume).mock.calls[0][1]).toContain('deadline reached');
  });
  it('deduplicates registrations and isolates cancellation to the owning chat', async () => {
    await service.tool('s', pr);
    await service.tool('s', pr);
    expect(service.list()).toHaveLength(1);
    const id = service.list()[0].id;
    await expect(service.tool('other', { action: 'cancel', id })).rejects.toThrow('belongs');
    await service.tool('s', { action: 'cancel', id });
    now += 700000;
    await service.tick();
    expect(deps.resume).not.toHaveBeenCalled();
  });
  it('cancels deleted or archived chats', async () => {
    await service.tool('s', pr);
    vi.mocked(deps.exists).mockReturnValue(false);
    now += 61000;
    await service.tick();
    expect(service.list()[0].status).toBe('cancelled');
  });
  it('retains pending delivery across a failed resume and restart', async () => {
    await service.tool('s', pr);
    vi.mocked(deps.snapshot).mockResolvedValue('passed');
    vi.mocked(deps.resume).mockRejectedValueOnce(new Error('provider offline'));
    now += 61000;
    await service.tick();
    expect(service.list()[0].pending).toContain('changed');
    service = new AgentWatchService(() => join(dir, 'watches.json'), deps, () => now);
    now += 130000;
    await service.tick();
    expect(deps.resume).toHaveBeenCalledTimes(2);
    expect(service.list()[0].status).toBe('done');
  });
  it('serializes overlapping ticks', async () => {
    await service.tool('s', { action: 'create', kind: 'timer', prompt: 'Continue', delay_seconds: 60 });
    now += 61000;
    let finish!: () => void;
    vi.mocked(deps.resume).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = service.tick();
    await service.tick();
    finish();
    await first;
    expect(deps.resume).toHaveBeenCalledTimes(1);
  });
  it('allows a continuation to re-arm the same watch instruction', async () => {
    await service.tool('s', pr);
    vi.mocked(deps.snapshot).mockResolvedValue('passed');
    vi.mocked(deps.resume).mockImplementation(async () => { await service.tool('s', pr); });
    now += 61000;
    await service.tick();
    expect(service.list().map((w) => w.status)).toEqual(['done', 'active']);
  });
  it('exposes watch views without continuation prompts', async () => {
    await service.tool('s', pr);
    await service.tool('other', { action: 'create', kind: 'timer', prompt: 'Elsewhere', delay_seconds: 60 });
    const views = service.views('s');
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ kind: 'pr', url: pr.url, status: 'active', deadlineAt: now + 600000, pending: false, failures: 0 });
    expect(JSON.stringify(views)).not.toContain('Check CI and continue');
  });
  it('refuses corrupt state instead of overwriting it', async () => {
    writeFileSync(join(dir, 'watches.json'), 'invalid');
    await expect(service.tick()).rejects.toThrow();
  });
});
