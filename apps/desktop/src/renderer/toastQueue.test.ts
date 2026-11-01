import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TOASTS, overflowToasts, TOAST_EXIT_MS, TOAST_MS } from './toastQueue.js';

vi.hoisted(() => {
  Object.assign(globalThis, { window: { innerWidth: 1280, addEventListener() {} }, localStorage: { getItem: () => null } });
});
const { useStore } = await import('./store.js');

const t = (id: string, kind: 'info' | 'error' | 'success' = 'info', leaving?: boolean) => ({ id, kind, leaving });

describe('overflowToasts', () => {
  it('keeps up to the cap', () => {
    expect(overflowToasts([t('a'), t('b'), t('c')])).toEqual([]);
  });

  it('drops the oldest past the cap', () => {
    expect(overflowToasts([t('a'), t('b'), t('c'), t('d'), t('e')])).toEqual(['a', 'b']);
  });

  it('drops older infos before an older error', () => {
    expect(overflowToasts([t('err', 'error'), t('b'), t('c'), t('d')])).toEqual(['b']);
  });

  it('never drops the newest, even an info among errors', () => {
    expect(overflowToasts([t('e1', 'error'), t('e2', 'error'), t('e3', 'error'), t('new')])).toEqual(['e1']);
  });

  it('does not count toasts already leaving', () => {
    expect(overflowToasts([t('a', 'info', true), t('b'), t('c'), t('d')])).toEqual([]);
  });
});

describe('store toasts', () => {
  beforeEach(() => { vi.useFakeTimers(); useStore.setState({ toasts: [] }); });
  afterEach(() => vi.useRealTimers());
  const live = () => useStore.getState().toasts.filter((x) => !x.leaving);

  it(`shows at most ${MAX_TOASTS} at once`, () => {
    const { pushToast } = useStore.getState();
    for (let i = 0; i < 6; i++) pushToast('info', `n${i}`);
    expect(live().map((x) => x.message)).toEqual(['n3', 'n4', 'n5']);
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(useStore.getState().toasts).toHaveLength(3);
  });

  it('times infos out but keeps errors until dismissed', () => {
    const { pushToast } = useStore.getState();
    pushToast('info', 'saved');
    pushToast('error', 'failed');
    vi.advanceTimersByTime(TOAST_MS + TOAST_EXIT_MS);
    expect(useStore.getState().toasts.map((x) => x.message)).toEqual(['failed']);
    vi.advanceTimersByTime(60_000);
    expect(useStore.getState().toasts).toHaveLength(1);
    useStore.getState().dismissToast(useStore.getState().toasts[0].id);
    expect(useStore.getState().toasts[0].leaving).toBe(true);
    vi.advanceTimersByTime(TOAST_EXIT_MS);
    expect(useStore.getState().toasts).toEqual([]);
  });

  it('gives toasts pushed in the same millisecond distinct ids', () => {
    const { pushToast } = useStore.getState();
    pushToast('info', 'a');
    pushToast('info', 'b');
    const [a, b] = useStore.getState().toasts;
    expect(a.id).not.toBe(b.id);
  });
});
