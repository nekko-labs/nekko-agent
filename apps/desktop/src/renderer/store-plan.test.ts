import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  Object.assign(globalThis, { localStorage: storage, window: { innerWidth: 1280, addEventListener() {}, localStorage: storage } });
  return storage;
});
const { useStore } = await import('./store.js');

beforeEach(() => useStore.setState({ planRailOpen: true, planRailOpenBySession: {} }));

describe('per-agent plan visibility', () => {
  it('only toggles the correlated chat and retains other preferences', () => {
    useStore.getState().togglePlanRail('alpha');
    expect(useStore.getState().planRailOpenBySession).toEqual({ alpha: false });
    expect(useStore.getState().planRailOpen).toBe(true);
    useStore.getState().togglePlanRail('beta');
    useStore.getState().togglePlanRail('alpha');
    expect(useStore.getState().planRailOpenBySession).toEqual({ alpha: true, beta: false });
    expect(JSON.parse(storage.getItem('nekko.planRail.sessions')!)).toEqual({ alpha: true, beta: false });
  });
  it('uses the existing preference only as a default, not as a shared toggle', () => {
    useStore.setState({ planRailOpen: false });
    useStore.getState().togglePlanRail('alpha');
    expect(useStore.getState().planRailOpenBySession).toEqual({ alpha: true });
    expect(useStore.getState().planRailOpen).toBe(false);
  });
});
