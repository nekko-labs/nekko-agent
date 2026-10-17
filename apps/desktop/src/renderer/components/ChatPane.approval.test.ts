import { expect, it } from 'vitest';
import { approvalAfterResult } from './ChatPane.approval.js';

const approval = { call: { id: 'waiting', name: 'bash', input: { command: 'cleanup' } }, reason: 'Needs permission' };
it('keeps a waiting approval when unrelated work returns', () => {
  expect(approvalAfterResult(approval, 'parallel-read')).toBe(approval);
});
it('clears only the matching approval and accepts no pending request', () => {
  expect(approvalAfterResult(approval, 'waiting')).toBeNull();
  expect(approvalAfterResult(null, 'waiting')).toBeNull();
});
