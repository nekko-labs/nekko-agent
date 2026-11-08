import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstStarCelebration, refreshSupportStar, useSupportStar } from './supportStar.js';

afterEach(() => { vi.unstubAllGlobals(); useSupportStar.setState({ status: null, busy: false, celebrating: false }); });

describe('GitHub support state', () => {
  it('thanks already-starred accounts without animating, including later repeated writes', () => {
    expect(firstStarCelebration({ state: 'starred', login: 'already-starred', newlyStarred: false })).toBe(false);
    expect(firstStarCelebration({ state: 'starred', login: 'already-starred', newlyStarred: true })).toBe(false);
  });
  it('celebrates a newly confirmed star once per account, case insensitively', () => {
    expect(firstStarCelebration({ state: 'starred', login: 'New-Supporter', newlyStarred: true })).toBe(true);
    expect(firstStarCelebration({ state: 'starred', login: 'new-supporter', newlyStarred: true })).toBe(false);
    expect(firstStarCelebration({ state: 'unavailable', newlyStarred: true })).toBe(false);
  });
  it('honours the local thank-you marker across reloads', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => '1', setItem });
    expect(firstStarCelebration({ state: 'starred', login: 'persisted', newlyStarred: true })).toBe(false);
    expect(setItem).toHaveBeenCalledWith('nekko.support-star.thanked.persisted', '1');
  });
  it('only reads on refresh and shares a single pending request', async () => {
    let finish!: (value: unknown) => void;
    const supportStarStatus = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const supportStar = vi.fn();
    vi.stubGlobal('window', { nekko: { supportStarStatus, supportStar } });
    const request = refreshSupportStar();
    expect(refreshSupportStar()).toBe(request);
    expect(useSupportStar.getState().busy).toBe(true);
    await Promise.resolve();
    finish({ state: 'not-starred', login: 'reader' }); await request;
    expect(supportStarStatus).toHaveBeenCalledTimes(1);
    expect(supportStar).not.toHaveBeenCalled();
    expect(useSupportStar.getState().status?.state).toBe('not-starred');
  });
  it('writes only when explicitly requested and does not invent success on failure', async () => {
    const supportStar = vi.fn().mockRejectedValue(new Error('secret-bearing backend failure'));
    vi.stubGlobal('window', { nekko: { supportStar } });
    await refreshSupportStar(true);
    expect(supportStar).toHaveBeenCalledOnce();
    expect(useSupportStar.getState().status?.state).toBe('unavailable');
    expect(JSON.stringify(useSupportStar.getState())).not.toContain('secret-bearing');
    expect(useSupportStar.getState().celebrating).toBe(false);
  });
  it('clears stale confirmed status when refresh cannot verify it', async () => {
    useSupportStar.setState({ status: { state: 'starred', login: 'old-account' } });
    vi.stubGlobal('window', { nekko: { supportStarStatus: async () => ({ state: 'unavailable', reason: 'Reconnect GitHub.' }) } });
    await refreshSupportStar();
    expect(useSupportStar.getState().status).toEqual({ state: 'unavailable', reason: 'Reconnect GitHub.' });
  });
});
