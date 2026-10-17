import { describe, expect, it } from 'vitest';
import { canResumeChildFailure, MAX_CHILD_RESUMES } from './delegation-recovery.js';

describe('delegation recovery policy', () => {
  it('bounds checkpoint recovery after stream-level retries', () => {
    expect(MAX_CHILD_RESUMES).toBe(1);
    for (const message of ['The engine stopped driving this reply.', 'The engine could not be reached.', 'The model stopped sending after 300 s of silence.', 'anthropic 503: unavailable']) expect(canResumeChildFailure(message)).toBe(true);
  });
  it('never bypasses user stops, approvals, credentials or permanent failures', () => {
    for (const message of ['Stopped', 'fetch failed', 'ECONNRESET', 'terminated', 'Delegation cancelled', '401 unauthorized', '403 forbidden', '400 invalid request', 'Permission denied', 'approval required', 'model unavailable', 'unknown error']) expect(canResumeChildFailure(message)).toBe(false);
  });
});
