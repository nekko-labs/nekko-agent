import { describe, expect, it, vi } from 'vitest';
import { withStepUpRetry } from './stepUpRetry.js';

const required = (action: string) => new Error(`Step-up needed (step-up-required) [${action}]: Confirm with your security key or a code to do this.`);

describe('a guarded call refused step-up-required', () => {
  it('opens the sheet for its action class and runs again once confirmed', async () => {
    const run = vi.fn().mockRejectedValueOnce(required('remoteAccess')).mockResolvedValueOnce('on');
    const ask = vi.fn(async () => true);
    expect(await withStepUpRetry(run, () => ask)).toBe('on');
    expect(ask).toHaveBeenCalledWith('remoteAccess', 'Confirm with your security key or a code to do this.');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('leaves everything as it was when the sheet is cancelled', async () => {
    const run = vi.fn().mockRejectedValue(required('pairing'));
    await expect(withStepUpRetry(run, () => async () => false)).rejects.toThrow('step-up-required');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('passes other errors, other refusals and stepUpOff straight through', async () => {
    const ask = vi.fn(async () => true);
    await expect(withStepUpRetry(() => Promise.reject(new Error('relay down')), () => ask)).rejects.toThrow('relay down');
    await expect(withStepUpRetry(() => Promise.reject(new Error('Step-up needed (step-up-invalid) [pairing]: x')), () => ask)).rejects.toThrow();
    await expect(withStepUpRetry(() => Promise.reject(required('stepUpOff')), () => ask)).rejects.toThrow();
    await expect(withStepUpRetry(() => Promise.reject(required('pairing')), () => null)).rejects.toThrow();
    expect(ask).not.toHaveBeenCalled();
  });
});
