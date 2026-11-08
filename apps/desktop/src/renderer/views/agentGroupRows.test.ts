import { describe, expect, it } from 'vitest';
import { AGENT_GROUP_LIMIT, agentGroupRows } from './agentGroupRows.js';

describe('agentGroupRows', () => {
  it.each([0, 1, 19, 20, 21, 65, 1000])('mounts at most 20 of %i rows by default', (length) => {
    const rows = Array.from({ length }, (_, i) => i);
    expect(AGENT_GROUP_LIMIT).toBe(20);
    expect(agentGroupRows(rows, false)).toEqual(rows.slice(0, 20));
  });
  it('expands the full list, not another page', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => i);
    expect(agentGroupRows(rows, true)).toBe(rows);
    expect(agentGroupRows(rows, false)).toHaveLength(20);
  });
  it('keeps a selected hidden row in the last slot, without changing the input', () => {
    const rows = Array.from({ length: 65 }, (_, i) => ({ id: i }));
    expect(agentGroupRows(rows, false, 64)).toEqual([...rows.slice(0, 19), rows[64]]);
    expect(rows).toHaveLength(65);
    expect(agentGroupRows(rows, true, 64)).toBe(rows);
  });
  it.each([-1, 0, 19, 65])('keeps the normal page for selection index %i', (index) => {
    const rows = Array.from({ length: 65 }, (_, i) => i);
    expect(agentGroupRows(rows, false, index)).toEqual(rows.slice(0, 20));
  });
});
