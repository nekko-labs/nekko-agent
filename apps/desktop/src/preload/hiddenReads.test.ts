import { describe, expect, it, vi } from 'vitest';
import { heldWhileHidden } from './hiddenReads.js';

describe('reads held while the page is hidden', () => {
  it('asks while visible, keeps the last answer while hidden, and asks again on return', async () => {
    let hidden = false;
    let n = 0;
    const read = vi.fn(async () => ++n);
    const status = heldWhileHidden(read, () => hidden);
    expect(await status()).toBe(1);
    expect(await status()).toBe(2);
    hidden = true;
    expect(await status()).toBe(2);
    expect(await status()).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
    hidden = false;
    expect(await status()).toBe(3);
  });

  it('asks when hidden with no answer yet, and a failure keeps the last good one', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('starting')).mockResolvedValueOnce('ok').mockRejectedValueOnce(new Error('gone'));
    let hidden = true;
    const status = heldWhileHidden(read, () => hidden);
    await expect(status()).rejects.toThrow('starting');
    expect(await status()).toBe('ok');
    hidden = false;
    await expect(status()).rejects.toThrow('gone');
    hidden = true;
    expect(await status()).toBe('ok');
  });
});
