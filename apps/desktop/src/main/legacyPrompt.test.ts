import { describe, expect, it, vi } from 'vitest';
import type { ConsolidateReport, LegacyEnv, LegacyItem } from '@nekko-agent/host/legacy-profiles';
import { describeOffer, offerLegacyCleanup, type LegacyChoice } from './legacyPrompt.js';

const env = { target: '/home/u/.nekko-agent' } as LegacyEnv;
const item: LegacyItem = { id: 'data:/home/u/.agent-nekko', kind: 'data', path: '/home/u/.agent-nekko', label: '.agent-nekko', dataRoots: ['/home/u/.agent-nekko'] };
const report: ConsolidateReport = { backupDir: '/b', roots: [{ source: item.path, sessions: 3, usageRecords: 10, files: [], moved: [], conflicts: [] }] };

function run(choice: LegacyChoice, over: Partial<Parameters<typeof offerLegacyCleanup>[0]> = {}) {
  const tell = vi.fn(); const merge = vi.fn(() => report); const clean = vi.fn(() => ({ removed: [item.path], kept: [], failed: [] }));
  const ask = vi.fn(() => choice);
  const merged = offerLegacyCleanup({ ask, tell, env, detect: () => [item], describe: () => ({ sessions: 3, bytes: 5 << 20 }), merge, clean, ...over });
  return { merged, tell, merge, clean, ask };
}

describe('offerLegacyCleanup', () => {
  it('stays silent when there is nothing to migrate', () => {
    const r = run('merge-clean', { detect: () => [] });
    expect(r.ask).not.toHaveBeenCalled();
    expect(r.merged).toBe(false);
  });

  it('asks again on every launch: "Not now" changes nothing and remembers nothing', () => {
    const first = run('later'); const second = run('later');
    expect(first.merge).not.toHaveBeenCalled();
    expect(first.clean).not.toHaveBeenCalled();
    expect(first.ask).toHaveBeenCalledTimes(1);
    expect(second.ask).toHaveBeenCalledTimes(1);
  });

  it('merge and clean up merges first, then deletes, and reports both', () => {
    const r = run('merge-clean');
    expect(r.merge).toHaveBeenCalledBefore(r.clean);
    expect(r.merged).toBe(true);
    expect(r.tell.mock.calls[0][1]).toContain('Merged 3 chats and 10 usage records');
    expect(r.tell.mock.calls[0][1]).toContain('Removed 1 old folder.');
    expect(r.tell.mock.calls[0][2]).toBe(false);
  });

  it('merge, keep old copies never deletes', () => {
    const r = run('merge-keep');
    expect(r.merge).toHaveBeenCalled();
    expect(r.clean).not.toHaveBeenCalled();
  });

  it('a failed merge deletes nothing and says so', () => {
    const r = run('merge-clean', { merge: () => { throw new Error('Nekko Agent is still running (process 9).'); } });
    expect(r.clean).not.toHaveBeenCalled();
    expect(r.merged).toBe(false);
    expect(r.tell.mock.calls[0][1]).toContain('still running');
    expect(r.tell.mock.calls[0][1]).toContain('Nothing that was merged has been deleted');
    expect(r.tell.mock.calls[0][2]).toBe(true);
  });

  it('flags a folder that cleanup had to keep', () => {
    const r = run('merge-clean', { clean: () => ({ removed: [], kept: [{ path: item.path, reason: '1 item(s) not yet merged' }], failed: [] }) });
    expect(r.tell.mock.calls[0][1]).toContain('Kept /home/u/.agent-nekko');
    expect(r.tell.mock.calls[0][2]).toBe(true);
  });

  it('never throws out of startup if detection itself fails', () => {
    expect(run('merge-clean', { detect: () => { throw new Error('EACCES'); } }).merged).toBe(false);
  });
});

describe('describeOffer', () => {
  it('lists each location with its size and names the destination', () => {
    const { detail } = describeOffer([item], env.target, () => ({ sessions: 1, bytes: 2 * 1024 ** 3 }));
    expect(detail).toContain('/home/u/.agent-nekko (1 chat, 2.0 GB)');
    expect(detail).toContain('/home/u/.nekko-agent');
  });
});
