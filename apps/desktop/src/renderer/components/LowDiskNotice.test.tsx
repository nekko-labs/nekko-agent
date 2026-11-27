// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LowDiskNotice, noticeState } from './LowDiskNotice.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GB = 1e9;
const HOUR = 3_600_000;

describe('noticeState', () => {
  it('shows under 20 GB free and warns under 5 GB', () => {
    expect(noticeState(20 * GB, null, 0)).toBe('hidden');
    expect(noticeState(19.9 * GB, null, 0)).toBe('low');
    expect(noticeState(5 * GB, null, 0)).toBe('low');
    expect(noticeState(4.9 * GB, null, 0)).toBe('critical');
  });

  it('Not now hides it for a day or until another 5 GB goes, whichever comes first', () => {
    const dismissed = { at: 0, free: 14 * GB };
    expect(noticeState(11 * GB, dismissed, 1 * HOUR)).toBe('hidden');
    expect(noticeState(9 * GB, dismissed, 1 * HOUR)).toBe('low');
    expect(noticeState(14 * GB, dismissed, 25 * HOUR)).toBe('low');
  });

  it('never hides the warning under 5 GB', () => {
    expect(noticeState(4 * GB, { at: 0, free: 4.5 * GB }, 1 * HOUR)).toBe('critical');
  });
});

describe('LowDiskNotice', () => {
  let root: Root | undefined;
  afterEach(() => { act(() => root?.unmount()); root = undefined; localStorage.clear(); });

  async function mount(free: number) {
    (window as unknown as { nekko: unknown }).nekko = { getDiskSpace: vi.fn(async () => ({ total: 2e12, free })) };
    const host = document.createElement('div');
    root = createRoot(host);
    const open = vi.fn();
    await act(async () => { root!.render(<LowDiskNotice openStorage={open} />); });
    await act(async () => {});
    return { host, open };
  }

  it('says how much is free and opens Storage', async () => {
    const { host, open } = await mount(14 * GB);
    expect(host.textContent).toContain('Your disk is almost full: 14 GB free.');
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === "See what's using it")!.click(); });
    expect(open).toHaveBeenCalled();
  });

  it('goes away on Not now and remembers it', async () => {
    const { host } = await mount(14 * GB);
    await act(async () => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Not now')!.click(); });
    expect(host.textContent).toBe('');
    expect(JSON.parse(localStorage.getItem('nekko.lowDisk.dismissed')!).free).toBe(14 * GB);
  });

  it('shows nothing with room to spare', async () => {
    const { host } = await mount(200 * GB);
    expect(host.textContent).toBe('');
  });
});
